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
const worker = load(resolve(root, "src/worker.ts"), `\nexport { truncateUtf8, extractNoteSummary, extractSearchTextFromBlocks, extractUploadIdFromUrl, materializeEmbeddedUploads, readNoteContent, listNotes, createNote, updateNote, hydratePageLinkValue, rewriteValueForPublicShare, persistNoteContent, serializeNoteWithContent };`);
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
  assert.deepEqual((await response.json()).content, textBlocks("new"));
  const update = calls.find(([operation, sql]) => operation === "run" && sql.startsWith("UPDATE notes"));
  assert.equal(update[2].at(-1), row().updatedAt);
  assert.ok(calls.some(([operation]) => operation === "put"));
  assert.ok(calls.some(([operation]) => operation === "batch"));
  const raced = environment(row(), 0);
  await assert.rejects(worker.updateNote(patchRequest({ content: textBlocks("new") }), raced.env, "user", "note-one"), { status: 409 });
  assert.ok(raced.calls.some(([operation]) => operation === "delete"));
  assert.ok(!raced.calls.some(([operation]) => operation === "batch"));
});

test("saved content is serialized once and R2 bytes match the complete JSON response", async () => {
  const { env, calls } = environment();
  let serializations = 0;
  const content = [{ toJSON() { serializations++; return { text: '中文😀\\\"\n</script>', props: { nested: [null, true, 1] } }; } }];
  const persisted = await worker.persistNoteContent(env, "user", "note-one", content, true);
  const saved = { ...note(), title: '标题\\\"\n😀', content };
  const responseJson = worker.serializeNoteWithContent(saved, persisted.serializedContent);
  assert.equal(serializations, 1);
  const expectedContent = JSON.parse(persisted.serializedContent);
  assert.deepEqual(JSON.parse(responseJson), { ...saved, content: expectedContent });
  const encoded = calls.find(([operation]) => operation === "put")[2];
  assert.ok(encoded instanceof Uint8Array);
  assert.equal(encoded.byteLength, persisted.contentSize);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), expectedContent);
  const created = await worker.createNote(new Request("https://test/api/notes", {
    method: "POST", body: JSON.stringify({ title: "新页面", content: expectedContent })
  }), env, "user");
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).content, expectedContent);
  assert.match(created.headers.get("Content-Type"), /application\/json/);
  assert.equal(created.headers.get("Cache-Control"), "no-store");
});

function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

test("page-link hydration preserves unrelated branches and all nested link behavior without mutation", () => {
  const ordinary = textBlocks("正文")[0];
  const link = { type: "pageLink", props: { noteId: " linked ", title: "old", icon: "old", shareToken: "old", extra: 7 }, children: [] };
  const missing = { type: "pageLink", props: { noteId: "missing", title: "kept", shareToken: "kept" } };
  const content = freezeTree([ordinary, { type: "paragraph", children: [link, missing] }]);
  const summaries = new Map([["linked", { title: "new", icon: "📄", shareToken: null }]]);
  const hydrated = worker.hydratePageLinkValue(content, summaries, { publicView: true, publicRootShareToken: "root" });
  assert.equal(hydrated[0], ordinary);
  assert.notEqual(hydrated[1], content[1]);
  assert.deepEqual(hydrated[1].children[0].props, { ...link.props, title: "new", icon: "📄", shareToken: "", publicView: true, publicRootShareToken: "root" });
  assert.deepEqual(hydrated[1].children[1].props, { ...missing.props, publicView: true, publicRootShareToken: "root" });
  assert.equal(worker.hydratePageLinkValue(hydrated, summaries, { publicView: true, publicRootShareToken: "root" }), hydrated);
  const privateContent = worker.hydratePageLinkValue(hydrated, summaries, {});
  assert.equal(privateContent[1].children[0].props.publicView, false);
  assert.equal(privateContent[1].children[0].props.publicRootShareToken, "");
});

test("public sharing rewrites every nested private file URL while preserving ordinary branches", () => {
  const ordinary = textBlocks("普通文本")[0];
  const content = freezeTree([ordinary, { props: { url: "/api/files/abcd-1234" }, children: [
    { text: "https://test/api/files/other-5678 /api/files/abcd-1234", number: 1, absent: null }
  ] }]);
  const rewritten = worker.rewriteValueForPublicShare(content, "a b&");
  assert.equal(rewritten[0], ordinary);
  assert.equal(rewritten[1].props.url, "/api/public/files/abcd-1234?share=a%20b%26");
  assert.equal(rewritten[1].children[0].text, "https://test/api/public/files/other-5678?share=a%20b%26 /api/public/files/abcd-1234?share=a%20b%26");
  assert.equal(rewritten[1].children[0].number, 1);
  assert.equal(rewritten[1].children[0].absent, null);
  assert.equal(worker.rewriteValueForPublicShare(rewritten, "a b&"), rewritten);
  assert.equal(worker.rewriteValueForPublicShare([ordinary], "root")[0], ordinary);
});

test("attachment cleanup keeps retained/shared files, follows ref updates and reverses direction on a failed write", async () => {
  const previous = [{ url: "/api/files/keep-1234", children: [{ url: "/api/files/remove-1234" }, { url: "/api/files/shared-1234" }] }];
  const content = [{ url: "/api/files/keep-1234", children: [{ url: "/api/files/added-1234" }] }];
  for (const changes of [1, 0]) {
    const { env, calls } = environment({ ...row(), content: JSON.stringify(previous) }, changes);
    const prepare = env.DB.prepare;
    env.DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.includes("FROM notes")) statement.first = async () => {
        calls.push(["lookup", sql, statement.values]);
        const id = statement.values.find((value) => typeof value === "string" && /^(remove|shared|added)-1234$/.test(value));
        if (sql.includes("FROM note_upload_refs")) return id === "shared-1234" ? { noteId: "other" } : null;
        if (sql.includes("FROM uploads")) return { objectKey: `upload/${id}` };
        return null;
      };
      else {
        const first = statement.first;
        statement.first = async () => sql.includes("content LIKE") ? null : first();
      }
      return statement;
    };
    const save = worker.updateNote(patchRequest({ content }), env, "user", "note-one");
    if (changes) await save; else await assert.rejects(save, { status: 409 });
    const deleted = calls.filter(([operation, key]) => operation === "delete" && key.startsWith("upload/"));
    assert.deepEqual(deleted.map(([, key]) => key), [changes ? "upload/remove-1234" : "upload/added-1234"]);
    if (changes) {
      const refBatch = calls.find(([operation]) => operation === "batch");
      assert.deepEqual(refBatch[1].slice(1).map((statement) => statement.values[2]), ["keep-1234", "added-1234"]);
      assert.ok(calls.indexOf(refBatch) < calls.indexOf(deleted[0]));
    }
  }
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
