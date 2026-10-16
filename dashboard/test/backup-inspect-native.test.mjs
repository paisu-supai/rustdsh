import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileInspectPeer } from "./backup-inspect-peer-helper.mjs";
import { backupHash } from "../history-backup.mjs";
import { readBackupJson, backupInspection } from "../backup-files.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.env.RDSH_BIN || process.env.BIN || path.join(repo, "target/debug", process.platform === "win32" ? "rdsh.exe" : "rdsh");
const baseline = JSON.parse(await fs.readFile(new URL("../../docs/evidence/history-backup/archive.json", import.meta.url), "utf8"));
const maximum = 2 * 1024 * 1024;
function reseal(v) { const { integrity, ...body } = v; v.integrity = {algorithm:"sha256",digest:backupHash(body)}; return v; }
function changed(mutate, seal = true) { const v = structuredClone(baseline); mutate(v); return JSON.stringify(seal ? reseal(v) : v); }
function content(value) { return changed(v => { v.records.tasks[0].title = value; }); }
function duplicated(v, discarded) {
  if (Array.isArray(v)) return `[${v.map(x => duplicated(x,discarded)).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([key,value]) => `${JSON.stringify(key)}:${discarded},${JSON.stringify(key).replace(/[a-z]/, c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`)}:${duplicated(value,discarded)}`).join(",")}}`;
  return JSON.stringify(v);
}
async function scratch(t) {
  const parent = path.join(repo,"target/backup-inspect-tests"); await fs.mkdir(parent,{recursive:true});
  const root = await fs.mkdtemp(path.join(parent,"case-"));
  // Keep evidence and inputs under this worktree, never the user's home.
  return root;
}
function native(file,root,language="en",extra=[]) {
  const result = spawnSync(binary,["backup-inspect",`--archive-file=${file}`,...extra],{encoding:"utf8",timeout:10000, maxBuffer:16*maximum,env:{...process.env,DSH_HOME:root,RDSH_LANG:language}});
  assert.ifError(result.error); return result;
}

test("native reader/parser/validator/projection agrees byte-for-byte with the retained JS oracle", async t => {
  const root = await scratch(t), file=path.join(root,"archive.json");
  const cases = [
    ["baseline",JSON.stringify(baseline)],
    ...["1e309",'"\\ud800"','{"\\udc00":[1e309,"\\ud800"]}',`${"[".repeat(1024)}0${"]".repeat(1024)}`].map(x=>[`duplicates-${x.slice(0,12)}`,duplicated(baseline,x)]),
    ["bad-checksum",changed(v=>v.integrity.digest="0".repeat(64),false)],
    ["unknown-root",changed(v=>v.extra=1)],
    ["unknown-surrogate-key",changed(v=>v["\ud800"]=1)],
    ["header-before-record-field",changed(v=>{v.format="bad";v.records.tasks[0].extra=0})],
    ["source-before-selection",changed(v=>{v.source.revision=-1;v.selection.types=[]})],
    ["selection-order",changed(v=>v.selection.types.reverse())],
    ["selection-duplicate",changed(v=>v.selection.types.push("tasks"))],
    ["selection-missing",changed(v=>delete v.selection.since)],
    ["selection-ids",changed(v=>v.selection.task_ids=["constructor"])],
    ["selection-range",changed(v=>v.selection.since="2026-02-30T00:00:00.000Z")],
    ["policy",changed(v=>v.policy.execution_authorized=true)],
    ["records-shape",changed(v=>v.records.tasks=null)],
    ["duplicate-task",changed(v=>v.records.tasks.push(v.records.tasks[0]))],
    ["task-status",changed(v=>v.records.tasks[0].status="invalid")],
    ["question-date",changed(v=>v.records.questions[0].created_at="bad")],
    ["decision-ref",changed(v=>v.records.decisions[0].question_id="missing")],
    ["decision-revision",changed(v=>v.records.decisions[0].revision=2)],
    ["duplicate-choice",changed(v=>v.records.decisions[0].choices.push(v.records.decisions[0].choices[0]))],
    ["answer-ref",changed(v=>v.records.answers[0].choice_id="missing")],
    ["evidence-ref",changed(v=>v.records.evidence[0].reference="https://example.org/")],
    ["review-order",changed(v=>v.reviewed_fields.reverse())],
    ["withheld-list",changed(v=>v.withheld_fields=[])],
    ["integrity-fields",changed(v=>v.integrity.extra=1,false)],
    ...["0000-02-29T00:00:00.000Z","2024-02-29T00:00:00.000Z","2025-02-29T00:00:00.000Z"].map(x=>[x,changed(v=>v.created_at=x)]),
    ...["x\ud800x","x\udc00x","x😀x","\ufeff","\u0085","a".repeat(8000),"a".repeat(8001),"😀".repeat(4000),"😀".repeat(4001),"Bearer abc","password = abc","const x = 1","a".repeat(64),"code ``` x","class X {","eyJabc.abc.abc","ghp_abcdef"].map((x,i)=>[`text-${i}`,content(x)]),
    ...["https://example.org/","HTTPS://example.org/?#","https://user@host/","https://x/?q=y","https://x/#a","https://例え.テスト/","https://127.1/","https://0x7f000001/","https://[::1]/","https://[invalid]/","https://a b","https://a\u0085b/","https://example.org/\ufeff?token=x","ahttps://user:pass@host/","https://example.org\\@host/","https://%65xample.org/","https://%zz/"].map((x,i)=>[`url-${i}`,content(x)]),
    ...[128,129,1024].flatMap(n=>[[`unknown-depth-${n}`,JSON.stringify(baseline).replace(/}$/,`,"unknown":${"[".repeat(n)}0${"]".repeat(n)}}`)], [`discarded-bad-syntax-${n}`,JSON.stringify(baseline).replace('"format":',`"format":${"[".repeat(n)}1,${"]".repeat(n)},"format":`)]]),
    ...["1.00000000000000001","1e-400","-0","9007199254740991","9007199254740993","1e309"].map(n=>{const value=JSON.parse(n); const s=changed(v=>v.source.revision=value); return [`number-${n}`,s.replace(/"revision":[^,}]+/,`"revision":${n}`)]}),
    ["stringify-expansion",`{"unknown":[${"1e-6,".repeat(280000)}0]}`],
    ["raw-size",Buffer.alloc(maximum+1,32)],
    ["bom",Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(baseline))])],
    ["utf8",Buffer.from([0xc3,0x28])],
    ["trailing-json",JSON.stringify(baseline)+"false"],
  ];
  for(const field of ["algorithm","digest"]){
    cases.push([`integrity-${field}-lone-surrogate`,changed(v=>v.integrity[field]="\ud800",false)]);
    cases.push([`integrity-${field}-deep-array`,changed(v=>v.integrity[field]=JSON.parse("[".repeat(1024)+"0"+"]".repeat(1024)),false)]);
  }
  for(const text of ["ſecret=x","Baſic abcdef","https://host/ſecret","CONST x = {};"])cases.push([`legacy-casefold-${cases.length}`,content(text)]);
  for(const replacement of [null,"Reviewed replacement text"]){
    cases.push([`all-content-${replacement===null?"withheld":"reviewed"}`,changed(v=>{
      v.reviewed_fields=[];v.withheld_fields=[];
      const add=(record,key,p)=>{record[key]=replacement;v[replacement===null?"withheld_fields":"reviewed_fields"].push(p)};
      for(const [kind,list] of Object.entries(v.records))for(const record of list){
        const names={tasks:["title","milestone","blocker"],questions:["question"],answers:["answer"],decisions:["diff","impact","conditions"],evidence:[]}[kind];
        for(const key of names)add(record,key,`${kind}/${record.id}/${key}`);
        if(kind==="decisions")for(const choice of record.choices)add(choice,"label",`${kind}/${record.id}/choices/${choice.id}/label`);
      }
      v.reviewed_fields.sort();v.withheld_fields.sort();
    })]);
  }
  cases.push(["retained-insertion-order",changed(v=>{
    v.records=Object.fromEntries(Object.entries(v.records).reverse().map(([kind,list])=>[kind,list.map(r=>Object.fromEntries(Object.entries(r).reverse()))]));
    v.source=Object.fromEntries(Object.entries(v.source).reverse());
  })]);
  // Every schema field is exercised with wrong primitive/container types.
  for (const kind of ["tasks","questions","decisions","answers","evidence"]) {
    for (const field of Object.keys(baseline.records[kind][0])) {
      for (const [index,value] of [null,false,0,[],{},"x"].entries()) {
        cases.push([`field-${kind}-${field}-${index}`,changed(v=>v.records[kind][0][field]=value)]);
      }
    }
  }
  for(const text of ["éBearer abc", "xBearer abc", "-----BEGIN a\u2028PRIVATE KEY-----", "https://example.org/\u0085?token=x", "https://example.org/\ufeff?token=x", "https://[::ffff:127.0.0.1]/", "https://127.0.0.999/", "https://-host/", "https://host:99999/", "https://a%2fb/", "http://", "https:// space", "https://example.org/https://user@host/", "https://<https://user@host/", "http://https://"]){cases.push([`secret-url-extra-${cases.length}`,content(text)]);}
  const rawNumbers="1e-6,".repeat(200000)+"0";
  const sizeBase=`{"unknown":[${rawNumbers}],"padding":""}`;
  const padding=maximum-Buffer.byteLength(JSON.stringify(JSON.parse(sizeBase)));
  for(const delta of [-1,0,1]) cases.push([`stringify-size-${delta}`,sizeBase.replace('"padding":""',`"padding":"${"x".repeat(padding+delta)}"`)]);
  const compact=JSON.stringify(baseline);
  for(const delta of [-1,0,1]) cases.push([`raw-size-${delta}`,compact+" ".repeat(maximum+delta-Buffer.byteLength(compact))]);
  const results=[];
  for (const [name,text] of cases) {
    await fs.writeFile(file,text);
    let output,error;
    try {output=JSON.stringify(backupInspection(await readBackupJson(file)),null,2)+"\n";} catch(e) {error=e.message;}
    const result=native(file,root);
    const expectedError=error ? `[rdsh-dashboard] ${error}\n`:"";
    results.push({name,expected:error||"accept",actual:result.status,match:result.status===(error?1:0)&&result.stdout=== (output||"") && result.stderr===expectedError});
    assert.equal(result.status,error?1:0,name+" status "+result.stderr);
    assert.equal(result.stdout,output||"",name+" stdout");
    assert.equal(result.stderr,expectedError,name+" stderr");
  }
  await fs.writeFile(path.join(root,"results.json"),JSON.stringify(results,null,2)+"\n");
  console.log(`DIFFERENTIAL ${results.length} cases; raw+FS+validator+exact projection; evidence ${root}`);
});

