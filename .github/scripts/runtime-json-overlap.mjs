// CI-only saturated single-writer storage diagnostic, not six stdio clients or a new acceptance gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const payload = "x".repeat(1024), plannedWrites = 200;
const value = (row, seq) => ({ schema: 1, row, seq, marker: `${row}:${seq}`, payload });
const validate = (document, row) => {
  assert.equal(document.schema, 1); assert.equal(document.row, row);
  assert.ok(Number.isInteger(document.seq) && document.seq >= -1 && document.seq < plannedWrites);
  assert.equal(document.marker, `${row}:${document.seq}`); assert.equal(document.payload, payload);
};
validate(value("self", 0), "self");
for (const bad of [{ ...value("self", 0), row: "other" }, { ...value("self", 0), seq: 200 }, { ...value("self", 0), payload: "torn" }, { ...value("self", 0), marker: "corrupt" }]) assert.throws(() => validate(bad, "self"));
// Native trace timestamps share process.hrtime's clock, in integer microseconds (Node v22 tracing docs).
const microseconds = () => { const time = Number(process.hrtime.bigint() / 1000n); assert.ok(Number.isSafeInteger(time)); return time; };
const [beforeRoot, afterRoot, output] = process.argv.slice(2);
assert.ok(beforeRoot && afterRoot && output && process.argv.length === 5);
const out = path.resolve(output);
assert.equal(await fs.stat(out).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }), false);
const fingerprint = async (directory) => {
  const files = {};
  for (const name of ["dashboard/state.mjs", "dashboard/runtime-json-rename.mjs"]) {
    try { files[name] = createHash("sha256").update(await fs.readFile(path.join(path.resolve(directory), name))).digest("hex"); }
    catch (error) { if (error.code !== "ENOENT") throw error; files[name] = null; }
  }
  return files;
};
const identity = { before: await fingerprint(beforeRoot), after: await fingerprint(afterRoot) };
const modules = { before: await import(pathToFileURL(path.join(path.resolve(beforeRoot), "dashboard/state.mjs"))), after: await import(pathToFileURL(path.join(path.resolve(afterRoot), "dashboard/state.mjs"))) };
const parent = await fs.realpath(os.tmpdir());
const root = await fs.realpath(await fs.mkdtemp(path.join(parent, "rdsh-runtime-overlap-")));
assert.equal(path.dirname(root), parent);
const file = path.join(root, "runtime.json"), deadline = performance.now() + 90_000;
const check = () => assert.ok(performance.now() < deadline, "Single-writer diagnostic admission deadline exceeded");
const report = { scope: "One writer and zero/four same-process async readers at 2ms cadence, not a normal polling cadence or end-to-end stdio benchmark. All rows reuse the same owned output path. Instrumented results are separate from untraced acceptance data; failed writes remain failed data.", node: process.version, platform: process.platform, pid: process.pid, beforeRoot, afterRoot, identity, sourceFilesUnchanged: false, alternatingPairs: 8, warmupsPerMode: 1, results: [], complete: false };
try {
  for (const readers of [0, 4]) for (let pair = -1; pair < 8; pair++) for (const version of (pair % 2 === 0 ? ["before", "after"] : ["after", "before"])) {
    check();
    const label = `${readers}:${pair}:${version}`;
    const row = { label, readers, pair, version, warmup: pair === -1, plannedWrites, operations: [], writes: 0, writeErrors: [], readErrors: [], readerStats: [], lastSuccessfulSeq: -1 };
    report.results.push(row);
    const write = (seq) => modules[version].writeJson(file, value(label, seq), version === "after" ? { retryWindowsRename: true } : undefined);
    await write(-1); // Fixture seed, with no reader active; never counted as a measured publish.
    let stopped = false, tasks = [];
    const read = async (stats, final = false) => {
      check(); const beginUs = microseconds();
      const document = JSON.parse(await fs.readFile(file, "utf8")); validate(document, label);
      assert.ok(document.seq >= stats.lastSeq, "Single-writer observations moved backwards");
      stats.lastSeq = document.seq; stats.reads++;
      if (row.firstWriteUs !== undefined && row.lastWriteUs === undefined) stats.duringWrites++;
      if (final) { stats.finalReadBeginUs = beginUs; stats.finalReadEndUs = microseconds(); stats.finalSeq = document.seq; }
      else if (stats.firstReadBeginUs === undefined) stats.firstReadBeginUs = beginUs;
    };
    try {
      row.readerStats = Array.from({ length: readers }, (_, reader) => ({ reader, reads: 0, duringWrites: 0, lastSeq: -1 }));
      const initial = await Promise.allSettled(row.readerStats.map((stats) => read(stats)));
      for (const result of initial) if (result.status === "rejected") row.readErrors.push(String(result.reason));
      assert.equal(row.readErrors.length, 0);
      tasks = row.readerStats.map((stats) => (async () => {
        try {
          while (!stopped) { await read(stats); await delay(2); }
          await read(stats, true); // A fresh open after the writer finishes, not merely a seed read.
        } catch (error) { row.readErrors.push(String(error)); }
      })());
      row.firstWriteUs = microseconds();
      for (let seq = 0; seq < plannedWrites; seq++) {
        check(); assert.equal(row.readErrors.length, 0);
        const operation = { seq, beginUs: microseconds(), code: null }, begin = performance.now();
        let unexpected;
        try { await write(seq); row.writes++; row.lastSuccessfulSeq = seq; }
        catch (error) { operation.code = error.code ?? error.name; row.writeErrors.push({ seq, code: operation.code, message: error.message }); if (operation.code !== "EPERM") unexpected = error; }
        finally { operation.milliseconds = performance.now() - begin; operation.endUs = microseconds(); row.operations.push(operation); }
        if (unexpected) throw unexpected;
      }
      row.lastWriteUs = microseconds();
    } finally {
      stopped = true;
      const settled = await Promise.allSettled(tasks);
      for (const result of settled) if (result.status === "rejected") row.readErrors.push(String(result.reason));
    }
    assert.equal(row.operations.length, plannedWrites); assert.equal(row.writes + row.writeErrors.length, plannedWrites);
    assert.equal(row.readErrors.length, 0);
    for (const stats of row.readerStats) {
      assert.ok(stats.firstReadBeginUs <= row.firstWriteUs && stats.duringWrites > 0);
      assert.ok(stats.finalReadBeginUs >= row.lastWriteUs);
      assert.equal(stats.finalSeq, row.lastSuccessfulSeq);
    }
  }
  assert.deepEqual({ before: await fingerprint(beforeRoot), after: await fingerprint(afterRoot) }, identity, "Runtime source files changed during observation");
  report.sourceFilesUnchanged = true;
  report.complete = true;
} catch (error) { report.fatalError = String(error); }
finally {
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith("rdsh-runtime-overlap-"));
  await fs.rm(root, { recursive: true }); // Only this invocation's fixture, after every owned reader settles.
}
console.log(JSON.stringify({ complete: report.complete, rows: report.results.length, writeFailures: report.results.reduce((count, row) => count + row.writeErrors.length, 0), fatalError: report.fatalError }));
assert.equal(report.complete, true, report.fatalError);
