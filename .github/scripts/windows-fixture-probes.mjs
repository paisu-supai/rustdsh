// Read-only baseline diagnostics; child test failures remain failures, never product acceptance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const complete = (status) => {
  assert.ok(Number.isInteger(status?.status) && !status.signal && !status.error && !status.killed, `Stop after incomplete child: ${JSON.stringify(status)}`);
  return status;
};
const completion = (error) => ({ status: error ? (Number.isInteger(error.code) ? error.code : null) : 0, signal: error?.signal ?? null, killed: error?.killed ?? false, error: error && !Number.isInteger(error.code) ? String(error) : null, message: error ? String(error) : null });
function traceExecFile(original, calls) {
  const record = ([file, args = [], options]) => {
    const command = args.indexOf("-Command");
    const call = { file, args, timeout: options?.timeout, oldMatcher: command >= 0 && /GetProcessById\(\d+\)/.test(args[command + 1]), nativeMatcher: file === process.execPath && path.basename(args[0] ?? "") === "process-identity-windows.mjs" };
    calls.push(call);
    return call;
  };
  const traced = (...args) => {
    const call = record(args), callback = args.at(-1);
    if (typeof callback === "function") args[args.length - 1] = (error, ...output) => { call.completion = completion(error); callback(error, ...output); };
    return original(...args);
  };
  const exec = promisify(original);
  traced[promisify.custom] = (...args) => {
    const call = record(args), promise = exec(...args);
    promise.then(() => { call.completion = completion(null); }, (error) => { call.completion = completion(error); });
    return promise; // Preserve the original Promise.child and rejection stdout/stderr.
  };
  return traced;
}
if (process.argv[2] === "--self-check") {
  for (const status of [{ status: null }, { status: 0, signal: "SIGTERM" }, { status: 0, error: "spawn failed" }, { status: 0, killed: true }]) assert.throws(() => complete(status));
  assert.equal(complete({ status: 1 }).status, 1); // A known test failure is still failed data, not uncertainty.
  const original = cp.execFile, calls = [], traced = traceExecFile(original, calls), marker = new Error("restore check");
  try {
    cp.execFile = traced; syncBuiltinESMExports();
    const promise = promisify(cp.execFile)(process.execPath, ["-e", "process.stdout.write('self-check')"], { timeout: 5000 });
    assert.ok(promise.child);
    assert.equal((await promise).stdout, "self-check");
    await assert.rejects(promisify(cp.execFile)(process.execPath, ["-e", "process.stdout.write('failed-data');process.exit(2)"], { timeout: 5000 }), (error) => error.code === 2 && error.stdout === "failed-data" && error.stderr === "");
    assert.deepEqual(calls.map((call) => complete(call.completion).status), [0, 2]);
    await assert.rejects(fs.mkdir(path.dirname(path.resolve(process.argv[1]))), { code: "EEXIST" });
    throw marker;
  } catch (error) { assert.equal(error, marker); }
  finally { cp.execFile = original; syncBuiltinESMExports(); }
  assert.equal(cp.execFile, original);
  console.log("PROBE_CONTROL_SELF_CHECK_PASS");
} else {
const [beforeRoot, afterRoot, directory] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(beforeRoot && afterRoot && directory && process.argv.length === 5);
const out = path.resolve(directory);
await fs.mkdir(out); // Refuse any preexisting output; do not overwrite earlier evidence.
const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-win-fixture-probe-"));
const root = await fs.realpath(rawRoot), parent = await fs.realpath(os.tmpdir());
assert.equal(path.dirname(root), parent);
assert.ok(path.basename(root).startsWith("rdsh-win-fixture-probe-"));
const report = { scope: "Unmodified baseline/candidate tests and bounded observation only; any failed test/probe remains failed data, not a product CI pass", complete: false, node: process.version, platform: process.platform, paths: {}, powershell: {}, identities: {}, tests: {} };
const capture = async (name, command, args, options = {}) => {
  const result = cp.spawnSync(command, args, { windowsHide: true, shell: false, timeout: 240000, maxBuffer: 8 * 1024 * 1024, ...options });
  await fs.writeFile(path.join(out, `${name}.stdout.log`), result.stdout ?? "", { flag: "wx" });
  await fs.writeFile(path.join(out, `${name}.stderr.log`), result.stderr ?? "", { flag: "wx" });
  const status = { status: result.status, signal: result.signal, error: result.error ? String(result.error) : null };
  await fs.writeFile(path.join(out, `${name}.status.json`), JSON.stringify(status) + "\n", { flag: "wx" });
  return complete(status);
};
try {
  const rawState = path.join(rawRoot, "state");
  await fs.mkdir(rawState);
  const ancestors = [];
  for (let current = rawState; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    ancestors.push({ path: current, realpath: await fs.realpath(current), symbolicLink: stat.isSymbolicLink() });
    if (path.dirname(current) === current) break;
  }
  report.paths = { TEMP: process.env.TEMP, TMP: process.env.TMP, tmpdir: os.tmpdir(), rawRoot, root, rawState, canonicalState: await fs.realpath(rawState), sameGuardPath: rawState.toLowerCase() === (await fs.realpath(rawState)).toLowerCase(), ancestors };
  const sentinel = path.join(root, "sentinel.json");
  await fs.writeFile(sentinel, "{}\n", { flag: "wx" });
  const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('PSVERSION='+$PSVersionTable.PSVersion.ToString())
[Console]::Out.WriteLine('PSEDITION='+$PSVersionTable.PSEdition)
[Console]::Out.WriteLine('BIT64='+[Environment]::Is64BitProcess)
[Console]::Out.WriteLine('PSMODULEPATH='+$env:PSModulePath)
$failed=$false
try { foreach($m in @(Get-Module -ListAvailable Microsoft.PowerShell.Security)) { [Console]::Out.WriteLine('MODULE='+$m.Path+';VERSION='+$m.Version+';EDITIONS='+($m.CompatiblePSEditions -join ',')) } } catch { [Console]::Out.WriteLine('MODULE_LIST_ERROR='+$_.Exception.ToString()); $failed=$true }
try { $acl=Get-Acl -LiteralPath $env:RDSH_QA_FILE; [Console]::Out.WriteLine('AUTOLOAD_ACL_OWNER='+$acl.Owner) } catch { [Console]::Out.WriteLine('AUTOLOAD_ERROR='+$_.ToString()+';EXCEPTION='+$_.Exception.ToString()); $failed=$true }
try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; [Console]::Out.WriteLine('EXPLICIT_IMPORT_OK'); $acl=Get-Acl -LiteralPath $env:RDSH_QA_FILE; [Console]::Out.WriteLine('EXPLICIT_ACL_OWNER='+$acl.Owner) } catch { [Console]::Out.WriteLine('IMPORT_ERROR='+$_.ToString()+';EXCEPTION='+$_.Exception.ToString()); if($_.Exception.InnerException) { [Console]::Out.WriteLine('INNER='+$_.Exception.InnerException.ToString()) }; $failed=$true }
if($failed) { exit 1 }
`;
  for (const mode of ["inherited", "without-PSModulePath"]) {
    const env = { ...process.env, RDSH_QA_FILE: sentinel };
    if (mode === "without-PSModulePath") for (const key of Object.keys(env)) if (/^PSModulePath$/i.test(key)) delete env[key];
    report.powershell[mode] = await capture(mode, powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env });
  }
  for (const [role, sourceRoot] of [["before", beforeRoot], ["after", afterRoot]]) {
    const original = cp.execFile, calls = [];
    cp.execFile = traceExecFile(original, calls);
    syncBuiltinESMExports();
    try {
      const identity = await import(pathToFileURL(path.join(sourceRoot, "dashboard/process-identity.mjs")));
      report.identities[role] = { result: await identity.readProcessIdentity(process.pid), calls };
      for (const call of calls) complete(call.completion);
      assert.ok(calls.some((call) => call.nativeMatcher), "Actual native helper was not observed");
      assert.equal(report.identities[role].result?.status, "observed", "Own-process identity is unknown; stop before subsequent tests");
    } finally { cp.execFile = original; syncBuiltinESMExports(); assert.equal(cp.execFile, original); }
    report.tests[role] = await capture(`${role}-unchanged-tests`, process.execPath, ["--test", "--test-concurrency=1", "test/private-json-file-windows.test.mjs", "test/process-scope-release.test.mjs", "test/review-evidence.test.mjs"], { cwd: path.join(sourceRoot, "dashboard") });
  }
  report.complete = true;
} catch (error) { report.error = String(error); }
finally {
  await fs.writeFile(path.join(out, "probes.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  assert.equal(path.dirname(await fs.realpath(root)), parent);
  assert.ok(path.basename(root).startsWith("rdsh-win-fixture-probe-"));
  await fs.rm(root, { recursive: true }); // Only this invocation's owned non-repository fixture.
}
assert.equal(report.complete, true, report.error);
console.log(JSON.stringify(report));
}
