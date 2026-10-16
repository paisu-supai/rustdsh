import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Test-only native peer: naming it dsh verifies the adapter forces argv0=rdsh.
export function compileInspectPeer(root) {
  const executable = path.resolve(root, process.platform === "win32" ? "dsh.exe" : "dsh");
  const args = ["--edition=2021", fileURLToPath(new URL("./backup-inspect-peer.rs", import.meta.url)), "-o", executable];
  if (process.platform === "win32") {
    const linker = process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER ||
      (process.env.VCToolsInstallDir && path.join(process.env.VCToolsInstallDir, "bin/Hostx64/x64/link.exe"));
    if (linker) args.push("-C", `linker=${linker}`);
  }
  const result = spawnSync("rustc", args, { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return executable;
}
