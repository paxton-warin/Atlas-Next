/** Fixed-argument AWS adapter and resumable CloudFront operation state machine.
 * No commands execute from HTTP handlers. Run the separate worker explicitly.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { encrypt, decrypt } from "./security.js";
import {
  activateSimulation,
  type SimulationCoordinator,
} from "./hubCloudSimulation.js";

export type CloudRole = "hub" | "frontend" | "node";
export type CloudAccount = {
  id: string;
  expectedAccountId: string;
  region: string;
  encryptedCache?: string | null;
};
export type CloudResource = {
  key: string;
  role: CloudRole;
  logicalId: string;
  originHost: string;
  previous?: {
    id: string;
    revision: number;
    distributionId: string;
    accountId: string;
    url: string;
  };
};
export type CloudPlan = {
  version: 1;
  accountId: string;
  accountIdentity: string;
  resources: CloudResource[];
  functionGroups: number;
  createdAt: string;
};
export type Distribution = {
  id: string;
  domain: string;
  status: string;
  caller: string;
  originHost?: string;
};
export type CloudCheckpoint = {
  resources?: Record<string, Distribution>;
  functions?: Record<string, string>;
  inventoryChecked?: boolean;
  probes?: Record<string, boolean>;
};
export class CloudError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const hashPlan = (plan: CloudPlan) =>
  createHash("sha256").update(canonical(plan)).digest("hex");
export const groupIndex = (index: number) => Math.floor(index / 100);
export function validateOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(
      value,
    ) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(value)
  )
    throw new CloudError("INVALID_ORIGIN");
  return value.toLowerCase();
}
export function makePlan(
  account: CloudAccount,
  resources: CloudResource[],
  now = new Date(),
): CloudPlan {
  if (
    !/^[0-9]{12}$/.test(account.expectedAccountId) ||
    !resources.length ||
    resources.length > 5000
  )
    throw new CloudError("INVALID_PLAN");
  const ids = new Set<string>();
  for (const resource of resources) {
    validateOrigin(resource.originHost);
    if (
      !["hub", "frontend", "node"].includes(resource.role) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(resource.key) ||
      !resource.logicalId ||
      ids.has(`${resource.role}:${resource.logicalId}`)
    )
      throw new CloudError("INVALID_PLAN");
    ids.add(`${resource.role}:${resource.logicalId}`);
  }
  return {
    version: 1,
    accountId: account.id,
    accountIdentity: account.expectedAccountId,
    resources,
    functionGroups: Math.ceil(resources.length / 100),
    createdAt: now.toISOString(),
  };
}
const viewerCode = `function handler(event) { var r=event.request; r.headers['x-atlas-viewer-host']={value:r.headers.host.value}; r.headers['x-atlas-viewer-ip']={value:event.viewer.ip}; r.headers['x-atlas-viewer-proto']={value:'https'}; return r; }`;
export function distributionConfig(
  jobId: string,
  resource: CloudResource,
  functionArn: string,
  originKey: string | Readonly<Record<string, string>>,
) {
  const selectedKey = typeof originKey === "string" ? originKey :
    Object.hasOwn(originKey, resource.originHost) ? originKey[resource.originHost] : "";
  // A dedicated Hub origin normally needs no routing key. An explicitly
  // mapped Hub host can require one (e.g. the isolated rehearsal gateway).
  const withOriginKey = resource.role !== "hub" ||
    (typeof originKey !== "string" && Object.hasOwn(originKey, resource.originHost));
  if (withOriginKey && (!selectedKey || /[\r\n]/.test(selectedKey)))
    throw new CloudError("ORIGIN_KEY_REQUIRED");
  return {
    DistributionConfig: {
      CallerReference: `atlas-hub-${jobId}-${resource.key}`,
      Comment: `atlas-hub:${jobId}:${resource.key}`,
      Aliases: { Quantity: 0 },
      DefaultRootObject: "",
      Origins: {
        Quantity: 1,
        Items: [
          {
            Id: "atlas",
            DomainName: resource.originHost,
            OriginPath: "",
            CustomHeaders: {
              Quantity: withOriginKey ? 1 : 0,
              ...(!withOriginKey
                ? {}
                : {
                    Items: [
                      {
                        HeaderName: "X-Atlas-Origin-Key",
                        HeaderValue: selectedKey!,
                      },
                    ],
                  }),
            },
            CustomOriginConfig: {
              HTTPPort: 80,
              HTTPSPort: 443,
              OriginProtocolPolicy: "https-only",
              OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
              OriginReadTimeout: 60,
              OriginKeepaliveTimeout: 5,
            },
          },
        ],
      },
      DefaultCacheBehavior: {
        TargetOriginId: "atlas",
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {
          Quantity: 7,
          Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        TrustedSigners: { Enabled: false, Quantity: 0 },
        TrustedKeyGroups: { Enabled: false, Quantity: 0 },
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        Compress: true,
        FunctionAssociations: {
          Quantity: 1,
          Items: [{ EventType: "viewer-request", FunctionARN: functionArn }],
        },
        LambdaFunctionAssociations: { Quantity: 0 },
      },
      CacheBehaviors: { Quantity: 0 },
      CustomErrorResponses: {
        Quantity: 10,
        Items: [400, 403, 404, 405, 414, 500, 501, 502, 503, 504].map(
          (ErrorCode) => ({ ErrorCode, ErrorCachingMinTTL: 0 }),
        ),
      },
      Logging: {
        Enabled: false,
        IncludeCookies: false,
        Bucket: "",
        Prefix: "",
      },
      PriceClass: "PriceClass_All",
      Enabled: true,
      HttpVersion: "http2",
      IsIPV6Enabled: true,
      ViewerCertificate: { CloudFrontDefaultCertificate: true },
      Restrictions: {
        GeoRestriction: { RestrictionType: "none", Quantity: 0 },
      },
      WebACLId: "",
    },
    Tags: {
      Items: [
        { Key: "Project", Value: "Atlas" },
        { Key: "AtlasJob", Value: jobId },
        { Key: "Role", Value: resource.role },
      ],
    },
  };
}
export interface CloudAdapter {
  readonly mode: "real" | "fake";
  identity(): Promise<string>;
  quota(): Promise<{ distributions: number; functionAssociations: number }>;
  inventory(): Promise<Distribution[]>;
  ensureFunction(name: string): Promise<string>;
  create(
    jobId: string,
    resource: CloudResource,
    functionArn: string,
  ): Promise<Distribution>;
  inspect(id: string): Promise<Distribution>;
}
const credentialCodes = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnauthorizedException",
  "TokenRetrievalError",
  "SSOTokenLoadError",
]);
export function sanitizedAwsError(stderr: string): CloudError {
  const code = stderr.match(
    /An error occurred \(([A-Za-z0-9_.-]{1,80})\)/,
  )?.[1];
  if (
    (code && credentialCodes.has(code)) ||
    /(?:token has expired|login session|credentials.*expired|Unable to locate credentials)/i.test(
      stderr,
    )
  )
    return new CloudError("SIGN_IN_REQUIRED");
  if (code && /Throttl|TooManyRequests|RequestLimit|SlowDown/.test(code))
    return new CloudError("AWS_THROTTLED", true);
  if (code && /PreconditionFailed|InvalidIfMatch/.test(code))
    return new CloudError("AWS_REVISION_CONFLICT");
  if (code && /DistributionAlreadyExists/.test(code))
    return new CloudError("AWS_RECONCILE_REQUIRED", true);
  if (code && /NoSuchCloudFrontFunction|NoSuchFunctionExists/.test(code))
    return new CloudError("AWS_FUNCTION_NOT_FOUND");
  return new CloudError(
    code &&
    /^(AccessDenied|TooManyDistributions|TooManyFunctions|InvalidArgument)$/.test(
      code,
    )
      ? code
      : "AWS_REQUEST_FAILED",
  );
}
export function privateEnvironment(dir: string): NodeJS.ProcessEnv {
  // Inherited AWS_* variables can override generated profiles; never inherit them.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    LANG: "en_US.UTF-8",
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    AWS_LOGIN_CACHE_DIRECTORY: join(dir, "login-cache"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };
  return env;
}
const profile = (account: CloudAccount) => `atlas-hub-${account.id}`;
export async function preparePrivateDirectory(
  account: CloudAccount,
  secret: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-cloud-"));
  await chmod(dir, 0o700);
  await mkdir(join(dir, "login-cache"), { mode: 0o700 });
  await writeFile(
    join(dir, "config"),
    `[profile ${profile(account)}]\nregion = ${account.region}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(dir, "credentials"), "", { mode: 0o600 });
  if (account.encryptedCache) {
    const files = JSON.parse(decrypt(account.encryptedCache, secret)) as Record<
      string,
      string
    >;
    for (const [name, body] of Object.entries(files)) {
      if (
        name !== "config" &&
        !/^login-cache\/[a-zA-Z0-9_.-]{1,200}$/.test(name)
      )
        throw new CloudError("INVALID_CREDENTIAL_CACHE");
      await writeFile(join(dir, name), body, { mode: 0o600 });
    }
  }
  return dir;
}
export async function encryptedCache(
  dir: string,
  secret: string,
): Promise<string> {
  const files: Record<string, string> = {
    config: await readFile(join(dir, "config"), "utf8"),
  };
  for (const name of await readdir(join(dir, "login-cache")))
    if (/^[a-zA-Z0-9_.-]{1,200}$/.test(name))
      files[`login-cache/${name}`] = await readFile(
        join(dir, "login-cache", name),
        "utf8",
      );
  return encrypt(JSON.stringify(files), secret);
}
export class AwsCliAdapter implements CloudAdapter {
  readonly mode = "real" as const;
  constructor(
    private account: CloudAccount,
    private directory: string,
    private originKey: string | Readonly<Record<string, string>>,
    private executable = "/usr/local/bin/aws",
  ) {}
  async run(args: string[]): Promise<any> {
    // argv is built only by the typed methods below; no executable/argv comes from HTTP.
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        this.executable,
        [
          ...args,
          "--profile",
          profile(this.account),
          "--region",
          this.account.region,
          "--output",
          "json",
          "--no-cli-pager",
          "--no-cli-auto-prompt",
          "--cli-connect-timeout",
          "10",
          "--cli-read-timeout",
          "30",
        ],
        {
          env: privateEnvironment(this.directory),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      let settled = false;
      const fail = (e: CloudError) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new CloudError("AWS_TIMEOUT", true));
      }, 75_000);
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.length > 32 * 1024 * 1024) {
          child.kill("SIGKILL");
          fail(new CloudError("AWS_OUTPUT_LIMIT"));
        }
      });
      child.stderr.on("data", (chunk) => {
        err = (err + String(chunk)).slice(-65536);
      });
      child.on("error", () => fail(new CloudError("AWS_CLI_UNAVAILABLE")));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(sanitizedAwsError(err));
        else {
          try {
            resolveResult(out.trim() ? JSON.parse(out) : {});
          } catch {
            reject(new CloudError("AWS_INVALID_RESPONSE"));
          }
        }
      });
      child.stdin.end();
    });
  }
  async identity() {
    const value = await this.run(["sts", "get-caller-identity"]);
    if (!/^[0-9]{12}$/.test(value.Account ?? ""))
      throw new CloudError("AWS_INVALID_RESPONSE");
    return value.Account as string;
  }
  async quota() {
    const value = await this.run([
      "service-quotas",
      "list-service-quotas",
      "--service-code",
      "cloudfront",
    ]);
    const quotas = value.Quotas ?? [];
    const distribution = quotas.find((q: any) =>
      /distributions per (?:AWS )?account/i.test(q.QuotaName),
    );
    const associations = quotas.find((q: any) =>
      /distributions.*(?:same |one |single )?(?:CloudFront )?function/i.test(
        q.QuotaName,
      ),
    );
    if (!Number.isFinite(distribution?.Value))
      throw new CloudError("AWS_QUOTA_UNVERIFIED");
    return {
      distributions: distribution.Value,
      functionAssociations: Math.min(100, associations?.Value ?? 100),
    };
  }
  private parse(value: any): Distribution {
    if (
      !/^[A-Z0-9]{1,64}$/.test(value?.Id ?? "") ||
      !/^d[a-z0-9]+\.cloudfront\.net$/.test(value?.DomainName ?? "")
    )
      throw new CloudError("AWS_INVALID_RESPONSE");
    return {
      id: value.Id,
      domain: value.DomainName,
      status: value.Status,
      caller:
        value.DistributionConfig?.CallerReference ??
        value.CallerReference ??
        "",
      originHost: value.DistributionConfig?.Origins?.Items?.[0]?.DomainName,
    };
  }
  async inventory() {
    const v = await this.run(["cloudfront", "list-distributions"]);
    const items: Distribution[] = [];
    for (const d of v.DistributionList?.Items ?? []) {
      const full = await this.run([
        "cloudfront",
        "get-distribution",
        "--id",
        d.Id,
      ]);
      items.push(this.parse(full.Distribution));
    }
    return items;
  }
  async ensureFunction(name: string) {
    let existing: any;
    try {
      existing = await this.run([
        "cloudfront",
        "describe-function",
        "--name",
        name,
      ]);
    } catch (e) {
      if (!(e instanceof CloudError) || e.code !== "AWS_FUNCTION_NOT_FOUND")
        throw e;
      existing = await this.run([
        "cloudfront",
        "create-function",
        "--name",
        name,
        "--function-config",
        JSON.stringify({
          Comment: "Atlas verified viewer headers",
          Runtime: "cloudfront-js-2.0",
        }),
        "--function-code",
        Buffer.from(viewerCode).toString("base64"),
      ]);
    }
    const result = await this.run([
      "cloudfront",
      "publish-function",
      "--name",
      name,
      "--if-match",
      existing.ETag,
    ]);
    const arn = result.FunctionSummary?.FunctionMetadata?.FunctionARN;
    if (
      typeof arn !== "string" ||
      !arn.startsWith(
        `arn:aws:cloudfront::${this.account.expectedAccountId}:function/`,
      )
    )
      throw new CloudError("AWS_INVALID_RESPONSE");
    return arn as string;
  }
  async create(jobId: string, resource: CloudResource, functionArn: string) {
    const value = await this.run([
      "cloudfront",
      "create-distribution-with-tags",
      "--distribution-config-with-tags",
      JSON.stringify(
        distributionConfig(jobId, resource, functionArn, this.originKey),
      ),
    ]);
    return this.parse(value.Distribution);
  }
  async inspect(id: string) {
    return this.parse(
      (await this.run(["cloudfront", "get-distribution", "--id", id]))
        .Distribution,
    );
  }
}
/** Local adapter has no reference to an AWS executable and never falls back. */
export class FakeCloudAdapter implements CloudAdapter {
  readonly mode = "fake" as const;
  resources = new Map<string, Distribution>();
  functions = new Map<string, string>();
  calls: string[] = [];
  faults: { operation: string; code: string }[] = [];
  constructor(
    readonly account = "111111111111",
    readonly limit = 5000,
  ) {}
  private fault(operation: string) {
    this.calls.push(operation);
    const index = this.faults.findIndex((f) => f.operation === operation);
    if (index >= 0) {
      const [f] = this.faults.splice(index, 1);
      throw new CloudError(f!.code, true);
    }
  }
  async identity() {
    this.fault("identity");
    return this.account;
  }
  async quota() {
    this.fault("quota");
    return { distributions: this.limit, functionAssociations: 100 };
  }
  async inventory() {
    this.fault("inventory");
    return [...this.resources.values()];
  }
  async ensureFunction(name: string) {
    this.fault("function");
    const arn =
      this.functions.get(name) ??
      `arn:aws:cloudfront::${this.account}:function/${name}`;
    this.functions.set(name, arn);
    return arn;
  }
  async create(jobId: string, resource: CloudResource, _arn: string) {
    this.fault("create");
    const caller = `atlas-hub-${jobId}-${resource.key}`;
    const existing = [...this.resources.values()].find(
      (r) => r.caller === caller,
    );
    if (existing) throw new CloudError("AWS_RECONCILE_REQUIRED", true);
    const n = this.resources.size + 1;
    const d = {
      id: `FAKE${n}`,
      domain: `dfake${n}.cloudfront.net`,
      status: "Deployed",
      caller,
      originHost: resource.originHost,
    };
    this.resources.set(d.id, d);
    return d;
  }
  async inspect(id: string) {
    this.fault("inspect");
    const d = this.resources.get(id);
    if (!d) throw new CloudError("AWS_RESOURCE_MISSING");
    return d;
  }
}
export class DatabaseFakeCloudAdapter extends FakeCloudAdapter {
  constructor(
    private pool: Pool,
    private accountId: string,
    identity: string,
  ) {
    super(identity);
  }
  private async consume(operation: string) {
    const row = (
      await this.pool.query(
        "UPDATE hub_cloud_simulator_faults SET remaining=remaining-1 WHERE id=(SELECT id FROM hub_cloud_simulator_faults WHERE account_id=$1 AND operation=$2 AND remaining>0 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING code",
        [this.accountId, operation],
      )
    ).rows[0];
    if (!row) return null;
    if (row.code === "AWS_DEPLOYING") return row.code;
    throw new CloudError(
      row.code,
      ["AWS_THROTTLED", "AWS_TIMEOUT"].includes(row.code),
    );
  }
  override async identity() {
    await this.consume("identity");
    return super.identity();
  }
  override async quota() {
    await this.consume("quota");
    return super.quota();
  }
  override async inventory() {
    await this.consume("inventory");
    return super.inventory();
  }
  override async inspect(id: string) {
    const code = await this.consume("inspect");
    const d = await super.inspect(id);
    return code === "AWS_DEPLOYING" ? { ...d, status: "InProgress" } : d;
  }
  async restore() {
    for (const row of (
      await this.pool.query(
        "SELECT resource FROM hub_cloud_simulator_resources WHERE account_id=$1",
        [this.accountId],
      )
    ).rows) {
      const d = row.resource as Distribution;
      this.resources.set(d.id, d);
    }
    for (const row of (
      await this.pool.query(
        "SELECT name,arn FROM hub_cloud_simulator_functions WHERE account_id=$1",
        [this.accountId],
      )
    ).rows)
      this.functions.set(row.name, row.arn);
    return this;
  }
  override async ensureFunction(name: string) {
    await this.consume("function");
    const arn = await super.ensureFunction(name);
    await this.pool.query(
      "INSERT INTO hub_cloud_simulator_functions(account_id,name,arn) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [this.accountId, name, arn],
    );
    return arn;
  }
  override async create(jobId: string, resource: CloudResource, arn: string) {
    await this.consume("create");
    const d = await super.create(jobId, resource, arn);
    await this.pool.query(
      "INSERT INTO hub_cloud_simulator_resources(account_id,id,resource) VALUES($1,$2,$3)",
      [this.accountId, d.id, JSON.stringify(d)],
    );
    await this.consume("create_ack");
    return d;
  }
}
export async function provisionStep(
  jobId: string,
  plan: CloudPlan,
  checkpoint: CloudCheckpoint,
  adapter: CloudAdapter,
  save: (next: CloudCheckpoint) => Promise<void>,
): Promise<"waiting" | "ready_for_activation"> {
  if ((await adapter.identity()) !== plan.accountIdentity)
    throw new CloudError("AWS_ACCOUNT_MISMATCH");
  const inventory = await adapter.inventory();
  const quota = await adapter.quota();
  const missing = plan.resources.filter(
    (r) => !inventory.some((d) => d.caller === `atlas-hub-${jobId}-${r.key}`),
  ).length;
  if (inventory.length + missing > quota.distributions)
    throw new CloudError("AWS_DISTRIBUTION_QUOTA");
  if (quota.functionAssociations < 100)
    throw new CloudError("AWS_FUNCTION_QUOTA");
  const next: CloudCheckpoint = {
    ...checkpoint,
    resources: { ...checkpoint.resources },
    functions: { ...checkpoint.functions },
    inventoryChecked: true,
  };
  for (let i = 0; i < plan.resources.length; i++) {
    const resource = plan.resources[i]!;
    const caller = `atlas-hub-${jobId}-${resource.key}`;
    let distribution =
      next.resources![resource.key] ??
      inventory.find((d) => d.caller === caller);
    if (!distribution) {
      const group = String(groupIndex(i));
      let fn = next.functions![group];
      if (!fn) {
        fn = await adapter.ensureFunction(`atlas-hub-${jobId}-${group}`);
        next.functions![group] = fn;
        await save(structuredClone(next));
      }
      distribution = await adapter.create(jobId, resource, fn);
      next.resources![resource.key] = distribution;
      await save(structuredClone(next));
    }
    // Persist reconciled resources before inspecting; every resume sees exact identity.
    next.resources![resource.key] = await adapter.inspect(distribution.id);
    await save(structuredClone(next));
  }
  return Object.values(next.resources!).every((d) => d.status === "Deployed")
    ? "ready_for_activation"
    : "waiting";
}

