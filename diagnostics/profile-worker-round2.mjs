// Compare actual pre/post worker functions in the same process with alternating samples.
// Usage: node diagnostics/profile-worker-round2.mjs BASELINE_WORKER OUTPUT_JSON
// Storage is mocked; these are local elapsed times, not production Workers CPU.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const functions = "hydratePageLinkValue, rewriteValueForPublicShare, updateNote";
const cache = new Map();
function load(file, extra = "") {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = readFileSync(file, "utf8").replace(/\bimport\.meta\b/g, "({})") + extra;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "module", "exports", compiled)(specifier =>
    load(resolve(dirname(file), `${specifier}.ts`)), module, module.exports);
  return module.exports;
}
if (!process.argv[2] || !process.argv[3]) throw new Error("Provide baseline worker and output JSON paths");
const before = load(resolve(process.argv[2]), `\nexport { ${functions} };`);
const after = load(resolve(root, "src/worker.ts"), `\nexport { ${functions} };`);
const paragraph = "这是用于性能诊断的普通中文笔记内容，包含日常记录和课程整理。";
function blocks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `block-${index}`, type: "paragraph",
    props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
    content: Array.from({ length: 4 }, () => ({ type: "text", text: paragraph, styles: {} })), children: []
  }));
}
function save(worker, content) {
  const serialized = JSON.stringify(content);
  const current = { id: "note-one", title: "标题", icon: "📝", kind: "page", titleSize: "h1",
    titleSegments: "[]", parentId: null, isArchived: 0, shareToken: null, sharedAt: null,
    sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    content: "[]", contentKey: "previous.json" };
  const env = {
    DB: { prepare() { return { bind() { return this; }, async first() { return current; },
      async run() { return { meta: { changes: 1 } }; } }; }, async batch() { return []; } },
    FILES: { async get() { return { async text() { return serialized; } }; }, async put() {}, async delete() {} }
  };
  const body = JSON.stringify({ content, expectedUpdatedAt: current.updatedAt });
  return async () => {
    const response = await worker.updateNote(new Request("https://test/api/notes/note-one", { method: "PATCH", body }), env, "user", "note-one");
    // Consume encoding and response work too; no network or real storage is involved.
    await response.arrayBuffer();
  };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function compare(beforeOp, afterOp, repeats = 5) {
  for (let i = 0; i < 16; i++) { await beforeOp(); await afterOp(); }
  const samples = { before: [], after: [] };
  for (let sample = 0; sample < 13; sample++) {
    const entries = [["before", beforeOp], ["after", afterOp]];
    if (sample % 2) entries.reverse();
    for (const [name, op] of entries) {
      const started = performance.now();
      for (let repeat = 0; repeat < repeats; repeat++) await op();
      samples[name].push((performance.now() - started) / repeats);
    }
  }
  const beforeMs = median(samples.before), afterMs = median(samples.after);
  return { beforeMs: +beforeMs.toFixed(3), afterMs: +afterMs.toFixed(3), reductionPercent: +((1 - afterMs / beforeMs) * 100).toFixed(1) };
}
const rows = [];
for (const count of [100, 1000]) {
  const content = blocks(count);
  const withLink = [...content, { type: "pageLink", props: { noteId: "linked", title: "old" }, children: [] }];
  const summaries = new Map([["linked", { id: "linked", title: "新标题", icon: "📄", shareToken: null }]]);
  assert.deepEqual(after.hydratePageLinkValue(withLink, summaries, {}), before.hydratePageLinkValue(withLink, summaries, {}));
  assert.deepEqual(after.rewriteValueForPublicShare(content, "token"), before.rewriteValueForPublicShare(content, "token"));
  rows.push({ blocks: count, jsonKiB: +(Buffer.byteLength(JSON.stringify(content)) / 1024).toFixed(1),
    pageLinkHydration: await compare(() => before.hydratePageLinkValue(withLink, summaries, {}), () => after.hydratePageLinkValue(withLink, summaries, {})),
    publicShareRewrite: await compare(() => before.rewriteValueForPublicShare(content, "token"), () => after.rewriteValueForPublicShare(content, "token")),
    saveWithMockStorage: await compare(save(before, content), save(after, content), 3)
  });
}
const result = { runtime: process.version,
  baselineWorkerSha256: createHash("sha256").update(readFileSync(resolve(process.argv[2]))).digest("hex"),
  optimizedWorkerSha256: createHash("sha256").update(readFileSync(resolve(root, "src/worker.ts"))).digest("hex"),
  note: "Actual worker functions, synthetic Chinese paragraphs, mocked D1/R2. Local elapsed ms, NOT production Workers CPU; excludes authentication, real I/O and network. 16 paired warm-ups, 13 alternating samples, medians. Save includes request parsing and consuming response bytes. Do not infer a safe document size or eliminate 1102 from these numbers.", rows };
writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
