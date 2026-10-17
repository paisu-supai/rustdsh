// CI-only real IO observation, not a replacement for six-client or whole-server tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [beforeRoot, afterRoot, output] = process.argv.slice(2);
assert.ok(beforeRoot && afterRoot && output && process.argv.length === 5);
const out = path.resolve(output);
assert.equal(await fs.stat(out).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; }), false);
const before = await import(pathToFileURL(path.join(path.resolve(beforeRoot), "dashboard/state.mjs")));
const after = await import(pathToFileURL(path.join(path.resolve(afterRoot), "dashboard/state.mjs")));
const parent = await fs.realpath(os.tmpdir());
const root = await fs.realpath(await fs.mkdtemp(path.join(parent, "rdsh-runtime-io-")));
assert.equal(path.dirname(root), parent);
assert.ok(path.basename(root).startsWith("rdsh-runtime-io-"));
const deadline = performance.now() + 90_000;
const check = () => assert.ok(performance.now() < deadline, "IO observation deadline exceeded");
const payload = "x".repeat(1024);
const value = (writer, seq) => ({ schema: 1, writer, seq, marker: `${writer}:${seq}`, payload });
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null; };
const report = { scope: "IO-only finite concurrent burst, not sustained contention or six stdio processes; readers may finish before later writes. Write failures remain data, never all-writes-passed", node: process.version, platform: process.platform, beforeRoot: path.resolve(beforeRoot), afterRoot: path.resolve(afterRoot), warmupsPerMode: 1, alternatingPairs: 7, results: [] };
try {
  for (const scenario of [{ name: "sequential", writers: 1, readers: 0 }, { name: "two-writers-four-readers", writers: 2, readers: 4 }]) {
    for (let pair = -1; pair < 7; pair++) {
      const order = pair % 2 === 0 ? ["before", "after"] : ["after", "before"];
      for (const version of order) {
        check();
        const file = path.join(root, `${scenario.name}-${pair}-${version}.json`);
        const write = version === "before" ? (v) => before.writeJson(file, v) : (v) => after.writeJson(file, v, { retryWindowsRename: true });
        const row = { scenario: scenario.name, pair, warmup: pair === -1, version, plannedWrites: scenario.writers * 200, plannedReads: scenario.readers * 400, writes: 0, reads: 0, writerFinishedMs: [], readerFinishedMs: [], writeErrors: [], readErrors: [], latenciesMs: [], successLatenciesMs: [] };
        report.results.push(row);
        await write(value(-1, -1));
        const started = performance.now();
        const writers = Array.from({ length: scenario.writers }, (_, writer) => (async () => {
          for (let seq = 0; seq < 200; seq++) {
            check();
            const begin = performance.now();
            try { await write(value(writer, seq)); row.writes++; row.successLatenciesMs.push(performance.now() - begin); }
            catch (error) { row.writeErrors.push({ writer, seq, code: error.code ?? error.name, message: error.message }); }
            row.latenciesMs.push(performance.now() - begin);
          }
          row.writerFinishedMs.push({ writer, milliseconds: performance.now() - started });
        })());
        const readers = Array.from({ length: scenario.readers }, (_, reader) => (async () => {
          for (let seq = 0; seq < 400; seq++) {
            check();
            try {
              const read = JSON.parse(await fs.readFile(file, "utf8"));
              assert.equal(read.schema, 1); assert.ok(Number.isInteger(read.writer) && Number.isInteger(read.seq));
              assert.equal(read.marker, `${read.writer}:${read.seq}`); assert.equal(read.payload, payload);
              row.reads++;
            } catch (error) { row.readErrors.push({ reader, seq, code: error.code ?? error.name, message: error.message }); }
          }
          row.readerFinishedMs.push({ reader, milliseconds: performance.now() - started });
        })());
        const settled = await Promise.allSettled([...writers, ...readers]);
        row.elapsedMs = performance.now() - started;
        row.deadlineErrors = settled.filter((item) => item.status === "rejected").map((item) => String(item.reason));
        row.latencyMs = Object.fromEntries([["p50", .5], ["p95", .95], ["p99", .99], ["max", 1]].map(([key, q]) => [key, quantile(row.latenciesMs, q)]));
      }
    }
  }
} catch (error) {
  report.fatalError = String(error);
} finally {
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  // Only this invocation's mkdtemp fixture, after every owned reader/writer settled.
  assert.equal(path.dirname(root), parent);
  assert.ok(path.basename(root).startsWith("rdsh-runtime-io-"));
  await fs.rm(root, { recursive: true });
}
console.log(JSON.stringify(report.results.filter((r) => !r.warmup).map((r) => ({ scenario: r.scenario, pair: r.pair, version: r.version, writes: r.writes, reads: r.reads, writeErrors: r.writeErrors.length, readErrors: r.readErrors.length, latencyMs: r.latencyMs }))));
assert.ok(!report.fatalError, report.fatalError);
for (const row of report.results) {
  assert.equal(row.deadlineErrors.length, 0);
  assert.equal(row.readErrors.length, 0);
  assert.equal(row.reads, row.plannedReads);
  assert.equal(row.writes + row.writeErrors.length, row.plannedWrites);
  assert.ok(row.writeErrors.every((error) => error.code === "EPERM"));
  if (row.scenario === "sequential") assert.equal(row.writeErrors.length, 0);
}
