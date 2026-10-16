// No skip: full CLI requires its declared npm dependencies and the current Rust binary.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { adapterCatalog } from "../adapter-catalog.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const binary = path.resolve(repo, process.env.RDSH_BIN || process.env.BIN || path.join("target/debug", process.platform === "win32" ? "rdsh.exe" : "rdsh"));
const expected = JSON.stringify({ adapters: adapterCatalog() }, null, 2) + "\n";
async function scratch() {
  const parent = path.join(repo, "target/adapter-catalog-cli-tests");
  await fs.mkdir(parent, { recursive: true }); return await fs.mkdtemp(path.join(parent, "case-"));
}
function run(root, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, DSH_HOME: root, RDSH_BIN: binary, RDSH_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "en", NO_COLOR: "1", FORCE_COLOR: undefined, ...env },
  });
  assert.ifError(result.error); return result;
}
function fails(result, diagnostic) {
  assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, ""); assert.match(result.stderr, diagnostic);
}

test("full adapters CLI returns retained catalog bytes in all locales and keeps accepted extra argv", async () => {
  const root = await scratch();
  for (const language of ["en", "ja", "zh-CN"]) {
    for (const args of [
      [`--language=${language}`, "adapters"],
      ["adapters", "ignored-positional", "--language", language],
      ["--language", language, "--", "adapters", "--not-an-option-after-terminator"],
      ["adapters", `--language=${language}`, "--project", path.join(root, "absent"), "--port", "not-a-port", "--label", "ignored", "--input-file", "absent.json"],
    ]) {
      const result = run(root, args); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected); assert.equal(result.stderr, "");
    }
  }
});

test("full CLI preserves argument/global guards and refuses missing native without Node catalog fallback", async () => {
  const root = await scratch(), absent = path.join(root, "missing-executable");
  for (const [args, diagnostic] of [
    [["adapters", "--not-an-option"], /--not-an-option/],
    [["adapters", "--language=unsupported"], /--language/],
    [["adapters", "--executable", absent], /Specify --cli/],
    [["adapters", "--entrypoint", "missing.js"], /--entrypoint requires --executable/],
    [["adapters", "--retry"], /--retry requires adapters --cli dsh/],
    [["adapters", "--cli", "unknown"], /unknown_cli/],
    [["adapter-smoke"], /--executable/],
    [["adapters", "--gpu-request", "{}"], /--gpu-request/],
    [["adapters", "--release-id", "x"], /release/],
    [["adapters", "--plan-id", "x"], /plan/],
    [["adapters", "--confirm-stale-lock"], /state-migrate/],
    [["adapters", "--retry-attempts", "2"], /retry/],
  ]) fails(run(root, args), diagnostic);
  fails(run(root, ["adapters"], { RDSH_BIN: "relative" }), /RDSH_BIN must be an absolute path/);
  fails(run(root, ["adapters"], { RDSH_BIN: absent }), /ENOENT/);
});

test("full CLI still reads and validates settings even with explicit language, before catalog guards", async () => {
  const root = await scratch(), settings = path.join(root, "rdsh.json");
  for (const value of ["broken", "null", "[]", '{"general":[]}', '{"general":{"language":null}}', '{"general":{"language":"bad"}}']) {
    await fs.writeFile(settings, value);
    fails(run(root, ["adapters"]), /rdsh\.json/);
    fails(run(root, ["--language=en", "adapters", "--executable", "absent"]), /rdsh\.json/);
    // Invalid explicit language still precedes settings loading, as before.
    fails(run(root, ["--language=bad", "adapters"]), /--language/);
  }
});

test("full CLI retains explicit, environment, settings and automatic locale precedence", async () => {
  const root = await scratch(), settings = path.join(root, "rdsh.json");
  const messages = { en: /Specify --cli when probing an executable/, ja: /実行ファイルを検証するときは--cli/, "zh-CN": /探测可执行文件时请指定 --cli/ };
  for (const [setting, env, extra, language] of [
    ["ja", {}, [], "ja"],
    ["ja", { RDSH_LANG: "zh-CN" }, [], "zh-CN"],
    ["ja", { RDSH_LANG: "zh-CN" }, ["--language=en"], "en"],
    ["en", { RDSH_LANG: "en" }, ["--language", "ja"], "ja"],
    ["auto", { LC_ALL: "zh_CN.UTF-8" }, [], "zh-CN"],
    ["auto", { LC_MESSAGES: "ja_JP.UTF-8" }, [], "ja"],
    ["ja", { RDSH_LANG: "unsupported" }, [], "en"],
  ]) {
    await fs.writeFile(settings, JSON.stringify({ general: { language: setting } }));
    fails(run(root, ["adapters", "--executable", "absent", ...extra], env), messages[language]);
  }
});
