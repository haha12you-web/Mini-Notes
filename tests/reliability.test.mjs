import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Load the actual TypeScript sources under Node 22 as well as newer runtimes.
// Internal worker functions are exported only in this in-memory test module.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();
function load(file, extra = "") {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = readFileSync(file, "utf8").replace(/\bimport\.meta\b/g, "({})") + extra;
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } }).outputText;
  new Function("require", "module", "exports", compiled)((specifier) =>
    load(resolve(dirname(file), `${specifier}.ts`)), module, module.exports);
  return module.exports;
}
const worker = load(resolve(root, "src/worker.ts"), `\nexport { truncateUtf8, extractNoteSummary, extractSearchTextFromBlocks, extractUploadIdFromUrl, materializeEmbeddedUploads, readNoteContent, listNotes, updateNote };`);
const drafts = load(resolve(root, "src/localDrafts.ts"));
const textBlocks = (text) => [{ type: "paragraph", content: [{ type: "text", text }] }];

test("UTF-8 truncation preserves whole code points at every boundary", () => {
  for (const text of ["hello", "中文测试", "a😀中é", "\ud800z", "👨‍👩‍👧‍👦"]) {
    for (let limit = 0; limit <= Buffer.byteLength(text) + 1; limit++) {
      let expected = "";
      for (const point of text) {
        if (Buffer.byteLength(expected + point) > limit) break;
        expected += point;
      }
      assert.equal(worker.truncateUtf8(text, limit), expected);
    }
  }
});

test("summary/index omit structural fields and URLs, normalize whitespace and obey byte budgets", () => {
  const blocks = [{ id: "hidden", type: "hidden", props: { url: "hidden", href: "hidden", src: "hidden" },
    content: [{ text: "  第一行\n 第二行 " }, { text: "https://example.com/private" }, { text: "data:image/png;base64,abc" }] }];
  assert.equal(worker.extractNoteSummary(blocks), "第一行 第二行");
  assert.equal(worker.extractSearchTextFromBlocks(blocks), "第一行 第二行");
  const long = Array.from({ length: 1000 }, () => ({ text: "中😀".repeat(300) }));
  assert.ok(Buffer.byteLength(worker.extractNoteSummary(long)) <= 512);
  assert.ok(Buffer.byteLength(worker.extractSearchTextFromBlocks(long)) <= 16384);
  const failIfVisited = { get text() { throw new Error("traversed past the byte budget"); } };
  assert.equal(worker.extractNoteSummary([{ text: "a".repeat(1000) }, failIfVisited]), "a".repeat(512));
  worker.extractSearchTextFromBlocks([...Array.from({ length: 17 }, () => ({ text: "a".repeat(1000) })), failIfVisited]);
});

test("file URL fast path preserves supported private/public/absolute URL references", () => {
  for (const url of ["/api/files/abcd-1234", "https://example.com/api/files/abcd-1234?download=1", "/api/public/files/abcd-1234?share=secret"]) {
    assert.equal(worker.extractUploadIdFromUrl(url), "abcd-1234");
  }
  for (const url of ["ordinary body text", "https://example.com/x", "/api/files/short", "/api/files/abcd-1234/extra"]) {
    assert.equal(worker.extractUploadIdFromUrl(url), null);
  }
});

test("ordinary saves bypass embedded upload rewriting without cloning or I/O", async () => {
  const blocks = textBlocks("普通正文");
  assert.equal(await worker.materializeEmbeddedUploads({}, "user", blocks), blocks);
});

