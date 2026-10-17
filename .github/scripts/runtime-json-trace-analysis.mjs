// Interpret Node's native FS trace without replacing fs, timers, performance.now or product code.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getSystemErrorName } from "node:util";
const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] : null;
assert.equal(quantile([], .95), null); assert.equal(quantile(Array.from({ length: 20 }, (_, i) => i + 1), .95), 19);
const methods = new Set(["mkdir", "open", "write", "close", "rename", "unlink"]);
function pairs(events, include = () => true) {
  const pending = new Map(), records = [];
  for (const event of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!event.cat?.includes("node.fs.async")) continue;
    const key = `${event.pid}:${event.tid}:${event.id}`;
    if (event.ph === "b") { if (!methods.has(event.name) || !include(event)) continue; assert.equal(pending.has(key), false); pending.set(key, event); }
    else if (event.ph === "e") {
      const begin = pending.get(key);
      if (!begin) { if (methods.has(event.name)) assert.equal(include(event), false, "Unpaired measured native FS completion"); continue; }
      pending.delete(key);
      assert.ok(event.ts >= begin.ts && Number.isInteger(event.args?.result));
      const method = begin.name === event.name ? event.name : `${begin.name}->${event.name}`;
      records.push({ method, beginUs: begin.ts, endUs: event.ts, milliseconds: (event.ts - begin.ts) / 1000, result: event.args.result, args: begin.args });
    }
  }
  assert.equal(pending.size, 0, "Incomplete native FS trace");
  return records.sort((a, b) => a.beginUs - b.beginUs);
}
const synthetic = [{ cat: "node.fs.async", name: "rename", pid: 1, tid: 1, id: "x", ph: "b", ts: 10, args: {} }, { cat: "node.fs.async", name: "rename", pid: 1, tid: 1, id: "x", ph: "e", ts: 30, args: { result: 0 } }];
assert.equal(pairs(synthetic)[0].milliseconds, .02); assert.throws(() => pairs(synthetic.slice(0, 1))); assert.throws(() => pairs(synthetic.slice(1)));
assert.equal(pairs([{ ...synthetic[0], name: "unlink" }, { ...synthetic[1], name: "stat" }])[0].method, "unlink->stat");
const [sourceFile, traceDirectory, output] = process.argv.slice(2);
assert.ok(sourceFile && traceDirectory && output && process.argv.length === 5);
const source = JSON.parse(await fs.readFile(sourceFile, "utf8"));
assert.equal(source.complete, true); assert.equal(source.platform, "win32"); assert.equal(process.platform, source.platform); assert.equal(source.sourceFilesUnchanged, true); assert.equal(source.results.length, 36);
const names = (await fs.readdir(traceDirectory)).filter((name) => /^native-\d+-\d+\.json$/.test(name));
assert.ok(names.length > 0 && names.length <= 8);
const events = [];
for (const name of names) {
  const file = path.join(traceDirectory, name); assert.ok((await fs.stat(file)).size < 128 * 1024 * 1024);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(data.traceEvents.every((event) => event.pid === source.pid));
  for (const event of data.traceEvents) events.push(event);
}
const scopes = source.results.flatMap((row) => row.operations.map((operation) => ({ ...operation, readers: row.readers })));
// Only measured write scopes, not imports, seeds, report output or recursive cleanup.
// Pair by native request ID, not method: local Node24 recursive mkdir emitted unlink->stat.
// Preserve such raw labels rather than claiming that the product unlinked its directory.
const measured = (event) => {
  let low = 0, high = scopes.length - 1;
  while (low <= high) { const middle = (low + high) >>> 1; if (scopes[middle].beginUs <= event.ts) low = middle + 1; else high = middle - 1; }
  const scope = scopes[high];
  return Boolean(scope && event.ts <= scope.endUs && (!scope.readers || !["open", "close"].includes(event.name)));
};
assert.equal(pairs([...synthetic, ...synthetic.map((event) => ({ ...event, ts: event.ts + 100 }))], (event) => event.ts < 50).length, 1);
const records = pairs(events, measured), rows = []; let cursor = 0;
for (const row of source.results) {
  const operations = [];
  for (const operation of row.operations) {
    while (cursor < records.length && records[cursor].beginUs < operation.beginUs) cursor++;
    const native = [];
    while (cursor < records.length && records[cursor].beginUs <= operation.endUs) {
      const record = records[cursor++];
      if (row.readers && ["open", "close"].includes(record.method)) continue; // Reader handles cannot be attributed to the writer from this category.
      assert.ok(record.endUs <= operation.endUs, "Native FS clock/scope mismatch"); native.push(record);
    }
    const renames = native.filter((record) => record.method === "rename");
    assert.ok(renames.length <= (row.version === "after" ? 6 : 1));
    if (operation.code === null) assert.equal(renames.at(-1)?.result, 0, "Successful publish missing its native rename");
    if (renames.length) {
      assert.equal(new Set(renames.map((record) => record.args.old_path)).size, 1);
      assert.equal(new Set(renames.map((record) => record.args.new_path)).size, 1);
      assert.ok(renames.every((record) => typeof record.args.old_path === "string" && typeof record.args.new_path === "string"));
      assert.ok(native.filter((record) => record.method === "write").every((record) => record.endUs <= renames[0].beginUs), "Write replay observed after rename started");
      assert.ok(renames.slice(0, -1).every((record) => getSystemErrorName(record.result) === "EPERM"));
    }
    const nativeMs = Object.fromEntries([...new Set([...methods, ...native.map((record) => record.method)])].filter((method) => !row.readers || !["open", "close"].includes(method)).map((method) => [method, native.filter((record) => record.method === method).reduce((sum, record) => sum + record.milliseconds, 0)]));
    operations.push({ label: row.label, ...operation, nativeMs, unattributedMs: operation.milliseconds - Object.values(nativeMs).reduce((a, b) => a + b, 0), renames: renames.map((record, i) => ({ milliseconds: record.milliseconds, result: record.result, code: record.result < 0 ? getSystemErrorName(record.result) : null, gapSincePreviousMs: i ? (record.beginUs - renames[i - 1].endUs) / 1000 : null })) });
  }
  rows.push({ ...row, operations });
}
const summaries = [];
for (const readers of [0, 4]) for (const version of ["before", "after"]) {
  const selected = rows.filter((row) => !row.warmup && row.readers === readers && row.version === version);
  assert.equal(selected.length, 8);
  const operations = selected.flatMap((row) => row.operations);
  summaries.push({ readers, version, attempted: operations.length, successes: operations.filter((op) => op.code === null).length, failures: operations.filter((op) => op.code !== null).length, pooledP95: quantile(operations.map((op) => op.milliseconds), .95), pooledP99: quantile(operations.map((op) => op.milliseconds), .99), pairP95: selected.map((row) => ({ pair: row.pair, p95: quantile(row.operations.map((op) => op.milliseconds), .95) })), tail: [...operations].sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 10) });
}
const report = { scope: "Trace-only diagnostic; overhead can change scheduling/admission. Native gaps include retry delay plus scheduling, not timer-only time. Open/close belong to the writer only in reader-free controls; remaining time is not proven JS overhead. No new latency gate and no pooling with untraced results.", node: source.node, pid: source.pid, identity: source.identity, sourceFilesUnchanged: source.sourceFilesUnchanged, traceFiles: names, summaries, results: rows };
await fs.writeFile(path.resolve(output), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(summaries.map(({ tail, pairP95, ...summary }) => summary)));
