// Deliberately no skip: this suite needs the declared dashboard npm dependencies
// and the current Rust binary. Missing local dependencies are a failed/unverified
// whole-CLI run, never evidence from the pure validator suite.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {compileInspectPeer} from "./backup-inspect-peer-helper.mjs";
import {backupInspection} from "../backup-files.mjs";
const repo=fileURLToPath(new URL("../../",import.meta.url));
const cli=fileURLToPath(new URL("../cli.mjs",import.meta.url));
const bin=path.resolve(repo,process.env.RDSH_BIN||process.env.BIN||path.join("target/debug",process.platform==="win32"?"rdsh.exe":"rdsh"));
const fixture=JSON.parse(await fs.readFile(new URL("../../docs/evidence/history-backup/archive.json",import.meta.url),"utf8"));
const expected=JSON.stringify(backupInspection(fixture),null,2)+"\n";
async function setup(){const dir=path.join(repo,"target/backup-inspect-cli-tests");await fs.mkdir(dir,{recursive:true});const root=await fs.mkdtemp(path.join(dir,"case-"));const file=path.join(root,"input.json");await fs.writeFile(file,JSON.stringify(fixture));return {root,file};}
function run(root,args,env={},timeout=15000){const r=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:"utf8",timeout,env:{...process.env,DSH_HOME:root,RDSH_BIN:bin,RDSH_LANG:"",LC_ALL:"",LC_MESSAGES:"",LANG:"en",...env}});assert.ifError(r.error);return r;}
const fail=(r,pattern)=>{assert.equal(r.status,1,r.stderr);assert.equal(r.stdout,"");assert.match(r.stderr,pattern);};

test("existing CLI actually reaches current Rust; all locales and argv forms retain output bytes",async()=>{
 const {root,file}=await setup();
 // This must spawn the real existing cli, not an isolated adapter or validator.
 for(const lang of ["en","ja","zh-CN"]){
  const r=run(root,["--language",lang,"backup","inspect","--archive-file",file]);
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,expected);assert.equal(r.stderr,"");
  await fs.writeFile(path.join(root,"bad.json"),"{}");
  const bad=run(root,["backup","inspect",`--archive-file=${path.join(root,"bad.json")}`,`--language=${lang}`]);
  const detail={en:"",ja:"処理に失敗しました: ","zh-CN":"操作失败："}[lang];
  assert.equal(bad.status,1);assert.equal(bad.stdout,"");assert.equal(bad.stderr,`[rdsh-dashboard] ${detail}invalid_backup_fields\n`);
  const action={en:/Invalid backup action\/options/,ja:/backupの操作またはオプションが不正/,"zh-CN":/backup 操作或选项无效/}[lang];
  const conflicts=[
   [["--project","x"],action], // invalid option precedes missing archive
   [["--gpu-request","x","--project","x"],/--gpu-request/],
   [["--from-id","x","--include-project","x"],/project-move/],
   [["--include-project","x","--plan-id","x"],/--include-project/],
   [["--plan-id","x","--release-id","x"],/release/], // release guard precedes migration and plan guards
   [["--confirm-stale-lock"],/state-migrate/],
   [["--plan-id","x"],/plan/],
   [[`--archive-file=${file}`,"--expected-revision","3"],action],
   [[`--archive-file=${file}`,"--release-id","x"],/release/],
  ];
  for(const [extra,pattern]of conflicts)fail(run(root,[`--language=${lang}`,"backup","inspect",...extra]),pattern);
 }
 const forms=[
  ["backup","inspect",`--archive-file=${file}`],
  ["--archive-file",file,"backup","inspect"],
  ["backup","--archive-file",file,"inspect"],
  ["backup","inspect","--archive-file","missing","--archive-file",file],
  ["backup","inspect",`--archive-file=${file}`,"--"],
 ];
 for(const argv of forms){const r=run(root,argv);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,expected);assert.equal(r.stderr,"");}
 fail(run(root,["backup","inspect","--archive-file",file,"--archive-file",""]),/Specify --archive-file/);
 fail(run(root,["backup","inspect"]),/Specify --archive-file/);
 fail(run(root,["backup","inspect","extra","--archive-file",file]),/Invalid backup action\/options/);
 fail(run(root,["backup","inspect","--","--archive-file",file]),/Invalid backup action\/options/);
 for(const argv of [["--unknown"],["--archive-file"],["--archive-file="+file,"--project"],["--archive-file="+file,"--help=false"]]){
  fail(run(root,["backup","inspect",...argv]),/\[rdsh-dashboard\]/);
 }
 for(const h of ["-h","--help"]){const r=run(root,["backup","inspect",h]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rdsh-dashboard backup inspect/);assert.notEqual(r.stdout,expected);}
});

