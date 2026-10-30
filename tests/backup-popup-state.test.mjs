import test from "node:test";
import assert from "node:assert/strict";
import {
  backupPopupError,
  backupPopupView,
} from "../web/src/backup-popup-state.ts";
const status = (state, extra = {}) => ({
  state,
  message: "Saved locally · internal status",
  deferred: [],
  ...extra,
});
test("backup popup claims backed up only for acknowledged idle work without deferred saves", () => {
  const receipt = {
    checkpointId: "acknowledged",
    completedAt: "2026-10-28T18:00:00Z",
  };
  assert.equal(backupPopupView(status("idle")).summary, "No backup yet");
  assert.equal(
    backupPopupView(status("pending", { lastCompleted: receipt })).label,
    "Saved locally",
  );
  assert.equal(
    backupPopupView(status("idle", { lastCompleted: receipt })).label,
    "Saved locally · backed up",
  );
  const partial = backupPopupView(
    status("idle", {
      lastCompleted: receipt,
      deferred: [
        {
          sourceId: "site",
          code: "RECORD_TOO_LARGE",
          message: "Record too large",
        },
      ],
    }),
  );
  assert.equal(partial.summary, "Backup incomplete");
  assert.equal(partial.label, "Saved locally");
  assert.equal(
    partial.issue,
    "Some saves are too large to back up. Contact support.",
  );
});
test("backup popup reports concise actionable errors rather than raw internal payloads", () => {
  assert.equal(
    backupPopupError({ status: 403 }),
    "Sign in again to back up your saves.",
  );
  assert.equal(
    backupPopupError({ code: "HUB_QUOTA" }),
    "Backup storage is full. Contact support.",
  );
  assert.equal(
    backupPopupError({
      code: "BACKUP_RECORD_OVERSIZED",
      message: "Record exceeds automatic allowance",
    }),
    "Some saves are too large to back up. Contact support.",
  );
  assert.equal(
    backupPopupError(new Error('{"private":"internal"}')),
    "Backup unavailable. Try again.",
  );
  assert.equal(backupPopupView(status("uploading")).summary, "Backing up…");
  assert.equal(
    backupPopupView(status("offline")).issue,
    "Backup unavailable. Try again.",
  );
});

test("global typed deferral is not misreported as a network outage when deferred sources are empty", () => {
  const lastCompleted = {
    checkpointId: "last-confirmed",
    completedAt: "2026-10-28T21:57:19Z",
  };
  for (const code of [
    "BACKUP_FOREGROUND_BUSY",
    "BACKUP_SOURCE_BUSY",
    "BACKUP_CAPTURE_BUSY",
    "BACKUP_READ_DEADLINE",
    "BACKUP_SEAL_INTERRUPTED",
  ]) {
    const value = status("deferred", {
      lastCompleted,
      lastIssue: { kind: "deferred", code, name: "AbortError" },
    });
    const view = backupPopupView(value);
    assert.equal(view.issue, "Waiting for a quiet moment to back up.");
    assert.equal(view.summary, "Backup incomplete");
    assert.equal(view.label, "Saved locally");
    assert.equal(value.lastCompleted.completedAt, "2026-10-28T21:57:19Z");
  }
  assert.equal(
    backupPopupView(
      status("deferred", {
        lastIssue: { kind: "deferred", code: "BACKUP_LOCAL_ACTOR_BUSY" },
      }),
    ).issue,
    "Another backup is running. This one will retry.",
  );
  assert.equal(
    backupPopupView(
      status("deferred", {
        lastIssue: {
          kind: "deferred",
          code: "BACKUP_COORDINATION_UNAVAILABLE",
        },
      }),
    ).issue,
    "Waiting to start the backup.",
  );
  assert.equal(
    backupPopupView(status("deferred")).issue,
    "Backup deferred. Try again.",
  );
});

