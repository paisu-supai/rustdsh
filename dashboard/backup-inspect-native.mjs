import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Qualify the resolved peer before sending any archive argument. No JS fallback.
export async function runNativeBackupInspect(executable, archiveFile, language) {
  const end = performance.now() + 30_000;
  const timeoutError = () => new Error("Native backup inspection timed out");
  function run(args, env, capture) {
    const remaining = end - performance.now();
    if (remaining <= 0) return Promise.reject(timeoutError());
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        argv0: "rdsh", windowsHide: true, env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let failure, size = 0;
      const stdout = [], stderr = [];
      const stop = error => { failure ??= error; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop(timeoutError()), remaining);
      if (capture) {
        for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
          stream.on("data", chunk => {
            size += chunk.length;
            if (size > 64 * 1024) stop(new Error("Native backup inspection help exceeds 64 KiB"));
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
  const home = await fs.mkdtemp(path.resolve(os.tmpdir(), "rdsh-backup-inspect-"));
  try {
    const help = await run(["--language=en", "--help"], {
      ...process.env, DSH_HOME: home, RDSH_LANG: "en", NO_COLOR: "1", CLICOLOR_FORCE: "0", FORCE_COLOR: "0",
    }, true);
    const lines = help.stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
    let commands = false, supported = false;
    for (const line of lines) {
      if (line === "Commands:") { commands = true; continue; }
      if (commands && /^\S/.test(line)) commands = false;
      if (commands && /^[ \t]+backup-inspect(?:[ \t]+|$)/.test(line)) supported = true;
    }
    if (help.code !== 0 || help.signal || help.stderr !== "" || !supported)
      throw new Error("Native backup inspection is unavailable: peer lacks backup-inspect command");
  } finally {
    // Only remove our empty directory. Unexpected files are preserved and fail closed.
    await fs.rmdir(home);
  }
  const result = await run(["backup-inspect", `--archive-file=${archiveFile}`], {
    ...process.env, RDSH_LANG: language,
  }, false);
  return result.code ?? 1;
}
