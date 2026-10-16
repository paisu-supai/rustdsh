import { spawn } from "node:child_process";

// The launcher retains argv/settings/locale policy; Rust owns the file read,
// JSON parsing, validation, hash and projection. Never retry in JavaScript.
export async function runNativeBackupInspect(executable, archiveFile, language) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ["backup-inspect", `--archive-file=${archiveFile}`], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, RDSH_LANG: language },
    });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (timedOut) reject(new Error("Native backup inspection timed out"));
      else resolve(code ?? 1);
    });
  });
}
