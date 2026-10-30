import test from "node:test";
import assert from "node:assert/strict";
import {
  createStorageLocalReceiptWriter,
  createStorageLocalReceiptReader,
  STORAGE_LOCAL_RECEIPT_BYTES,
} from "../runtime/storage-local-receipt.ts";

const ORIGIN = "https://frontend.example";
const DOC = "document_local_receipt_123";
class Directory {
  constructor(name = "", parent = null) {
    this.name = name;
    this.parent = parent;
    this.children = new Map();
    this.isDirectory = true;
    this.isFile = false;
  }
  getDirectory(name, options = {}) {
    const prior = this.children.get(name);
    if (prior) {
      if (!prior.isDirectory || options.exclusive)
        throw Error("Invalid directory");
      return prior;
    }
    if (!options.create) throw Error("Not found");
    const directory = new Directory(name, this);
    this.children.set(name, directory);
    return directory;
  }
  getFile(name, options = {}) {
    const prior = this.children.get(name);
    if (prior) {
      if (!prior.isFile || options.exclusive) throw Error("Invalid file");
      return prior;
    }
    if (!options.create) throw Error("Not found");
    const file = {
      name,
      parent: this,
      isFile: true,
      isDirectory: false,
      text: "",
      modified: new Date(),
      getMetadata() {
        return { modificationTime: this.modified };
      },
      remove() {
        this.parent.children.delete(this.name);
      },
      createWriter() {
        const file = this;
        let position = 0;
        return {
          get length() {
            return file.text.length;
          },
          seek(n) {
            position = n;
          },
          truncate(n) {
            file.text = file.text.slice(0, n);
          },
          write(blob) {
            file.text =
              file.text.slice(0, position) +
              blob.text +
              file.text.slice(position + blob.text.length);
            file.modified = new Date();
          },
        };
      },
    };
    this.children.set(name, file);
    return file;
  }
  createReader() {
    let first = true;
    return {
      readEntries: () =>
        first ? ((first = false), [...this.children.values()]) : [],
    };
  }
  remove() {
    if (this.children.size) throw Error("Directory not empty");
    this.parent?.children.delete(this.name);
  }
}
class TextBlob {
  constructor(parts) {
    this.text = parts.join("");
  }
}
function fixture({ clockStep = 0.5 } = {}) {
  const fs = { root: new Directory() },
    clock = { value: 0, step: clockStep },
    stats = { reads: 0, ranges: [], requests: [] };
  const state = { throwXHR: false, range: false, beforeRead: undefined };
  const scope = {
    location: { origin: ORIGIN },
    crypto: globalThis.crypto,
    TEMPORARY: 0,
    Blob: TextBlob,
    webkitRequestFileSystemSync: () => fs,
  };
  const lookup = (url) => {
    let entry = fs.root;
    const path = url.slice(("filesystem:" + ORIGIN + "/temporary/").length);
    for (const segment of path.split("/")) entry = entry.children.get(segment);
    return entry;
  };
  class XHR {
    open(method, url, async) {
      if (state.throwXHR) throw Error("CSP unavailable");
      assert.equal(method, "GET");
      assert.equal(async, false);
      this.url = url;
      this.headers = {};
      stats.requests.push(url);
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
      stats.ranges.push(value);
    }
    send() {
      stats.reads++;
      clock.value += clock.step;
      state.beforeRead?.();
      const file = lookup(this.url);
      this._text = file?.text ?? "";
      this.total = this._text.length;
      this._status = file ? (state.range ? 206 : 200) : 404;
      if (state.range) this._text = this._text.slice(0, 4096);
    }
    get status() {
      return this._status;
    }
    get responseText() {
      return this._text;
    }
    getResponseHeader(name) {
      return name.toLowerCase() === "content-range" && this._status === 206
        ? "bytes 0-" + (this._text.length - 1) + "/" + this.total
        : null;
    }
  }
  const host = {
    location: { origin: ORIGIN },
    Uint8Array,
    XMLHttpRequest: XHR,
    performance: { now: () => clock.value },
  };
  const writer = () => createStorageLocalReceiptWriter(scope, DOC);
  const reader = (grant) =>
    createStorageLocalReceiptReader({
      host,
      documentId: DOC,
      grant: structuredClone(grant),
    });
  const slot = (w, seq) =>
    fs.root
      .getDirectory("atlas-storage-receipts")
      .getDirectory(w.grant.directory)
      .getFile("r" + (seq % 8));
  return { fs, scope, host, stats, state, clock, writer, reader, slot, XHR };
}

