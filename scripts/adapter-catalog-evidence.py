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
        peak = counters.peak
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
    env = dict(os.environ)
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
    print(json.dumps(report, ensure_ascii=False))
