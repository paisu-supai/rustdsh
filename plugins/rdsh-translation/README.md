# 回答の日本語訳を表示する

Issue #448 Step 1。規模: 中（既存のDSHコマンドとWeb UIスロットをつなぐプラグイン）。
DSHが所有する会話・モデル実行のホストアダプタとして実装し、独自のエージェントループは追加しません。

完了した英語・中国語回答のアクション行で「日本語訳を表示」を押すと、
現在の会話で直近に使ったprovider/modelへ独立した翻訳リクエストを1回送り、訳文ダイアログを開きます。
生成中の表示、二重クリック防止、失敗時の再試行に対応します。
日本語・コードだけ・中断された回答にはボタンを出しません。
かな比率による判定なので、日本語の漢字だけの文章などを誤判定する場合があります。

原文・会話のsurface・次のモデル入力は変更しません。翻訳の追指示や新しいターンは追加しません。
DSHの通常の`command/run`・`command/done`ログには操作と結果が記録されます。
訳文表示はコンポーネントの一時状態で、画面を再読込すると消えます。
履歴の置換（Step 2）、自動翻訳、モデルの切替、翻訳結果の専用保存は対象外です。

## 導入と操作

リポジトリの`plugins/install.sh`は`PROFILE=web`または`PROFILE=desktop`で導入します。
除外する場合は`TRANSLATION=0`を指定します。headless/TUIでは既定で導入しません。
個別導入は、Webプロファイルで`dsh plugin --profile web add /絶対パス/plugins/rdsh-translation`、
Desktopでは`rdsh desktop install --package /絶対パス/plugins/rdsh-translation`を使います。
導入後に対象のWeb UIを開き直してください。

`$DSH_HOME/rdsh.json`の`translation.kana_threshold`で表示しきい値を設定できます。
既定0.08、許容範囲0.01〜0.5。変更後は画面を再読込してください。
翻訳の呼出しには現在のモデルの通常の利用料金・利用枠がかかります。

表示文言とコマンド説明・エラー文は表示言語に追従します。Web UIはDSHのlocaleカタログ
（`rdsh-translation`名前空間のen/zh/ja辞書）を使い、日本語の言語定義はrdsh-settingsが
所有するためこのプラグインからは言語を追加しません。ホスト側の文言は`RDSH_LANG`、
`rdsh.json`の`general.language`、OSロケールの順に解決します。プラグイン一覧の
タイトル・説明は`locale/en.json`・`locale/ja.json`・`locale/zh.json`を使用します。

コードブロック、インラインコード、識別子・パス等は保護トークンで保持します。
トークンの欠落・重複、空応答、途中終了、64KiBを超える入力/出力はエラーとして表示します。
60秒の期限とDSHの保守処理による排他を使い、生成中の会話は変更しません。

## 検証

`node --test tests/translation-preview.test.mjs`で、ボタンからコマンドの結果表示まで、
原文とsession不変、二重起動、失敗・取消・上限、導入リストを確認します。
同じテストはCIの既存プラグイン検証入口からも読み込みます。
実providerを使った翻訳の品質・実DSH全体での受入は、合成境界の成功とは区別します。

隔離したDSHを用意した場合は、次のコマンドで実AgentLoop・LLM・CommandRuntimeと
実sessionの境界を確認できます。providerだけが固定応答で、モデルAPIを呼びません。

```sh
RDSH_NATIVE_MODULES=/path/to/dsh/node_modules npm run test:translation --prefix tests/e2e
```

画面確認とは別の試験です。実行方法は[受入試験](../../tests/e2e/README.md)を参照してください。

実Webプロファイルでの操作前後のPNG・操作GIFと検証範囲は、
[画面の受入記録](../../docs/evidence/issue448-translation-preview/README.md)を参照してください。