test("million-level input is bounded; legacy Node call-stack error is recorded, not claimed equivalent",async t=>{
  const root=await scratch(t),file=path.join(root,"deep.json"),results=[];
  for(const depth of [125000,250000,1000000]){
    const text='{"x":'+"[".repeat(depth)+"0"+"]".repeat(depth)+'}';
    assert.ok(Buffer.byteLength(text)<=maximum);
    await fs.writeFile(file,text);
    let oldError;
    try { backupInspection(await readBackupJson(file)); } catch(e) { oldError={name:e.name,message:e.message}; }
    assert.equal(oldError?.name,"RangeError","legacy recursive stringify exhausts its call stack");
    const start=performance.now(),r=native(file,root),elapsed_ms=performance.now()-start;
    assert.equal(r.status,1,r.stderr);assert.equal(r.stdout,"");
    assert.equal(r.stderr,"[rdsh-dashboard] invalid_backup_fields\n");
    results.push({depth,bytes:Buffer.byteLength(text),elapsed_ms,legacy:oldError,native:"invalid_backup_fields",equivalent:false});
  }
  await fs.writeFile(path.join(root,"deep-results.json"),JSON.stringify(results,null,2));
  console.log("DEEP BOUNDED / KNOWN LEGACY ERROR DIFFERENCE",JSON.stringify(results),root);
});

