import test from "node:test";
import assert from "node:assert/strict";
import {
  reserveLegacyOwner,
  runInitialProfileImport,
  LEGACY_PROFILE_OWNER_KEY,
} from "../web/src/profile-import.ts";
function ownership() {
  const rows = new Map([
    ["legacy-save", "PRIVATE LEGACY"],
    ["atlas.history", "PRIVATE HISTORY"],
  ]);
  let tail = Promise.resolve();
  const storage = {
    getItem: (k) => rows.get(k) ?? null,
    setItem: (k, v) => rows.set(k, v),
  };
  const exclusive = (run) => {
    const next = tail.then(run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return { rows, reserve: (id) => reserveLegacyOwner(id, storage, exclusive) };
}
function preparation(overrides = {}) {
  let cancelled = false,
    frozen = false,
    exported = 0,
    userReads = 0;
  const snapshots = [
      {
        namespace: { kind: "local", origin: "https://game.example" },
        payload: { save: "PRIVATE WEBSITE" },
      },
    ],
    commits = [],
    wires = [];
  const options = {
    ownsLegacy: true,
    cancelled: () => cancelled,
    exportSnapshots: async () => {
      exported++;
      return structuredClone(snapshots);
    },
    readUserData: () => {
      userReads++;
      return { "atlas.history": "PRIVATE HISTORY" };
    },
    wire: async (value) => {
      wires.push(structuredClone(value));
      return structuredClone(value);
    },
    freeze: () => {
      frozen = true;
    },
    manifestHash: async (entries) => {
      assert.equal(frozen, true, "Cancel must be hidden before hashing");
      return JSON.stringify(entries);
    },
    commit: async (entries, hash) => {
      assert.equal(
        frozen,
        true,
        "Cancel must be hidden before irreversible commit",
      );
      commits.push({ entries: structuredClone(entries), hash });
      return { acknowledged: true };
    },
    ...overrides,
  };
  return {
    options,
    commits,
    wires,
    snapshots,
    cancel: () => {
      cancelled = true;
    },
    get exported() {
      return exported;
    },
    get userReads() {
      return userReads;
    },
  };
}
function onlyDefaults(p) {
  assert.equal(p.commits.length, 1);
  assert.deepEqual(p.commits[0].entries, [
    {
      namespace: { kind: "atlas" },
      payload: {
        format: "atlas-user-snapshot-v1",
        values: { "atlas.onboarded": "true" },
      },
    },
  ]);
  assert.ok(!JSON.stringify(p.commits[0]).includes("PRIVATE"));
}
test("legacy browser ownership is atomic, persistent and never transfers with account switching", async () => {
  const o = ownership();
  assert.deepEqual(
    await Promise.all([o.reserve("account-A"), o.reserve("account-B")]),
    [true, false],
  );
  assert.equal(await o.reserve("account-A"), true);
  assert.equal(o.rows.get(LEGACY_PROFILE_OWNER_KEY), "account-A");
  assert.equal(o.rows.get("legacy-save"), "PRIVATE LEGACY");
  assert.equal(o.rows.get("atlas.history"), "PRIVATE HISTORY");
});
test("first-account cancellation still owns untouched legacy data and later accounts cannot import it", async () => {
  const o = ownership(),
    p = preparation();
  assert.equal(await o.reserve("account-A"), true);
  p.cancel();
  const result = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(p.exported, 0);
  assert.equal(p.userReads, 0);
  assert.deepEqual(result, { retained: false, nonportable: [] });
  assert.equal(await o.reserve("account-B"), false);
  assert.equal(o.rows.get("legacy-save"), "PRIVATE LEGACY");
});
test("an existing-cloud first account reserves legacy ownership even when no import is run", async () => {
  const o = ownership();
  const initialized = true;
  const owns = await o.reserve("existing-cloud-account-A");
  assert.equal(initialized, true);
  assert.equal(owns, true);
  assert.equal(await o.reserve("new-account-B"), false);
  assert.equal(o.rows.get("legacy-save"), "PRIVATE LEGACY");
});
test("a non-owner never reads legacy native stores or metadata", async () => {
  const p = preparation({ ownsLegacy: false });
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(p.exported, 0);
  assert.equal(p.userReads, 0);
  assert.equal(r.retained, false);
});
test("visible cancellation during native export discards its completed data before any private wire", async () => {
  const p = preparation();
  p.options.exportSnapshots = async () => {
    p.cancel();
    return p.snapshots;
  };
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(p.userReads, 0);
  assert.equal(p.wires.length, 1);
  assert.deepEqual(r, { retained: false, nonportable: [] });
});
test("cancel during a private website upload discards all staged website and metadata entries", async () => {
  const p = preparation();
  const original = p.options.wire;
  p.options.wire = async (value) => {
    const encoded = await original(value);
    if (value.save) p.cancel();
    return encoded;
  };
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(p.userReads, 0);
  assert.equal(r.retained, false);
  assert.deepEqual(p.snapshots[0].payload, { save: "PRIVATE WEBSITE" });
});
test("cancel during Atlas metadata wiring removes website and metadata payloads before commit", async () => {
  const p = preparation();
  const original = p.options.wire;
  p.options.wire = async (value) => {
    const encoded = await original(value);
    if (value.values?.["atlas.history"]) p.cancel();
    return encoded;
  };
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(r.retained, false);
});
test("queued cancellation during async manifest hashing rebuilds an empty manifest before commit", async () => {
  const p = preparation();
  let hashes = 0;
  const original = p.options.manifestHash;
  p.options.manifestHash = async (entries) => {
    hashes++;
    const hash = await original(entries);
    if (hashes === 1) p.cancel();
    return hash;
  };
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.equal(hashes, 2);
  assert.equal(p.commits[0].hash, JSON.stringify(p.commits[0].entries));
  assert.deepEqual(r, { retained: false, nonportable: [] });
});
test("unsupported-data notices survive only an acknowledged retained import", async () => {
  const p = preparation();
  p.options.wire = async (value) => {
    if (value.save) throw new TypeError("Unsupported portable platform value");
    return structuredClone(value);
  };
  const r = await runInitialProfileImport(p.options);
  assert.equal(r.retained, true);
  assert.equal(r.nonportable.length, 1);
  assert.equal(p.commits[0].entries.length, 1);
  assert.equal(
    p.commits[0].entries[0].payload.values["atlas.history"],
    "PRIVATE HISTORY",
  );
});
test("a later cancellation clears already collected unsupported-data notices", async () => {
  const p = preparation();
  p.options.wire = async (value) => {
    if (value.save) throw new TypeError("Unsupported portable platform value");
    if (value.values?.["atlas.history"]) p.cancel();
    return structuredClone(value);
  };
  const r = await runInitialProfileImport(p.options);
  onlyDefaults(p);
  assert.deepEqual(r, { retained: false, nonportable: [] });
});
test("cancellation can finish with defaults after an export or metadata wire fails", async () => {
  for (const stage of ["export", "metadata"]) {
    const p = preparation();
    if (stage === "export")
      p.options.exportSnapshots = async () => {
        p.cancel();
        throw Error("Legacy export failed");
      };
    else {
      const original = p.options.wire;
      p.options.wire = async (value) => {
        if (value.values?.["atlas.history"]) {
          p.cancel();
          throw Error("Private wire failed");
        }
        return original(value);
      };
    }
    const r = await runInitialProfileImport(p.options);
    onlyDefaults(p);
    assert.equal(r.retained, false);
  }
});
test("a rejected remote acknowledgement does not report an import as retained", async () => {
  const p = preparation({ commit: async () => ({ acknowledged: false }) });
  await assert.rejects(runInitialProfileImport(p.options), /not acknowledged/);
});
