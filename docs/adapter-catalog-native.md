# adapters catalog のnative境界

## 対象と変えない契約

`rdsh-dashboard adapters` のうち、`--cli`・`--retry`がなくsmokeでもない最終catalog出力だけを
`rdsh adapter-catalog`へ移す。4 adapters × 6 operations、field順序、null/空array、2-space prettyと
末尾LFはretained factoryと同じ。これは固定catalogであり、実行環境のDSH/SDK互換性の証明ではない。

既存Node CLIのargv parser、global guards、settings読取・言語の優先順、既知の余分argsの受理は
そのまま。明示`--language`でも既存`loadProductLocale`のsettings検査は通る。
`--cli` probe、retry、smoke、session/runtime、他のnative adapters、実行ファイルresolverは変えない。
`adapters.mjs`の既存operations/adapterCatalog APIはreexportで維持する。versionsは旧APIに追加しない。
移したpure factoryはbuiltins/SDK-freeで、runtime用途および差分oracleとして残すが、CLIのfallbackには使わない。

Rustの`adapter-catalog`直入口はsettings非依存・Node不要。同じJSONをen/ja/zh-CNで返し、
callerの壊れたsettingsも読まない。Node CLI経由のsettings検証を回避する保証ではない。
既存Rust help/settingsガードは変更しない。

## 専用薄host

Node CLIが既存resolverで選んだ**同じ実行ファイル**へ、archive等のデータを渡さず
`--language=en --help`を送って資格確認する。argv0はprobe/operationとも`rdsh`に固定する。
probeだけにownedな空の絶対DSH_HOMEと英語・無色環境を渡す。stdinはignore、出力はcaptureし、
stdout+stderrの合計64 KiB以内、exit0、signalなし、stderr空を必須とする。
SGRを除いた最初のCommands節の2-space command列に完全名`adapter-catalog`が必要で、説明継続行・第2Commands節・suffixやnotes/after-helpの
単なる言及は受理しない。不一致・spawn失敗・出力超過・timeoutでは本操作を送らない。

probe後はowned空directoryだけをrmdirする。予期しない生成物があれば再帰削除せず保持して失敗する。
本操作はcaller元環境と選択RDSH_LANGを用いstdioを継承する。単一の30秒期限をprobeから本操作まで共有し、
超過時はowned rootだけを停止し、継承先が保持するcapture pipeも閉じてrootのcloseを待つ。他PIDはkillしない。operationの非zeroは転送、signalは1。
retry、旧SDK routingへのfallback、Node-only catalog計算へのfallbackはない。

help資格確認はsandboxでも実行ファイルの真正性認証でもない。選択された実行pathが悪意ある場合、
そのコード自体の権限を制限しない。空DSH_HOMEも悪意あるコードの目的外アクセスを防ぐものではない。

## 検証と未測定

永久テストは次で実行する。

```sh
cargo build --locked
cargo test --locked --test adapter_catalog_cli
node --test dashboard/test/adapter-catalog-native.test.mjs
# 宣言済dashboard npm dependenciesが必要。未導入をskipにしない。
node --test dashboard/test/adapter-catalog-cli.test.mjs
```

native suiteはretained pure factoryとのbyte比較、全3locale、PATH空・壊れたsettingsでの直入口、
current nativeへの薄hostを確認する。test-only standalone Rust peerは`dsh`名で生成し、
argv0、偽help、combined byte上限、dirty home保持、signal/nonzero、kill後close、実30秒期限を検査する。
full CLI suiteは本物のCLI起動と誤args/settings/言語優先順、従来受理argsを検査する。実SDKは起動しない。

2026-10-16、base `b44dcdc` 上のWindowsローカル検証ではfmt/build、native suite 2件（skipなし）、
Rust統合1件・既存CLI locale 16件・native dispatch/help登録2件が成功した。
継承pipe、help停止、helpと操作の共有期限を各30秒で実測した。独立静的reviewはCODE_REVIEW_GO。
一方、full CLI 4件は宣言依存`qrcode`欠如でmodule読込に失敗し、挙動をまだ検証できていない。
Clippyは既存の7件（独立PR #667）で失敗する。無断install・依存のコピー・skipで回避しない。

Linux/macOS、宣言依存を備えたfull CLI、旧Node CLI・Rust直・bridgeの同条件性能三者比較は未検証。
単発CLIのpeakメモリと常駐・プロセスツリー合計メモリは区別する。
性能改善やproduct Ready/GO、#453/#516全体の完了をここでは宣言しない。
