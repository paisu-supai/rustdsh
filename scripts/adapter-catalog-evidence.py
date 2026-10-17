"""Verification-only: same-machine legacy CLI / native CLI / qualified Node bridge."""
import argparse
import base64
import hashlib
import json
import os
import math
import platform
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import http.client
import re
import socket


def clean_environment():
    return {key: value for key, value in os.environ.items() if not key.startswith(("DSH_", "RDSH_")) and (key.startswith("GIT_CONFIG_KEY_") or not re.search(r"KEY|SECRET|TOKEN|PASSWORD", key, re.I)) and key not in ("NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE")}


def windows_counters(child):
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in ("peak", "working", "quota_peak_paged", "quota_paged", "quota_peak_nonpaged", "quota_nonpaged", "pagefile", "peak_pagefile")]
    api = ctypes.WinDLL("psapi", use_last_error=True)
    api.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    api.GetProcessMemoryInfo.restype = wintypes.BOOL
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    if not api.GetProcessMemoryInfo(wintypes.HANDLE(int(child._handle)), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return counters


def resident_bytes(child):
    assert child.poll() is None, "Server exited before resident measurement"
    if sys.platform == "win32":
        value = windows_counters(child).working
    elif sys.platform == "linux":
        status = Path(f"/proc/{child.pid}/status").read_text()
        value = int(next(row for row in status.splitlines() if row.startswith("VmRSS:")).split()[1]) * 1024
    else:
        assert sys.platform == "darwin"
        value = int(subprocess.run(["ps", "-o", "rss=", "-p", str(child.pid)], check=True, capture_output=True, timeout=2).stdout.strip()) * 1024
    assert value > 0 and child.poll() is None, "No live primary RSS measurement"
    return value


def server_one(node, entry, asset, environment, startup_seconds=30):
    # Same real project-server invocation as the unchanged locale suite; no API authentication or model request.
    temporary = Path(tempfile.mkdtemp(prefix="rdsh-server-bench-")).resolve()
    child = None
    try:
        project = temporary / "project"
        project.mkdir()
        env = dict(environment)
        for key in ("HOME", "USERPROFILE", "DSH_HOME", "RDSH_DASHBOARD_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"):
            location = temporary / key
            location.mkdir()
            env[key] = str(location)
        env.update(RDSH_ORIG_BIN=str(temporary / "missing-dsh"), DSH_ORIG_BIN=str(temporary / "missing-dsh"))
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        url = f"http://127.0.0.1:{port}/"
        stdout, stderr = temporary / "stdout", temporary / "stderr"
        started = time.perf_counter()
        with stdout.open("wb") as out, stderr.open("wb") as err:
            child = subprocess.Popen([node, str(entry), "project", "--project", str(project), "--port", str(port), "--no-tailscale", "--language", "en"], cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            def get(route):
                before = time.perf_counter()
                connection.request("GET", route)
                response = connection.getresponse()
                body = response.read(2 * 1024 * 1024 + 1)
                elapsed = (time.perf_counter() - before) * 1000
                assert response.status == 200 and len(body) <= 2 * 1024 * 1024, "Public read did not succeed"
                if route == "/":
                    assert b'lang="en"' in body and b'data-rdsh-locale="en"' in body, "Not the expected real server HTML"
                else:
                    assert body == asset, "Public asset bytes changed"
                return elapsed
            try:
                while True:
                    assert child.poll() is None, "Server exited before readiness"
                    assert stdout.stat().st_size <= 65536 and stderr.stat().st_size <= 65536, "Unexpected startup output size"
                    assert time.perf_counter() - started < startup_seconds, "Real server readiness deadline"
                    with stdout.open("rb") as reader:
                        own_start = url.encode() in reader.read(65536)
                    if own_start:
                        try:
                            get("/")
                            assert time.perf_counter() - started < startup_seconds, "Late successful readiness response exceeded deadline"
                            break
                        except (ConnectionError, OSError, http.client.HTTPException):
                            connection.close()
                    time.sleep(.02)
                startup_ms = (time.perf_counter() - started) * 1000
                time.sleep(1)
                rss = resident_bytes(child)
                for _ in range(3):
                    get("/")
                    get("/app.mjs")
                timings = {"/": [], "/app.mjs": []}
                for _ in range(10):
                    for route in timings:
                        timings[route].append(get(route))
                assert child.poll() is None and stderr.stat().st_size == 0, "Server exited or emitted unexpected stderr"
                return {"startupMs": startup_ms, "residentBytes": rss, "rootMedianMs": statistics.median(timings["/"]), "assetMedianMs": statistics.median(timings["/app.mjs"]), "httpSamplesMs": timings}
            finally:
                connection.close()
    finally:
        if child is not None:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        # Failed reap leaves the owned fixture intact rather than deleting live state.
        assert temporary.parent == Path(tempfile.gettempdir()).resolve() and temporary.name.startswith("rdsh-server-bench-")
        shutil.rmtree(temporary)


# Fixed before measurement; use the larger relative/absolute allowance.
SERVER_ALLOWANCES = {"startupMs": (.10, 50), "residentBytes": (.10, 8 * 1024 * 1024), "rootMedianMs": (.20, 1), "assetMedianMs": (.20, 1)}


def server_regressions(medians):
    regressions = []
    for key, (relative, absolute) in SERVER_ALLOWANCES.items():
        baseline = medians["legacyNodeServer"][key]
        if medians["qualifiedNodeServer"][key] > baseline + max(baseline * relative, absolute):
            regressions.append(key)
    return regressions


def server_comparison(node, before, after, environment, count):
    asset = (before.parent / "app.mjs").read_bytes()
    assert asset == (after.parent / "app.mjs").read_bytes(), "Server public asset differs between checkouts"
    samples = {"legacyNodeServer": [], "qualifiedNodeServer": []}
    entries = {"legacyNodeServer": before, "qualifiedNodeServer": after}
    for index in range(count + 1):
        order = list(entries)
        if index % 2:
            order.reverse()
        for name in order:
            value = server_one(node, entries[name], asset, environment)
            if index:
                samples[name].append(value)
    fields = ("startupMs", "residentBytes", "rootMedianMs", "assetMedianMs")
    medians = {name: {key: statistics.median(value[key] for value in values) for key in fields} for name, values in samples.items()}
    regressions = server_regressions(medians)
    return {"scope": "Real project server; no model calls, authentication or protected API operations; nativeDirect resident is N/A (no persistent process)", "residentMethod": {"win32": "GetProcessMemoryInfo.WorkingSetSize", "linux": "/proc/pid/status VmRSS", "darwin": "ps rss KiB"}[sys.platform] + ": primary current resident bytes one second after ready; not tree/private/PSS, long-run steady state or leak proof", "warmupsPerMode": 1, "alternatingSamplesPerMode": count, "httpWarmupsPerRoute": 3, "httpSamplesPerRoutePerServer": 10, "httpConnection": "same sequential HTTPConnection per server, full response bodies validated", "assetSha256": hashlib.sha256(asset).hexdigest(), "allowances": SERVER_ALLOWANCES, "regressions": regressions, "medians": medians, "samples": samples}


def self_check():
    node = shutil.which("node")
    assert node
    asset = b"export default 1;"
    fields = tuple(SERVER_ALLOWANCES)
    for baseline, boundary in (((100, 10 * 1048576, 1, .5), (150, 18 * 1048576, 2, 1.5)), ((1000, 100 * 1048576, 10, 10), (1100, 110 * 1048576, 12, 12))):
        medians = {"legacyNodeServer": dict(zip(fields, baseline)), "qualifiedNodeServer": dict(zip(fields, boundary))}
        assert server_regressions(medians) == [], "Gate rejected an exact boundary"
        for key in fields:
            medians["qualifiedNodeServer"][key] += 1
            assert server_regressions(medians) == [key], "Gate missed a relative/absolute regression"
            medians["qualifiedNodeServer"][key] -= 1
    with tempfile.TemporaryDirectory(prefix="rdsh-server-peer-") as directory:
        peer = Path(directory) / "peer.mjs"
        peer.write_text('import http from "node:http";const port=Number(process.argv[process.argv.indexOf("--port")+1]);const html=\'<html lang="en" data-rdsh-locale="en"></html>\';const server=http.createServer((q,r)=>{r.writeHead(200);r.end(q.url==="/"?html:"export default 1;")});server.listen(port,"127.0.0.1",()=>console.log(`http://127.0.0.1:${port}/`));', encoding="utf8")
        value = server_one(node, peer, asset, clean_environment(), startup_seconds=5)
        assert all(value[key] > 0 for key in ("startupMs", "residentBytes", "rootMedianMs", "assetMedianMs"))
        try:
            server_one(node, peer, b"wrong asset", clean_environment(), startup_seconds=5)
        except AssertionError as error:
            assert "asset bytes" in str(error)
        else:
            raise AssertionError("Mismatched public asset was accepted")
        source = peer.read_text(encoding="utf8")
        peer.write_text(source.replace('r.end(q.url===', 'setTimeout(()=>r.end(q.url===').replace('"export default 1;")});', '"export default 1;"),1000)});'), encoding="utf8")
        try:
            server_one(node, peer, asset, clean_environment(), startup_seconds=.6)
        except AssertionError as error:
            assert "Late successful readiness" in str(error)
        else:
            raise AssertionError("Late readiness was accepted")
        peer.write_text(source.replace('r.end(q.url==="/"?html:"export default 1;")', ''), encoding="utf8")
        try:
            server_one(node, peer, asset, clean_environment(), startup_seconds=.6)
        except AssertionError as error:
            assert "readiness deadline" in str(error)
        else:
            raise AssertionError("Nonresponding peer was accepted")
        peer.write_text("process.exit(7);", encoding="utf8")
        try:
            server_one(node, peer, asset, clean_environment(), startup_seconds=5)
        except AssertionError as error:
            assert "exited before readiness" in str(error)
        else:
            raise AssertionError("Early exit was accepted")
    print("PASS benchmark self-check: live primary RSS, HTTP bytes, rejected mismatch/early exit/late readiness/nonresponse, exact relative/absolute gate boundaries and bounded owned-child cleanup (fixture only, not product evidence)")


if len(sys.argv) > 1 and sys.argv[1] == "--self-check":
    self_check()
    sys.exit(0)


def one(command):
    assert sys.platform in ("win32", "darwin", "linux"), "Only Windows/macOS/Linux measurements are supported"
    started = time.perf_counter()
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = child.communicate(timeout=35)
    except subprocess.TimeoutExpired:
        child.kill()
        child.communicate()
        raise
    elapsed = (time.perf_counter() - started) * 1000
    assert child.returncode == 0 and not err, (child.returncode, err)
    if os.name == "nt":
        peak = windows_counters(child).peak
        method = "GetProcessMemoryInfo: primary-process peak working set; children excluded"
    else:
        import resource
        peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        if sys.platform != "darwin":
            peak *= 1024
        method = "fresh helper RUSAGE_CHILDREN.ru_maxrss: maximum-process RSS, not aggregate tree RSS"
    return {"status": child.returncode, "stdout": base64.b64encode(out).decode(), "stderr": base64.b64encode(err).decode(), "milliseconds": elapsed, "peakBytes": peak, "memoryMethod": method}


if len(sys.argv) > 1 and sys.argv[1] == "--once":
    print(json.dumps(one(sys.argv[2:])))
    sys.exit(0)

p = argparse.ArgumentParser()
p.add_argument("--root", required=True)
p.add_argument("--native", required=True)
p.add_argument("--baseline", required=True)
p.add_argument("--baseline-root", required=True)
p.add_argument("--samples", type=int, default=7)
a = p.parse_args()
assert a.samples >= 5
warmups = 3
root = Path(a.root).resolve(strict=True)
dash = root / "dashboard"
reference = Path(a.baseline_root).resolve(strict=True)
native = Path(a.native).resolve(strict=True)
node = shutil.which("node")
assert node, "Node is required for the actual legacy and bridge measurements"
base = subprocess.run(["git", "rev-parse", "--verify", a.baseline + "^{commit}"], cwd=root, check=True, capture_output=True).stdout.decode().strip()
reference_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=reference, check=True, capture_output=True).stdout.decode().strip()
assert reference_head == base, "Baseline must be the complete original checkout"
subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=reference, check=True)
assert not subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=reference, check=True, capture_output=True).stdout, "Baseline contains unexpected nonignored files"
assert (reference / "dashboard/package-lock.json").read_bytes() == (dash / "package-lock.json").read_bytes(), "Dependency locks differ"
before = reference / "dashboard/cli.mjs"
with tempfile.TemporaryDirectory(prefix="rdsh-catalog-bench-") as temporary:
    home = Path(temporary)
    env = clean_environment()
    for key in ("HOME", "USERPROFILE", "DSH_HOME", "RDSH_DASHBOARD_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"):
        location = home / key
        location.mkdir()
        env[key] = str(location)
    env.pop("FORCE_COLOR", None)
    env.update(RDSH_AUTH_AUTOSYNC="0", RDSH_DRY_RUN="1", RDSH_LANG="en", RDSH_BIN=str(native), RDSH_ORIG_BIN=str(home / "missing-dsh"), DSH_ORIG_BIN=str(home / "missing-dsh"), NO_COLOR="1")
    expected = subprocess.run([node, "--input-type=module", "--eval", "import {adapterCatalog} from './adapter-catalog.mjs';console.log(JSON.stringify({adapters:adapterCatalog()},null,2));"], cwd=dash, env=env, check=True, capture_output=True).stdout
    commands = {"legacyNodeCli": [node, str(before), "adapters", "--language=en"], "nativeDirect": [str(native), "--language=en", "adapter-catalog"], "qualifiedNodeCli": [node, str(dash / "cli.mjs"), "adapters", "--language=en"]}
    samples = {key: [] for key in commands}
    wrapper = str(Path(__file__).resolve())
    for index in range(a.samples + warmups):
        order = list(commands)
        if index % 2:
            order.reverse()
        for key in order:
            result = subprocess.run([sys.executable, wrapper, "--once", *commands[key]], cwd=dash, env=env, check=True, capture_output=True)
            value = json.loads(result.stdout)
            out, err = base64.b64decode(value.pop("stdout")), base64.b64decode(value.pop("stderr"))
            assert value["status"] == 0 and not err, (key, value, err)
            assert out == expected, key + " output mismatch"
            value.update(outputSha256=hashlib.sha256(out).hexdigest(), stderrEmpty=True)
            if index >= warmups:
                samples[key].append(value)
    report = {"benchmark": "adapter-catalog", "platform": sys.platform, "python": sys.version.split()[0], "node": subprocess.run([node, "--version"], check=True, capture_output=True).stdout.decode().strip(), "base": base, "baselineRoot": str(reference), "baselineEntrySha256": hashlib.sha256(before.read_bytes()).hexdigest(), "native": str(native), "nativeSha256": hashlib.sha256(native.read_bytes()).hexdigest(), "outputSha256": hashlib.sha256(expected).hexdigest(), "warmupsPerMode": warmups, "alternatingSamplesPerMode": a.samples, "machine": platform.machine(), "cpuCount": os.cpu_count(), "timing": "fresh helper: Popen through communicate; includes process launch and output capture, excludes helper startup", "allOutputsByteExact": True, "p95Method": "nearest rank; with seven samples this is their maximum, not a stable tail estimate", "modes": {}}
    for key, values in samples.items():
        timings = sorted(v["milliseconds"] for v in values)
        report["modes"][key] = {"medianMs": statistics.median(timings), "p95Ms": timings[math.ceil(len(timings) * .95) - 1], "medianPeakBytes": statistics.median(v["peakBytes"] for v in values), "memoryMethod": values[0]["memoryMethod"], "samples": values}
    report["checkout"] = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True).stdout.decode().strip()
    report["canonicalSource"] = os.environ.get("CATALOG_SOURCE")
    report["server"] = server_comparison(node, before, dash / "cli.mjs", env, a.samples)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    assert not report["server"]["regressions"], "Server performance regression: " + ", ".join(report["server"]["regressions"])
