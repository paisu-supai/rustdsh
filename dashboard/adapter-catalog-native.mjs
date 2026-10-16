import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export async function runNativeAdapterCatalog(executable, language) {
  const end = performance.now() + 30_000;
  const timeout = () => new Error("Native adapter catalog timed out");
  function run(args, env, capture) {
    const remaining = end - performance.now();
    if (remaining <= 0) return Promise.reject(timeout());
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        argv0: "rdsh", windowsHide: true, env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let failure, size = 0;
      const stdout = [], stderr = [];
      const stop = error => {
        if (failure) return;
        failure = error;
        child.kill("SIGKILL");
        // An exited root's descendant may still hold the captured pipes open.
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const timer = setTimeout(() => stop(timeout()), remaining);
      if (capture) {
        for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
          stream.on("data", chunk => {
            size += chunk.length;
            if (size > 64 * 1024) stop(new Error("Native adapter catalog help exceeds 64 KiB"));
            else chunks.push(chunk);
          });
        }
      }
      child.once("error", error => { failure ??= error; });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
    });
  }
  const home = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-adapter-catalog-")));
  try {
    const help = await run(["--language=en", "--help"], {
      ...process.env, DSH_HOME: home, RDSH_LANG: "en", NO_COLOR: "1", CLICOLOR_FORCE: "0", FORCE_COLOR: "0",
    }, true);
    const lines = help.stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
    const start = lines.findIndex(line => /^Commands:[ \t]*$/.test(line));
    let supported = false;
    for (const line of start < 0 ? [] : lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      if (/^ {2}adapter-catalog(?:[ \t]+.*)?$/.test(line)) supported = true;
    }
    if (help.code !== 0 || help.signal || help.stderr !== "" || !supported)
      throw new Error("Native adapter catalog is unavailable: peer lacks adapter-catalog command");
  } finally {
    // Never recursively delete unexpected peer-generated files.
    await fs.rmdir(home);
  }
  const result = await run(["adapter-catalog"], { ...process.env, RDSH_LANG: language }, false);
  return result.code ?? 1;
}