test("source budgets, unqualified records and cloud quota remain distinct and never imply complete backup", () => {
  const cases = [
    [
      "BACKUP_CYCLE_BUDGET",
      "This site is scheduled for a later bounded backup cycle.",
      "More saves are waiting for the next backup cycle.",
    ],
    [
      "BACKUP_CYCLE_BUDGET",
      "This namespace needs more than one safe automatic backup budget.",
      "Some saves exceed the automatic backup limit.",
    ],
    [
      "BACKUP_RECORD_TOO_LARGE",
      "Large record",
      "Some saves are too large to back up. Contact support.",
    ],
    [
      "BACKUP_RECORD_UNSIZED",
      "Unknown native size metadata",
      "Some saves aren’t ready for automatic backup.",
    ],
    [
      "BACKUP_RECORD_UNSUPPORTED",
      "Unknown value shape",
      "Some saves aren’t supported by automatic backup.",
    ],
    [
      "BACKUP_SOURCE_MISSING",
      "Held source",
      "Waiting for this website’s saves.",
    ],
    [
      "BACKUP_QUOTA_EXCEEDED",
      "Cloud allowance exhausted",
      "Backup storage is full. Contact support.",
    ],
  ];
  for (const [code, message, expected] of cases) {
    const view = backupPopupView(
      status("deferred", {
        lastCompleted: { completedAt: "2026-10-28T21:57:19Z" },
        deferred: [{ sourceId: "site", code, message }],
      }),
    );
    assert.equal(view.issue, expected);
    assert.equal(view.label, "Saved locally");
    assert.equal(view.summary,code==="BACKUP_CYCLE_BUDGET"&&message.startsWith("This site is scheduled")?"Backup pending":"Backup incomplete");
  }
  assert.equal(
    backupPopupView(
      status("deferred", {
        lastIssue: {
          kind: "deferred",
          code: "BACKUP_QUOTA_EXCEEDED",
          status: 413,
        },
      }),
    ).issue,
    "Backup storage is full. Contact support.",
  );
  assert.equal(
    backupPopupView(
      status("offline", {
        lastIssue: { kind: "offline", code: "HUB_UNAVAILABLE", status: 503 },
      }),
    ).issue,
    "Backup unavailable. Try again.",
  );
  for (const [lastIssue, expected] of [
    [
      { kind: "deferred", code: "BACKUP_QUOTA_EXCEEDED", status: 413 },
      "Backup storage is full. Contact support.",
    ],
    [
      { kind: "offline", code: "HUB_UNAVAILABLE", status: 503 },
      "Backup unavailable. Try again.",
    ],
    [
      { kind: "conflict", code: "BACKUP_CONFLICT", status: 409 },
      "Backup paused. Try again or contact support.",
    ],
  ]) {
    const view = backupPopupView(
      status(lastIssue.kind, {
        lastIssue,
        deferred: [
          {
            sourceId: "held",
            code: "BACKUP_SOURCE_BUSY",
            message: "Website busy",
          },
        ],
      }),
    );
    assert.equal(
      view.issue,
      expected,
      "current global failure must not be hidden by an earlier source deferral",
    );
    assert.equal(view.label, "Saved locally");
    assert.equal(view.summary, "Backup incomplete");
  }
});

test("strict native QuotaExceededError is distinct from cloud backup allowance", () => {
  assert.equal(
    backupPopupError({ name: "QuotaExceededError" }),
    "Browser storage is full. Contact support.",
  );
  assert.equal(
    backupPopupError({
      name: "QuotaExceededError",
      status: 413,
      code: "BACKUP_QUOTA_EXCEEDED",
    }),
    "Backup storage is full. Contact support.",
  );
  const view = backupPopupView(
    status("error", {
      lastIssue: { kind: "error", name: "QuotaExceededError" },
    }),
  );
  assert.equal(view.issue, "Browser storage is full. Contact support.");
  assert.equal(view.label, "Saved locally");
});

test("bounded queued work is pending, not a network failure or an invented completed backup",()=>{
 for(const code of ["BACKUP_VISIT_YIELDED","BACKUP_CATALOG_PENDING","BACKUP_SPOOL_PRESSURE","BACKUP_SPOOL_EVICTED","BACKUP_VALIDATING"]){
  const view=backupPopupView(status("deferred",{lastCompleted:{completedAt:"2026-10-28T21:57:19Z"},deferred:[{sourceId:"site",code,message:"private internal detail"}]}));assert.equal(view.summary,"Backup pending");assert.equal(view.label,"Saved locally");assert.equal(view.issue,"More saves are waiting for the next backup cycle.");
 }
 const busy=backupPopupView(status("offline",{lastIssue:{code:"BACKUP_BUSY",status:429,kind:"offline"}}));assert.equal(busy.summary,"Backup pending");assert.equal(busy.issue,"Backups are busy. This one will retry.");
 const full=backupPopupView(status("deferred",{deferred:[{sourceId:"site",code:"BACKUP_CATALOG_FULL",message:"internal"}]}));assert.equal(full.summary,"Backup incomplete");assert.equal(full.issue,"Some websites have reached the backup limit. Contact support.");
});