type LoginProcess = {
  child: ChildProcessWithoutNullStreams;
  directory: string;
  account: CloudAccount;
  submitted: boolean;
  timer: ReturnType<typeof setTimeout>;
};
export class HubCloudWorker {
  private owner = randomUUID();
  private logins = new Map<string, LoginProcess>();
  private adapters = new Map<string, DatabaseFakeCloudAdapter>();
  private busy = false;
  constructor(
    private pool: Pool,
    private options: {
      encryptionKey: string;
      executable?: string;
      originKey?: string | Readonly<Record<string, string>>;
      fake?: boolean;
      simulation?: {
        coordinator: SimulationCoordinator;
        sessionSecret: string;
        initialCredentials?: Record<string, string>;
      };
    },
  ) {
    if (options.simulation && !options.fake)
      throw new CloudError("SIMULATION_REQUIRES_FAKE_PROVIDER");
    if (options.fake && process.env.NODE_ENV === "production")
      throw new CloudError("FAKE_PROVIDER_FORBIDDEN");
  }
  async close() {
    for (const p of this.logins.values()) {
      clearTimeout(p.timer);
      p.child.kill("SIGKILL");
      await rm(p.directory, { recursive: true, force: true });
    }
    this.logins.clear();
  }
  private account(row: any): CloudAccount {
    return {
      id: row.id,
      expectedAccountId: row.expected_account_id.trim(),
      region: row.region,
      encryptedCache: row.encrypted_cache,
    };
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.loginTick();
      await this.jobTick();
    } finally {
      this.busy = false;
    }
  }
  private async loginTick() {
    await this.pool.query(
      "UPDATE hub_cloud_login SET status='expired',encrypted_code=NULL WHERE expires_at<=now() AND status IN ('queued','waiting_code','code_submitted')",
    );
    const requests = await this.pool.query(
      "SELECT l.*,a.expected_account_id,a.region,a.encrypted_cache FROM hub_cloud_login l JOIN hub_cloud_accounts a ON a.id=l.account_id WHERE l.status IN ('queued','waiting_code','code_submitted') AND l.expires_at>now() AND (l.worker_owner IS NULL OR l.worker_owner=$1 OR l.worker_lease<now()) ORDER BY l.created_at LIMIT 10",
      [this.owner],
    );
    for (const row of requests.rows) {
      const account = this.account({ ...row, id: row.account_id });
      if (this.options.fake) {
        await this.pool.query(
          "UPDATE hub_cloud_accounts SET verified_account_id=expected_account_id,status='connected',verified_at=now() WHERE id=$1",
          [account.id],
        );
        await this.pool.query(
          "UPDATE hub_cloud_login SET status='complete',encrypted_code=NULL,authorization_url=NULL WHERE id=$1",
          [row.id],
        );
        continue;
      }
      let active = this.logins.get(row.id);
      if (
        !active &&
        (row.status !== "queued" ||
          (row.worker_owner && row.worker_owner !== this.owner))
      ) {
        await this.pool.query(
          "UPDATE hub_cloud_login SET status='expired',encrypted_code=NULL,error_code='WORKER_RESTARTED' WHERE id=$1",
          [row.id],
        );
        continue;
      }
      if (!active) {
        const claimed = await this.pool.query(
          "UPDATE hub_cloud_login SET worker_owner=$2,worker_lease=now()+interval '30 seconds' WHERE id=$1 AND worker_owner IS NULL AND status='queued' RETURNING id",
          [row.id, this.owner],
        );
        if (!claimed.rowCount) continue;
        const dir = await preparePrivateDirectory(
          { ...account, encryptedCache: null },
          this.options.encryptionKey,
        );
        const child = spawn(
          this.options.executable ?? "/usr/local/bin/aws",
          [
            "login",
            "--remote",
            "--profile",
            profile(account),
            "--region",
            account.region,
            "--no-cli-pager",
          ],
          {
            env: privateEnvironment(dir),
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
        active = { child, directory: dir, account, submitted: false, timer };
        this.logins.set(row.id, active);
        let output = "";
        const consume = (chunk: Buffer) => {
          output = (output + String(chunk)).slice(-32768);
          const match = output.match(/https:\/\/[^\s<>"']+/);
          if (match) {
            try {
              const url = new URL(match[0]);
              if (
                url.protocol === "https:" &&
                /(?:^|\.)(?:amazonaws\.com|aws\.amazon\.com)$/.test(
                  url.hostname,
                )
              )
                void this.pool.query(
                  "UPDATE hub_cloud_login SET status='waiting_code',authorization_url=$2 WHERE id=$1 AND status='queued'",
                  [row.id, url.href],
                );
            } catch {
              /* never relay raw stdout */
            }
          }
        };
        child.stdout.on("data", consume);
        child.stderr.on("data", consume);
        const finish = async (code: number | null) => {
          clearTimeout(timer);
          this.logins.delete(row.id);
          try {
            if (code !== 0) throw new CloudError("AWS_LOGIN_FAILED");
            const adapter = new AwsCliAdapter(
              account,
              dir,
              this.options.originKey ?? "",
              this.options.executable,
            );
            if ((await adapter.identity()) !== account.expectedAccountId)
              throw new CloudError("AWS_ACCOUNT_MISMATCH");
            const cache = await encryptedCache(dir, this.options.encryptionKey);
            await this.pool.query(
              "UPDATE hub_cloud_accounts SET status='connected',verified_account_id=$2,encrypted_cache=$3,verified_at=now() WHERE id=$1",
              [account.id, account.expectedAccountId, cache],
            );
            await this.pool.query(
              "UPDATE hub_cloud_login SET status='complete',encrypted_code=NULL,authorization_url=NULL WHERE id=$1",
              [row.id],
            );
          } catch (e) {
            await this.pool.query(
              "UPDATE hub_cloud_accounts SET status='sign_in_required' WHERE id=$1",
              [account.id],
            );
            await this.pool.query(
              "UPDATE hub_cloud_login SET status='error',encrypted_code=NULL,error_code=$2 WHERE id=$1",
              [row.id, e instanceof CloudError ? e.code : "AWS_LOGIN_FAILED"],
            );
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        };
        let done = false;
        const complete = (code: number | null) => {
          if (!done) {
            done = true;
            void finish(code).catch(() => {});
          }
        };
        child.on("close", complete);
        child.on("error", () => complete(1));
        await this.pool.query(
          "UPDATE hub_cloud_accounts SET status='pending' WHERE id=$1",
          [account.id],
        );
      }
      await this.pool.query(
        "UPDATE hub_cloud_login SET worker_lease=now()+interval '30 seconds' WHERE id=$1 AND worker_owner=$2",
        [row.id, this.owner],
      );
      if (
        row.status === "code_submitted" &&
        row.encrypted_code &&
        !active.submitted
      ) {
        active.submitted = true;
        active.child.stdin.end(
          `${decrypt(row.encrypted_code, this.options.encryptionKey)}\n`,
        );
        await this.pool.query(
          "UPDATE hub_cloud_login SET encrypted_code=NULL WHERE id=$1",
          [row.id],
        );
      }
    }
  }
  private async jobTick() {
    const claim = await this.pool.query(
      "UPDATE hub_cloud_jobs SET lease_owner=$1,lease_until=now()+interval '10 minutes',state='running',updated_at=now() WHERE id=(SELECT id FROM hub_cloud_jobs WHERE state IN ('queued','waiting','running') AND (lease_until IS NULL OR lease_until<now()) AND (state<>'waiting' OR updated_at<now()-interval '15 seconds') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
      [this.owner],
    );
    const job = claim.rows[0];
    if (!job) return;
    let dir: string | undefined;
    const heartbeat = setInterval(() => {
      void this.pool
        .query(
          "UPDATE hub_cloud_jobs SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_owner=$2 AND state='running'",
          [job.id, this.owner],
        )
        .catch(() => {});
    }, 20_000);
    try {
      const accountRow = (
        await this.pool.query("SELECT * FROM hub_cloud_accounts WHERE id=$1", [
          job.plan.accountId,
        ])
      ).rows[0];
      if (!accountRow || accountRow.status !== "connected")
        throw new CloudError("SIGN_IN_REQUIRED");
      const account = this.account(accountRow);
      let adapter: CloudAdapter;
      if (this.options.fake) {
        let fake = this.adapters.get(account.id);
        if (!fake) {
          fake = await new DatabaseFakeCloudAdapter(
            this.pool,
            account.id,
            account.expectedAccountId,
          ).restore();
          this.adapters.set(account.id, fake);
        }
        adapter = fake;
      } else {
        dir = await preparePrivateDirectory(
          account,
          this.options.encryptionKey,
        );
        adapter = new AwsCliAdapter(
          account,
          dir,
          this.options.originKey ?? "",
          this.options.executable,
        );
      }
      if (hashPlan(job.plan) !== job.plan_hash)
        throw new CloudError("PLAN_INTEGRITY_FAILED");
      const activationReceipt = this.options.simulation
        ? (
            await this.pool.query(
              "SELECT phase FROM hub_cloud_activation WHERE job_id=$1",
              [job.id],
            )
          ).rows[0]
        : null;
      for (const resource of (job.plan as CloudPlan).resources) {
        if (activationReceipt && activationReceipt.phase !== "prepared")
          continue;
        if (!resource.previous) continue;
        const old = resource.previous;
        const current = (
          await this.pool.query(
            "SELECT * FROM hub_cloud_endpoints WHERE id=$1 AND revision=$2 AND state IN ('active','staged')",
            [old.id, old.revision],
          )
        ).rows[0];
        if (
          !current ||
          current.distribution_id !== old.distributionId ||
          current.account_id !== old.accountId
        )
          throw new CloudError("ENDPOINT_REVISION_CONFLICT");
        const priorRow = (
          await this.pool.query(
            "SELECT * FROM hub_cloud_accounts WHERE id=$1 AND status='connected'",
            [old.accountId],
          )
        ).rows[0];
        if (!priorRow) throw new CloudError("SIGN_IN_REQUIRED");
        const priorAccount = this.account(priorRow);
        let oldAdapter: CloudAdapter;
        let oldDir: string | undefined;
        try {
          if (this.options.fake)
            oldAdapter = await new DatabaseFakeCloudAdapter(
              this.pool,
              old.accountId,
              priorAccount.expectedAccountId,
            ).restore();
          else {
            oldDir = await preparePrivateDirectory(
              priorAccount,
              this.options.encryptionKey,
            );
            oldAdapter = new AwsCliAdapter(
              priorAccount,
              oldDir,
              this.options.originKey ?? "",
              this.options.executable,
            );
          }
          if ((await oldAdapter.identity()) !== priorAccount.expectedAccountId)
            throw new CloudError("AWS_ACCOUNT_MISMATCH");
          const existing = await oldAdapter.inspect(old.distributionId);
          if (
            (this.options.simulation
              ? old.url !== "https://" + existing.domain &&
                !/^https:\/\/[a-z0-9-]+(?:\.atlas)?\.localhost:428[0-4]$/.test(
                  old.url,
                ) &&
                old.url !== "https://localhost:4280" &&
                old.url !== "https://localhost:4300" &&
                !/^https:\/\/[a-z0-9-]+(?:\.atlas)?\.localhost:4300$/.test(
                  old.url,
                ) &&
                !/^https:\/\/127\.0\.0\.1:428[2-4]$/.test(old.url)
              : "https://" + existing.domain !== old.url) ||
            existing.originHost !== resource.originHost
          )
            throw new CloudError("AWS_ENDPOINT_MISMATCH");
        } finally {
          if (oldDir) await rm(oldDir, { recursive: true, force: true });
        }
      }
      let state: string = await provisionStep(
        job.id,
        job.plan,
        job.checkpoint,
        adapter,
        async (checkpoint) => {
          const saved = await this.pool.query(
            "UPDATE hub_cloud_jobs SET checkpoint=$3,lease_until=now()+interval '10 minutes',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='running'",
            [job.id, this.owner, JSON.stringify(checkpoint)],
          );
          if (!saved.rowCount) throw new CloudError("JOB_CANCELLED");
        },
      );
      if (state === "ready_for_activation" && this.options.simulation) {
        const savedCheckpoint = (
          await this.pool.query(
            "SELECT checkpoint FROM hub_cloud_jobs WHERE id=$1",
            [job.id],
          )
        ).rows[0].checkpoint;
        await activateSimulation(
          this.pool,
          job.id,
          job.plan,
          savedCheckpoint,
          this.options.simulation.coordinator,
          {
            encryptionKey: this.options.encryptionKey,
            sessionSecret: this.options.simulation.sessionSecret,
            initialCredentials: this.options.simulation.initialCredentials,
          },
        );
        state = "complete";
      }
      if (dir)
        await this.pool.query(
          "UPDATE hub_cloud_accounts SET encrypted_cache=$2 WHERE id=$1",
          [account.id, await encryptedCache(dir, this.options.encryptionKey)],
        );
      await this.pool.query(
        "UPDATE hub_cloud_jobs SET state=$3,lease_until=NULL,lease_owner=NULL,revision=revision+1,error_code=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='running'",
        [job.id, this.owner, state],
      );
      // Deployed CloudFront != qualified runtime. Root release gates/coordinator must
      // perform probes, sync transitions, callback setup and revision-checked cutover.
      await this.pool.query(
        "INSERT INTO hub_cloud_events(job_id,stage,code) VALUES($1,$2,$3)",
        [
          job.id,
          state,
          state === "complete"
            ? "SIMULATION_ACTIVATED"
            : state === "ready_for_activation"
              ? "RUNTIME_ACCEPTANCE_REQUIRED"
              : null,
        ],
      );
    } catch (error) {
      const e =
        error instanceof CloudError
          ? error
          : new CloudError("CLOUD_WORKER_FAILED");
      await this.pool.query(
        "UPDATE hub_cloud_jobs SET state=$3,error_code=$4,lease_until=NULL,lease_owner=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='running'",
        [
          job.id,
          this.owner,
          e.code === "SIGN_IN_REQUIRED"
            ? "sign_in_required"
            : e.retryable
              ? "waiting"
              : "failed",
          e.code,
        ],
      );
    } finally {
      clearInterval(heartbeat);
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
