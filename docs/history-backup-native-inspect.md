# History backup inspect のnative境界

## 実行経路

既存の `rdsh-dashboard backup inspect --archive-file <file>` は、従来のNode CLIで
引数解析・表示言語とsettingsの検証・backup固有オプションの検証を完了してから、
解決済みの `rdsh` 実行ファイルへ次を渡す。

```text
rdsh backup-inspect --archive-file=<file>
```

ファイル読取、UTF-8/JSON処理、schema/content/reference/integrity検証、inspection投影、
JSON出力はRust側だけで行う。JS側はarchiveを再読込・再検証しない。
spawn失敗、非zero終了、signal、30秒deadlineに対するJS fallbackはない。
非zero終了コードは転送し、signalはexit 1、timeoutはowned childを停止して失敗とする。
`export`、`restore`等の別経路が使用する既存JS validator/readerは削除しない。

## Nodeを必要としない独立入口

上記のように `backup-inspect` を**最初の引数**にした直接実行は、launcherのsettings、
profile、guard、Node解決より前に分岐する。入力archive以外のユーザーsettings/historyを
必要としない。入力エラーはstderr、exit 1、成功は2スペースのJSONと末尾LF、exit 0。
表示言語は `RDSH_LANG=en|ja|zh-CN` などの既存locale環境で選ぶ。

既存dashboard CLIそのものは依然Nodeとdashboardのnpm dependenciesを必要とする。
「inspect全体のNode launcher除去」や他のbackup操作のnative化を意味しない。
`rdsh --language ... backup-inspect ...` のようなglobal option先行形は通常launcher経路であり、
上記のsettings非依存保証の対象ではない。

## 読取・JSON・検証

- raw fileは最大2 MiB。leafはregular fileのみ。hardlinkおよびparent linkは許容する。
- Unixはlstatとno-follow/nonblocking open後のdevice/inodeを比較する。
- Windowsはno-follow metadata handleでtype/size/volume/file indexを取得し、read handleと
  identityを比較する。leaf reparse/directoryは拒否する。汎用confined readerの保護は変更しない。
- 同じread handleから最大2 MiB+1 byteだけ読み、増加時も上限を守る。UTF-8はfatalで、先頭BOMのみ除く。
- 既存 `serde_json` の `raw_value` featureを利用する。全入力のsyntaxを先に確認し、
  decoded duplicate keyは最初の挿入位置と最後の値を保持する。破棄値もsyntaxは検査するが、
  overflow、lone surrogate、deep valueを不必要にtyped valueへ展開しない。
  stringifyはtoken/container終端を一度だけ索引化し、子孫のRawValue再parseによるO(n²)走査を避ける。
- `JSON.stringify`相当のサイズ検査をschemaより先に行い、続いてheader/source/selection/policy、
  records、参照、content、review lists、integrityの順で検査する。
  integrityのalgorithm/digestもraw値の型・値を検査した後でのみ通常のValueへ変換する。
- safe integerはbinary64として評価し、文字列上の整数表記制限には置換しない。
  UTF-16長、ECMAScript空白（NEL除外・FEFF含む）、ASCII word boundaryを明示する。
  URL tokenは非重複で消費し、既存URL parserでcredential/query/fragmentを検査する。
- hashは既存canonical順序とSHA-256を維持する。新規crateやlockfile更新はない。

## 検証入口と未検証境界

```sh
cargo build --locked
node --test dashboard/test/backup-inspect-native.test.mjs
# 宣言済dashboard dependenciesを備えた環境で、本物の既存CLIをspawnする（skipなし）
node --test dashboard/test/backup-inspect-cli.test.mjs
sh scripts/check.sh quick
BIN="$PWD/target/debug/rdsh" sh tests/regress.sh
```

native差分suiteはraw inputから既存JS reader/validator/projectionをoracleにして、
exit/stdout/stderr（改行を含む）を比較する。pure/adapter検証とwhole CLIの実起動は別suite。
後者は全locale、実際のoption table、主要argv/settings優先、native故障のfail-closedを扱う。
Node-less試験はPATHを空にし、ownedな壊れたsettingsを置いて直接native入口を実行する。

**既知のdeep-input診断差**: 上限内2,000,007 byte・100万階層の未知fieldは、
旧Nodeがサイズ検査中に `RangeError: Maximum call stack size exceeded`、nativeが
反復走査後に `invalid_backup_fields` を返す。これは完全一致とは扱わない。
永久負荷testは125k/250k/1m階層をowned childの10秒期限で測定し、Windows debug実測は
約55/91/303msだった。任意depth制限やJS fallbackは追加していない。

readerのsnapshot→open間の置換拒否、open後のpath置換に対する同一handle読取、
metadata確認後の成長に対するbounded readは、ownedなfixtureを用いた決定的なunit testで確認する。
Windows leaf file symlink、Unix FIFO、権限拒否、同時並行writerによるraceの実機再現は、
このWindowsローカル試験の成功だけでは立証しない。Unix FIFO testはUnix CIで実行する。
任意binary64の全組合せ・全WHATWG URL実装差の
網羅性も主張しない。CIおよび独立reviewでこれらとwhole CLIの結果を別に確認する。
この文書はruntime境界の説明であり、#453/#516全体の完了、product Ready/GOの宣言ではない。