test("regular file/hardlink/parent link and localized errors; isolated native does not read settings or need Node",async t=>{
  const root=await scratch(t),file=path.join(root,"archive.json"); await fs.writeFile(file,JSON.stringify(baseline));
  await fs.writeFile(path.join(root,"rdsh.json"),"not valid settings");
  const linked=path.join(root,"hardlink.json"); await fs.link(file,linked);
  assert.equal(native(linked,root).status,0);
  assert.equal(native(root,root).status,1);
  const directory=path.join(root,"actual-parent"),parent=path.join(root,"linked-parent");
  await fs.mkdir(directory);await fs.writeFile(path.join(directory,"archive.json"),JSON.stringify(baseline));
  await fs.symlink(directory,parent,process.platform==="win32"?"junction":"dir");
  assert.equal(native(path.join(parent,"archive.json"),root).status,0,"parent links remain supported");
  assert.equal(native(parent,root).status,1,"a directory/reparse leaf is never read");
  if(process.platform==="win32")assert.equal(native("NUL",root).status,1,"device is not a regular archive");
  const env={...process.env,PATH:"",DSH_HOME:root,RDSH_LANG:"en"};
  const noNode=spawnSync(binary,["backup-inspect",`--archive-file=${file}`],{env,encoding:"utf8",timeout:10000});
  assert.ifError(noNode.error); assert.equal(noNode.status,0,noNode.stderr);
  const bad=path.join(root,"bad.json");await fs.writeFile(bad,"{}");
  for(const [language,prefix] of [["en",""],["ja","処理に失敗しました: "],["zh-CN","操作失败："]]){
    const r=native(bad,root,language);
    assert.equal(r.status,1); assert.equal(r.stderr,`[rdsh-dashboard] ${prefix}invalid_backup_fields\n`);
  }
  assert.equal(native(linked,root).status,0,"negative locale fixtures must preserve the valid hardlink");
  if(process.platform!=="win32"){
    const leaf=path.join(root,"leaf.json");await fs.symlink(path.join(directory,"archive.json"),leaf);
    const denied=native(leaf,root);assert.equal(denied.status,1);assert.match(denied.stderr,/Invalid backup JSON: require a regular UTF-8 file/);
    const parent=path.join(root,"parent");await fs.symlink(root,parent);assert.equal(native(path.join(parent,"hardlink.json"),root).status,0);
  }
});