test("unsupported worker filesystem stays optional", () => {
  const f = fixture();
  f.scope.webkitRequestFileSystemSync = undefined;
  assert.equal(f.writer(), null);
  assert.equal(f.fs.root.children.size, 0);
});
test("private grant yields authenticated metadata in eight bounded encrypted slots", () => {
  const f = fixture(),
    w = f.writer(),
    r = f.reader(w.grant);
  assert.ok(w && r);
  w.write(1, { ok: true, revision: 27 });
  const text = f.slot(w, 1).text;
  assert.equal(text.length, STORAGE_LOCAL_RECEIPT_BYTES);
  assert.ok(!text.includes('"revision"'));
  assert.ok(!text.includes(DOC));
  assert.equal(
    f.fs.root
      .getDirectory("atlas-storage-receipts")
      .getDirectory(w.grant.directory).children.size,
    8,
  );
  assert.deepEqual(r.read(1), { ok: true, revision: 27 });
  assert.equal(f.stats.reads, 1);
  assert.deepEqual(f.stats.ranges, ["bytes=0-4095"]);
  w.dispose();
  r.dispose();
});
test("authenticated committed errors remain errors, never positive acknowledgements", () => {
  const f = fixture(),
    w = f.writer(),
    r = f.reader(w.grant);
  const value = {
    ok: false,
    error: { name: "QuotaExceededError", code: "storage_quota_exceeded" },
  };
  w.write(2, value);
  assert.deepEqual(r.read(2), value);
  w.dispose();
  r.dispose();
});
test("wrong document, frontend, directory or grant accessors reject before XHR", () => {
  const f = fixture(),
    w = f.writer();
  let getterCalls = 0;
  for (const grant of [
    { ...w.grant, documentId: "other_document_id_123" },
    { ...w.grant, origin: "https://other.example" },
    { ...w.grant, directory: "../private-data" },
    Object.defineProperty({}, "key", {
      enumerable: true,
      get() {
        getterCalls++;
        throw Error();
      },
    }),
  ])
    assert.equal(
      createStorageLocalReceiptReader({ host: f.host, documentId: DOC, grant }),
      null,
    );
  assert.equal(getterCalls, 0);
  assert.equal(f.stats.reads, 0);
  w.dispose();
});
test("tampering or wrong key/binding cannot manufacture an acknowledgement", () => {
  for (const kind of ["ciphertext", "key", "binding"]) {
    const f = fixture(),
      w = f.writer();
    w.write(1, { ok: true, revision: 1 });
    let grant = structuredClone(w.grant);
    if (kind === "ciphertext") {
      const file = f.slot(w, 1);
      file.text = (file.text[0] === "A" ? "B" : "A") + file.text.slice(1);
    } else if (kind === "key") grant.key[0] ^= 1;
    else grant.binding = crypto.randomUUID();
    const r = f.reader(grant);
    assert.equal(r.read(1), undefined);
    w.dispose();
    r.dispose();
  }
});
test("sequence binding and accepted replay rejection survive ring-slot reuse", () => {
  const f = fixture(),
    w = f.writer(),
    r = f.reader(w.grant);
  w.write(1, { ok: true, revision: 1 });
  assert.deepEqual(r.read(1), { ok: true, revision: 1 });
  const reads = f.stats.reads;
  assert.equal(r.read(1), undefined);
  assert.equal(f.stats.reads, reads);
  const stale = f.reader(w.grant);
  w.write(9, { ok: true, revision: 9 });
  assert.equal(stale.read(1), undefined);
  assert.deepEqual(r.read(9), { ok: true, revision: 9 });
  assert.throws(() => w.write(9, { ok: true }), TypeError);
  stale.dispose();
  r.dispose();
  w.dispose();
});
test("partial, malformed and oversized packets miss instead of acknowledging", () => {
  for (const kind of ["partial", "malformed", "oversized"]) {
    const f = fixture(),
      w = f.writer(),
      r = f.reader(w.grant);
    w.write(1, { ok: true, revision: 1 });
    f.slot(w, 1).text =
      kind === "partial"
        ? f.slot(w, 1).text.slice(0, 30)
        : kind === "malformed"
          ? "not a packet"
          : "A".repeat(4097);
    assert.equal(r.read(1), undefined);
    w.dispose();
    r.dispose();
  }
});
test("range responses authenticate only bounded complete files", () => {
  const f = fixture(),
    w = f.writer(),
    r = f.reader(w.grant);
  f.state.range = true;
  w.write(1, { ok: true, revision: 1 });
  assert.deepEqual(r.read(1), { ok: true, revision: 1 });
  w.write(2, { ok: true, revision: 2 });
  f.slot(w, 2).text += " ";
  assert.equal(r.read(2), undefined);
  r.dispose();
  w.dispose();
});
test("polling caps at 128 even with a frozen clock; three misses disable it", () => {
  const f = fixture({ clockStep: 0 }),
    w = f.writer(),
    r = f.reader(w.grant);
  for (let i = 1; i <= 3; i++) {
    const before = f.stats.reads;
    assert.equal(r.read(i), undefined);
    assert.equal(f.stats.reads - before, 128);
  }
  const total = f.stats.reads;
  assert.equal(r.read(4), undefined);
  assert.equal(f.stats.reads, total);
  w.dispose();
});
test("elapsed-time budget and CSP failure fall back without false success", () => {
  const f = fixture({ clockStep: 5 }),
    w = f.writer(),
    r = f.reader(w.grant);
  assert.equal(r.read(1), undefined);
  assert.equal(f.stats.reads, 4);
  f.state.throwXHR = true;
  assert.equal(r.read(2), undefined);
  assert.equal(r.read(3), undefined);
  const reads = f.stats.requests.length;
  assert.equal(r.read(4), undefined);
  assert.equal(f.stats.requests.length, reads);
  w.dispose();
});
test("captured native XHR methods survive later prototype replacement", () => {
  const f = fixture(),
    w = f.writer(),
    r = f.reader(w.grant);
  f.XHR.prototype.open = () => {
    throw Error("site hook");
  };
  f.XHR.prototype.send = () => {
    throw Error("site hook");
  };
  Object.defineProperty(f.XHR.prototype, "responseText", {
    get() {
      throw Error("site hook");
    },
  });
  w.write(1, { ok: true, revision: 1 });
  assert.deepEqual(r.read(1), { ok: true, revision: 1 });
  r.dispose();
  w.dispose();
});
test("dispose zeroizes writer key and removes only marker files", () => {
  const f = fixture(),
    user = f.fs.root.getFile("user-save.bin", { create: true });
  user.text = "retained";
  const w = f.writer(),
    r = f.reader(w.grant),
    grantKey = w.grant.key;
  w.write(1, { ok: true, revision: 1 });
  const directory = f.fs.root
    .getDirectory("atlas-storage-receipts")
    .getDirectory(w.grant.directory);
  directory.getFile("unrecognized-user-file", { create: true }).text =
    "do not delete";
  w.dispose();
  r.dispose();
  assert.ok(grantKey.every((x) => x === 0));
  assert.equal(user.text, "retained");
  assert.equal(directory.children.size, 1);
  assert.equal(
    directory.getFile("unrecognized-user-file").text,
    "do not delete",
  );
  const before = f.stats.reads;
  assert.equal(r.read(2), undefined);
  assert.equal(f.stats.reads, before);
});
test("metadata validation rejects payload-bearing or malformed success envelopes", () => {
  const f = fixture(),
    w = f.writer();
  for (const value of [
    { ok: true, payload: "forbidden" },
    { ok: true, revision: -1 },
    { ok: false },
    { ok: false, error: { name: "Error", code: "has spaces" } },
  ])
    assert.throws(() => w.write(1, value), TypeError);
  w.dispose();
});
test("bounded scratch sweep deletes only old recognized marker directories", () => {
  const f = fixture(),
    root = f.fs.root.getDirectory("atlas-storage-receipts", { create: true });
  const old = root.getDirectory("A".repeat(43), { create: true }),
    recent = root.getDirectory("B".repeat(43), { create: true }),
    unknown = root.getDirectory("C".repeat(43), { create: true });
  old.getFile("r0", { create: true }).modified = new Date(
    Date.now() - 8 * 86400000,
  );
  recent.getFile("r0", { create: true });
  unknown.getFile("other.bin", { create: true }).modified = new Date(0);
  const w = f.writer();
  assert.equal(root.children.has(old.name), false);
  assert.equal(root.children.has(recent.name), true);
  assert.equal(root.children.has(unknown.name), true);
  w.dispose();
});

test("initialization failure zeroizes even a key allocated before the grant", () => {
  const f = fixture();
  let allocated;
  f.scope.crypto = {
    getRandomValues(value) {
      crypto.getRandomValues(value);
      allocated ??= value;
      return value;
    },
    randomUUID() {
      throw Error("Feature unavailable");
    },
  };
  assert.equal(f.writer(), null);
  assert.ok(allocated.every((value) => value === 0));
  assert.equal(f.fs.root.children.size, 0);
});
