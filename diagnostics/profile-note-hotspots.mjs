// Profiling of the actual functions in src/worker.ts; no application data is touched.
// Local Node timings are not Cloudflare request CPU measurements.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";

const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const names = [
  "byteLength", "collectSearchText", "cleanSearchTextValue", "normalizeSearchText",
  "truncateUtf8", "extractNoteSummary", "extractSearchTextFromBlocks",
  "normalizeBlocks", "parseStoredBlocks", "extractUploadIdsFromBlocks",
  "collectUploadIds", "extractUploadIdFromUrl", "collectPageLinkNoteIds", "isRecord",
  "materializeEmbeddedUploads", "hasEmbeddedUpload", "rewriteEmbeddedUploads", "isEmbeddableUrlKey",
  "parseEmbeddedDataUrl"
];
const declarations = [...source.matchAll(/^(?:async )?function (\w+)\b/gm)];
const extracted = names.map((name) => {
  const index = declarations.findIndex((entry) => entry[1] === name);
  if (index < 0) throw new Error(`Missing source function: ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}).join("\n");
const compiled = stripTypeScriptTypes(extracted, { mode: "strip" });
function loadFunctions(code) {
  return new Function(`const NOTE_SEARCH_TEXT_MAX_BYTES = 16384; const NOTE_SUMMARY_MAX_BYTES = 512;\n${code}\nreturn { ${names.join(", ")} };`)();
}
const context = loadFunctions(compiled);

const paragraph = "这是用于性能诊断的普通中文笔记内容，包含日常记录和课程整理。";
function makeBlocks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `block-${index}`, type: "paragraph",
    props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
    content: Array.from({ length: 4 }, () => ({ type: "text", text: paragraph, styles: {} })),
    children: []
  }));
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.floor(ordered.length / 2)].toFixed(3));
}
function measure(operation, repeats = 4) {
  operation();
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const started = performance.now();
    for (let repeat = 0; repeat < repeats; repeat++) operation();
    samples.push((performance.now() - started) / repeats);
  }
  return median(samples);
}
async function measureAsync(operation) {
  await operation();
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const rows = [];
for (const count of [20, 100, 300, 1000]) {
  const blocks = makeBlocks(count);
  const json = JSON.stringify(blocks);
  const ids = new Set();
  rows.push({
    blocks: count,
    jsonKiB: Number((Buffer.byteLength(json) / 1024).toFixed(1)),
    parseStoredBlocksMs: measure(() => context.parseStoredBlocks(json)),
    summaryMs: measure(() => context.extractNoteSummary(blocks)),
    searchIndexMs: measure(() => context.extractSearchTextFromBlocks(blocks)),
    uploadScanMs: measure(() => context.extractUploadIdsFromBlocks(blocks)),
    pageLinkScanMs: measure(() => { ids.clear(); context.collectPageLinkNoteIds(blocks, ids); }),
    embeddedRewriteMs: await measureAsync(() => context.materializeEmbeddedUploads({}, "diagnostic-user", blocks)),
    stringifyMs: measure(() => JSON.stringify(blocks))
  });
}

// Measure byte encoding work separately so counters do not affect timings above.
const instrumented = new Function(`
  const NOTE_SEARCH_TEXT_MAX_BYTES = 16384;
  const NOTE_SUMMARY_MAX_BYTES = 512;
  ${compiled.replace("function byteLength(", "function originalByteLength(")}
  let encodingCalls = 0;
  let encodedBytes = 0;
  function byteLength(value) {
    const length = originalByteLength(value);
    encodingCalls++;
    encodedBytes += length;
    return length;
  }
  return function(operation, blocks) {
    encodingCalls = 0;
    encodedBytes = 0;
    const functions = { extractNoteSummary, extractSearchTextFromBlocks };
    functions[operation](blocks);
    return { encodingCalls, encodedMiB: Number((encodedBytes / 1048576).toFixed(2)) };
  };
`)();
const encodingWork = [];
for (const count of [20, 100, 300, 1000]) {
  const blocks = makeBlocks(count);
  for (const name of ["extractNoteSummary", "extractSearchTextFromBlocks"]) {
    encodingWork.push({
      blocks: count, operation: name,
      ...instrumented(name, blocks)
    });
  }
}
const report = JSON.stringify({
  runtime: process.version,
  note: "Synthetic Chinese paragraphs; actual source functions; local elapsed ms, not production Worker CPU. No database, R2, network, auth or full request costs included. Seven samples, median, after a warm-up.",
  rows, encodingWork
}, null, 2);
if (process.argv[2]) writeFileSync(process.argv[2], `${report}\n`);
console.log(report);