test("actual adapter forwards native output/status and fails closed on spawn failure",async t=>{
  const root=await scratch(t),file=path.join(root,"archive.json");await fs.writeFile(file,JSON.stringify(baseline));
  const module=new URL("../backup-inspect-native.mjs",import.meta.url).href;
  const invoke=(exe,{mode="actual",timeout=10000,archive=file}={})=>{
    const r=spawnSync(process.execPath,["--input-type=module","-e",`import {runNativeBackupInspect} from ${JSON.stringify(module)};try{process.exitCode=await runNativeBackupInspect(${JSON.stringify(exe)},${JSON.stringify(archive)},"en")}catch(e){console.error(e.code||e.message);process.exitCode=1}`],{cwd:root,encoding:"utf8",timeout,env:{...process.env,DSH_HOME:root,RDSH_INSPECT_PEER_MODE:mode,RDSH_INSPECT_PEER_MARKER:path.join(root,`marker-${mode}`),RDSH_INSPECT_PEER_HOME_RECORD:path.join(root,"probe-home")}});
    assert.ifError(r.error);return r;
  };
  await fs.writeFile(path.join(root,"rdsh.json"),"broken caller settings");
  const direct=native(file,root),adapted=invoke(binary);
  assert.equal(adapted.status,0,adapted.stderr);assert.equal(adapted.stdout,direct.stdout);assert.equal(adapted.stderr,"");
  const missing=invoke(path.join(root,"missing-native.exe"));assert.equal(missing.status,1);assert.equal(missing.stdout,"");assert.match(missing.stderr,/ENOENT/);
  const peer=compileInspectPeer(root);
  const dirty=invoke(peer,{mode:"dirty-home"});
  assert.equal(dirty.status,1);assert.equal(dirty.stdout,"");assert.match(dirty.stderr,/ENOTEMPTY|EEXIST/);
  const probeHome=await fs.readFile(path.join(root,"probe-home"),"utf8");assert.ok(path.isAbsolute(probeHome));
  assert.equal(await fs.readFile(path.join(probeHome,"unexpected"),"utf8"),"preserve");
  await assert.rejects(fs.access(path.join(root,"marker-dirty-home")),{code:"ENOENT"});
  for(const mode of ["legacy","bad-stderr","bad-exit","overflow","help-signal"]){
    const r=invoke(peer,{mode,archive:path.join(root,"absent-archive.json")});
    assert.equal(r.status,1,r.stderr);assert.equal(r.stdout,"");assert.match(r.stderr,/unavailable|exceeds 64 KiB/);
    await assert.rejects(fs.access(path.join(root,`marker-${mode}`)),{code:"ENOENT"});
  }
  for(const [mode,code] of [["exit7",7],["signal",1]]){
    const r=invoke(peer,{mode});assert.equal(r.status,code,r.stderr);assert.equal(r.stdout,"");
    assert.match(await fs.readFile(path.join(root,`marker-${mode}`),"utf8"),/^operation:backup-inspect /);
  }
  const start=performance.now(),timeout=invoke(peer,{mode:"timeout",timeout:40000});
  assert.equal(timeout.status,1);assert.equal(timeout.stdout,"");assert.match(timeout.stderr,/Native backup inspection timed out/);
  assert.ok(performance.now()-start<34000,"help delay and operation must share the same 30-second deadline");
  assert.match(await fs.readFile(path.join(root,"marker-timeout"),"utf8"),/^operation:backup-inspect /);
});
