import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudError,
  FakeCloudAdapter,
  distributionConfig,
  encryptedCache,
  groupIndex,
  hashPlan,
  makePlan,
  preparePrivateDirectory,
  privateEnvironment,
  provisionStep,
  sanitizedAwsError,
  validateOrigin,
  type CloudCheckpoint,
  type CloudResource,
} from "./hubCloudWorker.js";
const account = {
  id: "account-fixture",
  expectedAccountId: "111111111111",
  region: "us-east-1",
};
const resource = (i: number): CloudResource => ({
  key: `front-${i}`,
  role: "frontend",
  logicalId: `logical-${i}`,
  originHost: "vps-1.example.com",
});
describe("Hub CloudFront immutable operations", () => {
  for (const count of [1, 100, 101, 250])
    it(`configures and resumes ${count} endpoints without duplicates`, async () => {
      const plan = makePlan(
        account,
        Array.from({ length: count }, (_, i) => resource(i)),
      );
      const adapter = new FakeCloudAdapter();
      let checkpoint: CloudCheckpoint = {};
      const save = async (c: CloudCheckpoint) => {
        checkpoint = c;
      };
      expect(
        await provisionStep("job-fixture", plan, checkpoint, adapter, save),
      ).toBe("ready_for_activation");
      expect(adapter.resources.size).toBe(count);
      expect(adapter.functions.size).toBe(Math.ceil(count / 100));
      expect(
        await provisionStep("job-fixture", plan, checkpoint, adapter, save),
      ).toBe("ready_for_activation");
      expect(adapter.calls.filter((c) => c === "create").length).toBe(count);
      expect(adapter.resources.size).toBe(count);
    });
  it("rejects wrong account before creating anything", async () => {
    const adapter = new FakeCloudAdapter("222222222222");
    await expect(
      provisionStep(
        "j",
        makePlan(account, [resource(1)]),
        {},
        adapter,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "AWS_ACCOUNT_MISMATCH" });
    expect(adapter.resources.size).toBe(0);
  });
  it("rejects quota shortage before creating anything", async () => {
    const adapter = new FakeCloudAdapter(account.expectedAccountId, 1);
    await expect(
      provisionStep(
        "j",
        makePlan(account, [resource(1), resource(2)]),
        {},
        adapter,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "AWS_DISTRIBUTION_QUOTA" });
    expect(adapter.resources.size).toBe(0);
  });
  for (const code of ["AWS_THROTTLED", "AWS_TIMEOUT", "SIGN_IN_REQUIRED"])
    it(`retains checkpoints after ${code}`, async () => {
      const adapter = new FakeCloudAdapter();
      const plan = makePlan(account, [resource(1), resource(2)]);
      let checkpoint: CloudCheckpoint = {};
      let failed = false;
      const save = async (next: CloudCheckpoint) => {
        checkpoint = next;
        if (!failed && Object.keys(next.resources ?? {}).length === 1) {
          failed = true;
          adapter.faults.push({ operation: "create", code });
        }
      };
      await expect(
        provisionStep("job", plan, {}, adapter, save),
      ).rejects.toMatchObject({ code });
      expect(adapter.resources.size).toBe(1);
      await provisionStep("job", plan, checkpoint, adapter, async (c) => {
        checkpoint = c;
      });
      expect(adapter.resources.size).toBe(2);
    });
  it("reconciles create success followed by lost checkpoint acknowledgement", async () => {
    const adapter = new FakeCloudAdapter();
    const plan = makePlan(account, [resource(1)]);
    let checkpoint: CloudCheckpoint = {};
    await expect(
      provisionStep("job", plan, checkpoint, adapter, async (c) => {
        if (Object.keys(c.resources ?? {}).length)
          throw new CloudError("DB_DISCONNECTED");
        checkpoint = c;
      }),
    ).rejects.toMatchObject({ code: "DB_DISCONNECTED" });
    expect(adapter.resources.size).toBe(1);
    await provisionStep("job", plan, checkpoint, adapter, async (c) => {
      checkpoint = c;
    });
    expect(adapter.calls.filter((x) => x === "create")).toHaveLength(1);
  });
  it("holds in waiting when a resource is not deployed", async () => {
    const adapter = new FakeCloudAdapter();
    const plan = makePlan(account, [resource(1)]);
    const d = await adapter.create("j", plan.resources[0]!, "fn");
    adapter.resources.set(d.id, { ...d, status: "InProgress" });
    expect(await provisionStep("j", plan, {}, adapter, async () => {})).toBe(
      "waiting",
    );
  });
  it("never imports unrelated distribution into job checkpoints", async () => {
    const adapter = new FakeCloudAdapter();
    await adapter.create("unrelated", resource(99), "fn");
    let checkpoint: CloudCheckpoint = {};
    await provisionStep(
      "owned",
      makePlan(account, [resource(1)]),
      {},
      adapter,
      async (c) => {
        checkpoint = c;
      },
    );
    expect(adapter.resources.size).toBe(2);
    expect(
      Object.values(checkpoint.resources ?? {}).map((d) => d.caller),
    ).toEqual(["atlas-hub-owned-front-1"]);
  });
  it("one replacement retains logical identity and leaves its peers untouched", async () => {
    const selected = {
      ...resource(3),
      previous: {
        id: "old3",
        revision: 4,
        distributionId: "OLD3",
        accountId: "old-account",
        url: "https://dold3.cloudfront.net",
      },
    };
    const plan = makePlan(account, [selected]);
    expect(plan.resources).toHaveLength(1);
    expect(plan.resources[0]?.logicalId).toBe("logical-3");
    expect(plan.resources[0]?.previous?.revision).toBe(4);
  });
  it("hashes exact immutable plan and groups at boundaries", () => {
    const plan = makePlan(
      account,
      [resource(1)],
      new Date("2026-10-20T00:00:00Z"),
    );
    expect(hashPlan(plan)).toBe(hashPlan(structuredClone(plan)));
    expect(hashPlan({ ...plan, resources: [resource(2)] })).not.toBe(
      hashPlan(plan),
    );
    expect([99, 100, 199, 200].map(groupIndex)).toEqual([0, 1, 1, 2]);
  });
  it("rejects duplicate logical endpoints, counts over 5000 and invalid public origins", () => {
    expect(() => makePlan(account, [resource(1), resource(1)])).toThrow();
    expect(() =>
      makePlan(
        account,
        Array.from({ length: 5001 }, (_, i) => resource(i)),
      ),
    ).toThrow();
    for (const origin of [
      "127.0.0.1",
      "https://server.com",
      "evil.com/path",
      "localhost",
      "node.local",
      "a.test",
      "a\nb.com",
    ])
      expect(() => validateOrigin(origin)).toThrow();
  });
  it("configuration forwards viewer headers, cookies, all methods and disables caching", () => {
    const payload = distributionConfig(
      "j",
      resource(1),
      "arn:aws:cloudfront::111111111111:function/x",
      "SECRET",
    );
    const config = payload.DistributionConfig;
    expect(config.CallerReference).toBe("atlas-hub-j-front-1");
    expect(config.DefaultCacheBehavior.AllowedMethods.Quantity).toBe(7);
    expect(config.DefaultCacheBehavior.CachePolicyId).toBe(
      "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    );
    expect(config.DefaultCacheBehavior.OriginRequestPolicyId).toBe(
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
    expect(config.Enabled).toBe(true);
    expect(config.Origins.Items[0]?.CustomHeaders.Quantity).toBe(1);
  });
  it("sanitizes AWS failures instead of relaying credential-bearing stderr", () => {
    expect(
      sanitizedAwsError("An error occurred (ExpiredToken) secret-token-123")
        .code,
    ).toBe("SIGN_IN_REQUIRED");
    expect(
      sanitizedAwsError("An error occurred (ThrottlingException) sensitive")
        .code,
    ).toBe("AWS_THROTTLED");
    expect(
      sanitizedAwsError("An error occurred (PreconditionFailed)").code,
    ).toBe("AWS_REVISION_CONFLICT");
    expect(sanitizedAwsError("authorization secret cookie token").message).toBe(
      "AWS_REQUEST_FAILED",
    );
  });
  it("never inherits ambient AWS credentials or configuration", () => {
    process.env.AWS_ACCESS_KEY_ID = "sensitive";
    process.env.AWS_PROFILE = "default";
    const env = privateEnvironment("/private/cache");
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.HOME).toBe("/private/cache");
    expect(env.AWS_LOGIN_CACHE_DIRECTORY).toBe("/private/cache/login-cache");
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE;
  });
  it("encrypts login caches and reconstructs only managed files with restrictive modes", async () => {
    const secret = "test-encryption-secret";
    const dir = await preparePrivateDirectory(account, secret);
    let restored: string | undefined;
    try {
      await writeFile(
        join(dir, "login-cache", "token.json"),
        "sensitive-refresh-token",
        { mode: 0o600 },
      );
      const sealed = await encryptedCache(dir, secret);
      expect(sealed).not.toContain("sensitive");
      restored = await preparePrivateDirectory(
        { ...account, encryptedCache: sealed },
        secret,
      );
      expect(
        await readFile(join(restored, "login-cache", "token.json"), "utf8"),
      ).toBe("sensitive-refresh-token");
      expect((await stat(restored)).mode & 0o777).toBe(0o700);
      expect((await stat(join(restored, "config"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (restored) await rm(restored, { recursive: true, force: true });
    }
  });
});