test("every existing non-inspect option is rejected before spawn; parsing/settings priority retained",async()=>{
 const {root,file}=await setup();
 const source=await fs.readFile(cli,"utf8");
 const optionSource=source.slice(source.indexOf("options: {",source.indexOf("parseArgs({")),source.indexOf("  explicitLanguage = values.language"));
 const options=[...optionSource.matchAll(/^\s+(?:"([\w-]+)"|([\w-]+)):\s*\{\s*type:\s*"(string|boolean)"/gm)].map(m=>({name:m[1]||m[2],type:m[3]}));
 assert.ok(options.length>70,"cover the actual entire CLI option table");
 for(const {name,type} of options.filter(o=>!["language","help","archive-file"].includes(o.name))){
  const argv=["backup","inspect","--archive-file",file,`--${name}`,...(type==="string"?["x"]:[])];
  const r=run(root,argv,{RDSH_BIN:path.join(root,"not-installed")});
  fail(r,/\[rdsh-dashboard\]/);assert.doesNotMatch(r.stderr,/ENOENT|not-installed/,name+" must reject before native lookup/spawn");
 }
 const settings=path.join(root,"rdsh.json");
 await fs.writeFile(settings,"broken");
 fail(run(root,["backup","inspect","--archive-file",file,"--project","x"]),/language setting|表示言語設定|语言设置/);
 // Parse/language errors still precede reading broken settings.
 const parsing=run(root,["backup","inspect","--unknown"]);fail(parsing,/unknown|Unknown/);assert.doesNotMatch(parsing.stderr,/rdsh\.json/);
 const language=run(root,["--language=bad","backup","inspect"]);fail(language,/--language must be/);assert.doesNotMatch(language.stderr,/rdsh\.json/);
});

test("existing CLI locale precedence includes settings and corrupt settings even with explicit override",async()=>{
 const {root,file}=await setup(),bad=path.join(root,"bad.json"),settings=path.join(root,"rdsh.json");await fs.writeFile(bad,"{}");
 const args=["backup","inspect",`--archive-file=${bad}`];
 const cases=[
  [{general:{language:"ja"}},{},[],/処理に失敗しました/],
  [{general:{language:"ja"}},{RDSH_LANG:"zh-CN"},[],/操作失败/],
  [{general:{language:"zh-CN"}},{RDSH_LANG:"ja"},["--language=en"],/\[rdsh-dashboard\] invalid_backup_fields/],
  [{general:{language:"auto"}},{LANG:"ja_JP.UTF-8"},[],/処理に失敗しました/],
  [{general:{language:"auto"}},{LC_ALL:"zh_CN.UTF-8",LANG:"ja"},[],/操作失败/],
  [{general:{language:"ja"}},{RDSH_LANG:"unsupported"},[],/\[rdsh-dashboard\] invalid_backup_fields/],
 ];
 for(const [value,env,extra,pattern] of cases){await fs.writeFile(settings,JSON.stringify(value));fail(run(root,[...args,...extra],env),pattern);}
 for(const badSettings of ["broken","null","[]",'{"general":[]}','{"general":{"language":null}}','{"general":{"language":"bad"}}']){
  await fs.writeFile(settings,badSettings);const r=run(root,["--language=en","backup","inspect","--archive-file",file]);fail(r,/rdsh\.json/);assert.doesNotMatch(r.stderr,/invalid_backup_fields/);
 }
});

test("actual CLI fails closed for missing native, nonzero exit, signal and timeout (no JS reread)",async()=>{
 const {root,file}=await setup();const args=["backup","inspect","--archive-file",file];
 fail(run(root,args,{RDSH_BIN:"relative"}),/RDSH_BIN must be an absolute path/);
 fail(run(root,args,{RDSH_BIN:path.join(root,"missing-native")}),/ENOENT/);
 // Test-only native peer is deliberately named dsh; argv0 must still be rdsh.
 const peer=compileInspectPeer(root);
 const env=mode=>({RDSH_BIN:peer,RDSH_INSPECT_PEER_MODE:mode,RDSH_INSPECT_PEER_MARKER:path.join(root,`marker-${mode}`),RDSH_INSPECT_PEER_HOME_RECORD:path.join(root,"probe-home")});
 fail(run(root,args,env("dirty-home")),/ENOTEMPTY|EEXIST/);
 const probeHome=await fs.readFile(path.join(root,"probe-home"),"utf8");assert.ok(path.isAbsolute(probeHome));
 assert.equal(await fs.readFile(path.join(probeHome,"unexpected"),"utf8"),"preserve");
 await assert.rejects(fs.access(path.join(root,"marker-dirty-home")),{code:"ENOENT"});
 for(const mode of ["legacy","bad-stderr","bad-exit","overflow","help-signal"]){
  fail(run(root,["backup","inspect","--archive-file",path.join(root,"absent-archive.json")],env(mode)),/unavailable|exceeds 64 KiB/);
  await assert.rejects(fs.access(path.join(root,`marker-${mode}`)),{code:"ENOENT"});
 }
 for(const [mode,code] of [["exit7",7],["signal",1]]){
  const r=run(root,args,env(mode));assert.equal(r.status,code,r.stderr);assert.equal(r.stdout,"");
  assert.match(await fs.readFile(path.join(root,`marker-${mode}`),"utf8"),/^operation:backup-inspect /);
 }
 const start=performance.now();
 fail(run(root,args,env("timeout"),40000),/Native backup inspection timed out/);
 assert.ok(performance.now()-start<34000,"help delay must consume the operation's original 30-second deadline");
 assert.match(await fs.readFile(path.join(root,"marker-timeout"),"utf8"),/^operation:backup-inspect /);
});