const row = () => ({ id: "note-one", title: "title", icon: "📝", kind: "page", titleSize: "h1",
  titleSegments: "[]", parentId: null, isArchived: 0, shareToken: null, sharedAt: null, sortOrder: 1,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", content: JSON.stringify(textBlocks("old")), contentKey: null });
function environment(current = row(), changes = 1) {
  const calls = [];
  const env = {
    DB: { prepare(sql) {
      return { sql, values: [], bind(...values) { this.values = values; return this; },
        async first() { calls.push(["first", sql]); return current; },
        async all() { calls.push(["all", sql]); return { results: [current] }; },
        async run() { calls.push(["run", sql, this.values]); return { meta: { changes } }; }
      };
    }, async batch(statements) { calls.push(["batch", statements]); return []; } },
    FILES: { async get() { throw new Error("unexpected read"); }, async put(...args) { calls.push(["put", ...args]); }, async delete(...args) { calls.push(["delete", ...args]); } }
  };
  return { env, calls };
}
const patchRequest = (body) => new Request("https://test/api/notes/note-one", { method: "PATCH", body: JSON.stringify(body) });

test("list and legacy content reads perform no migration writes", async () => {
  const { env, calls } = environment();
  assert.deepEqual(await worker.readNoteContent(env, row(), "user"), textBlocks("old"));
  const response = await worker.listNotes(env, "user");
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(([operation]) => operation), ["all"]);
});

test("a stale client version is rejected before any body read/write or cleanup", async () => {
  const { env, calls } = environment();
  await assert.rejects(worker.updateNote(patchRequest({ expectedUpdatedAt: "stale", content: [] }), env, "user", "note-one"), { status: 409 });
  assert.deepEqual(calls.map(([operation]) => operation), ["first"]);
});

test("metadata-only save avoids rewriting R2 content and returns full content", async () => {
  const { env, calls } = environment();
  const response = await worker.updateNote(patchRequest({ title: "new", expectedUpdatedAt: row().updatedAt }), env, "user", "note-one");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).content, textBlocks("old"));
  assert.ok(!calls.some(([operation]) => operation === "put" || operation === "delete" || operation === "batch"));
  const update = calls.find(([operation, sql]) => operation === "run" && sql.startsWith("UPDATE notes"));
  assert.match(update[1], /AND updated_at = \?/);
  assert.equal(update[2].at(-1), row().updatedAt);
});

test("content save persists R2, guards concurrent DB updates and updates attachment refs", async () => {
  const { env, calls } = environment();
  const response = await worker.updateNote(patchRequest({ content: textBlocks("new"), expectedUpdatedAt: row().updatedAt }), env, "user", "note-one");
  assert.equal(response.status, 200);
  const update = calls.find(([operation, sql]) => operation === "run" && sql.startsWith("UPDATE notes"));
  assert.equal(update[2].at(-1), row().updatedAt);
  assert.ok(calls.some(([operation]) => operation === "put"));
  assert.ok(calls.some(([operation]) => operation === "batch"));
  const raced = environment(row(), 0);
  await assert.rejects(worker.updateNote(patchRequest({ content: textBlocks("new") }), raced.env, "user", "note-one"), { status: 409 });
  assert.ok(raced.calls.some(([operation]) => operation === "delete"));
  assert.ok(!raced.calls.some(([operation]) => operation === "batch"));
});

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const note = () => ({ ...row(), titleSegments: [], content: textBlocks("local") });
test("draft recovery survives reload, is account scoped, and an old ack cannot remove newer edits", () => {
  const local = storage();
  const first = drafts.writeLocalDraft("alice", note(), local);
  const second = drafts.writeLocalDraft("alice", { ...note(), title: "newer" }, local);
  drafts.removeLocalDraft("alice", "note-one", first, local);
  assert.equal(drafts.readLocalDraft("alice", "note-one", local).note.title, "newer");
  assert.equal(drafts.readLocalDraft("bob", "note-one", local), null);
  assert.equal(drafts.lastLocalDraftId("alice", local), "note-one");
  drafts.removeLocalDraft("alice", "note-one", second, local);
  assert.equal(drafts.readLocalDraft("alice", "note-one", local), null);
  assert.equal(drafts.lastLocalDraftId("alice", local), null);
});

test("storage errors are surfaced and only transient save errors are retryable", () => {
  assert.throws(() => drafts.writeLocalDraft("user", note(), { setItem() { throw new Error("quota"); } }), /quota/);
  for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(drafts.retryableSaveStatus(status), true);
  for (const status of [400, 401, 403, 404, 409, 413, 499]) assert.equal(drafts.retryableSaveStatus(status), false);
});
