# Newzsnac

Newzsnac は RSS/Atom、Hacker News、Bluesky、Zenn をローカルの SQLite に収集する個人用ニュースリーダーです。収集済みの記事はネットワークや LM Studio が停止していても閲覧、検索、既読、保存を操作できます。LM Studio に Qwen が読み込まれている場合は、日本語要約、ラベル、優先度判定、要求時の翻訳も実行します。

## 主な機能

- RSS/Atomフィード、フィードを公開するWebサイト、Hacker News、Bluesky、Zennを情報源として登録
- 記事の収集、本文保存、検索、既読管理、保存、関心の記録をSQLiteへ集約
- 公開日時、要約、見出しと説明から成るKEY POINTSを中心にしたIndexと記事ペイン
- 分析済み、準備中、取得失敗、分析失敗を分けたIndexと、失敗記事の個別再試行
- `j`、`k`を中心としたキーボード操作と、既読記事を隠しながら読み進める連続閲覧
- 保存済み全文のアプリ内表示と、公開元を新しいタブで開く二つの読み方
- LM Studioによる日本語要約、ラベル、優先度判定、翻訳
- 「気になった」記事との意味的な近さに基づく未読記事の推薦
- 選択中の記事についてローカルLLMと問答し、別のAI Chatへ渡す文章を生成
- CLIとOpenClawから、画面と同じ検証済みの操作を実行
- SQLiteのオンラインバックアップと復元

## 考え方

Newzsnacは、情報を集める処理と読む操作を分離したローカルファーストのアプリケーションです。SQLiteを正本とし、一度収集した記事はネットワーク接続や情報源の状態にかかわらず読めます。LM Studioも任意の補助機能として扱い、停止中の分析ジョブは保持しながら、収集済み記事の閲覧や整理を継続できます。

推薦では、一般的なIT記事であることを読む理由にはしません。利用者が明示的に「気になった」と記録した記事を基準に、内容が十分近い未読記事だけへ「読むべきかも？」を表示します。固定の上位件数ではなく類似度の閾値で判定し、根拠になった記事と類似度も表示します。推薦や要約は判断材料であり、購読、既読、保存、関心の状態をAIが自動で変更することはありません。

記事、要約、ベクトル、問答履歴はローカルのSQLiteに保存されます。分析、埋め込み、記事問答は設定したLM Studioへ送られますが、外部のAI Chatへ自動送信しません。このアプリケーションは個人の端末での利用を前提とし、Webサーバーは初期状態でループバックアドレスだけを使用します。

## 起動

必要な環境は Node.js 24 以降です。mise を使う場合は、リポジトリに固定されたバージョンを利用できます。

```sh
mise install
mise run setup
mise run start
```

ブラウザーで [http://127.0.0.1:4317](http://127.0.0.1:4317) を開きます。`mise run start` はビルド後、次の三つをまとめて起動します。

- Web 画面と操作 API
- 10秒ごとに登録済み情報源を確認する収集ワーカー
- 2秒ごとに分析・翻訳ジョブを確認する分析ワーカー

終了するときは、`mise run start` を実行したターミナルで `Ctrl-C` を押します。

## 最初の情報源を追加する

1. 左下の「情報源を追加」を押す
2. RSS/Atom またはWebサイトのURL、`https://news.ycombinator.com`、Zenn URL、Blueskyハンドルのいずれかを入力する
3. 「内容を確認」で取得先、最近の記事、推定週間件数を確認する
4. 「この情報源を追加」を押す

追加した情報源は10秒以内に最初の収集対象になります。画面の総記事数、未読数、保存数、情報源別件数は SQLite の内容から集計されます。初期状態ではすべて0件です。

## LM Studio

LM Studio が停止している場合も、収集と閲覧は動作します。要約と翻訳を使う場合は LM Studio で Qwen を読み込み、OpenAI互換のローカルサーバーを `http://127.0.0.1:1234/v1` で起動します。初期値の `qwen` を名前に含むモデルが読み込まれている場合は、その実際のモデルIDを自動選択します。別名のモデルを使う場合は、起動前に指定します。

```sh
NEWSZNAC_LM_STUDIO_MODEL='実際のモデルID' mise run start
```

画面左下に `SQLite · LM Studio (モデルID)` と表示されれば接続済みです。`LM Studio 未接続` の場合、分析ジョブは SQLite に残り、接続後に再試行されます。

記事分析ではモデルの推論出力を無効にし、JSON Schemaに沿った最終回答だけを保存します。長い記事は保存本文を変更せず、分析時だけ冒頭と末尾を残して既定で12,000文字以内に収めます。

## 気になった記事と「読むべきかも？」

記事ペインの「気になった」または`i`キーで、保存・既読とは別に関心を記録できます。左側の「気になった」から後で一覧できます。

内容が近い未読記事へ「読むべきかも？」を表示するには、LM Studioで埋め込みモデルを読み込み、そのモデルIDを指定して起動します。埋め込みにはOpenAI互換の`/v1/embeddings`を使い、記事本文とベクトルはこの端末の外へ送りません。

```sh
NEWSZNAC_EMBEDDING_MODEL='LM Studioで読み込んだ埋め込みモデルID' mise run start
```

初回起動後は新しい記事から順に背景でベクトル化します。「気になった」記事と類似度0.86以上の未読記事が「読むべきかも？」へ現れ、根拠になった記事名と類似度を確認できます。記事ごとに閾値だけで判定するため、固定の表示件数や上位件数による打ち切りはありません。埋め込みモデルを停止しても、収集、閲覧、検索、関心フラグの変更は継続します。再起動後に未処理ジョブが再試行されます。

閾値を調整する場合は`NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD`へ`-1`から`1`の値を指定します。モデルや入力形式を変更してベクトルを再生成する場合は、`NEWSZNAC_EMBEDDING_INPUT_VERSION`を新しい値へ変更します。旧ベクトルは保持されますが、現在のモデルと入力版の推薦だけが表示されます。

## 記事を読み進める

通常のIndexには本文取得と分析が完了した記事だけが表示されます。分析待ちの記事は左側の「準備中」、本文を取得できなかった記事は「取得失敗」、分析の再試行上限に達した記事は「分析失敗」から確認できます。「取得失敗」で「本文を再取得」を押すと元URLへ再度アクセスします。「分析失敗」で「分析を再試行」を押すと、保存済み本文を使って分析をやり直します。どちらも再試行後は「準備中」へ移り、分析完了後に通常のIndexへ表示されます。

Indexの「既読を隠す」が有効な場合、別の記事へ移ると直前の記事が既読になり、Indexから外れます。設定はブラウザーに保存されます。既読記事も含めて探す場合はチェックを外します。本文をスクロールしただけでは既読になりません。

記事ペインでは、二つの読み方を選べます。

- 「保存済み全文を読む」または`Space`で、収集済み本文をアプリ内に表示
- 「元の記事を開く」または`o`で、公開元を新しいタブに表示

保存済み本文はオフラインでも読めます。公開元を開く場合はネットワーク接続が必要です。

## 記事についてローカルAIに聞く

記事ペイン下部の「この記事について聞く」から、選択中の記事についてLM Studioへ質問できます。タイトル、URL、要約、保存済み本文、同じ記事の過去の問答が文脈としてローカルLLMへ渡されます。質問と回答は記事ごとにSQLiteへ保存され、記事へ戻ったときに復元されます。

「別のAI Chatへの引き継ぎ文」は、記事URL、要約、問答履歴をプレーンテキストへまとめます。内容を画面で確認してコピーし、利用するAI Chatへ自分で貼り付けます。Newzsnacが外部AIサービスへ問答を自動送信することはありません。

LM Studioが停止している場合は問答欄にエラーが表示されますが、Index、保存済み本文、原文を開く操作は利用できます。

## 主な設定

プロジェクト直下の`.env`を起動時に自動で読み込みます。ファイルはGitの管理対象外です。設定の優先順位は、`config.ts`の初期値、`.env`、起動時の環境変数の順で、後にある値が優先されます。`.env`がない場合は初期値と環境変数だけで動作します。

```dotenv
NEWSZNAC_DATABASE_PATH=data/newzsnac.sqlite
NEWSZNAC_LM_STUDIO_URL=http://127.0.0.1:1234/v1
NEWSZNAC_LM_STUDIO_MODEL=qwen/qwen3.8-27b
NEWSZNAC_ANALYSIS_MAX_CHARACTERS=12000
NEWSZNAC_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

| 環境変数 | 初期値 | 用途 |
| --- | --- | --- |
| `NEWSZNAC_DATABASE_PATH` | `data/newzsnac.sqlite` | SQLiteファイル |
| `NEWSZNAC_PORT` | `4317` | Web画面のポート |
| `NEWSZNAC_HOST` | `127.0.0.1` | Web画面の待受先。ループバックのみ |
| `NEWSZNAC_LM_STUDIO_URL` | `http://127.0.0.1:1234/v1` | LM StudioのOpenAI互換API |
| `NEWSZNAC_LM_STUDIO_MODEL` | `qwen` | 分析、翻訳、記事問答に使うモデルID |
| `NEWSZNAC_ANALYSIS_MAX_CHARACTERS` | `12000` | 分析時にLM Studioへ渡す記事本文の最大文字数。超過時は冒頭と末尾を保持 |
| `NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS` | `24000` | 記事問答でLM Studioへ渡す文脈の最大文字数 |
| `NEWSZNAC_EMBEDDING_MODEL` | 未設定 | 記事ベクトルに使うLM Studioの埋め込みモデルID |
| `NEWSZNAC_EMBEDDING_MAX_CHARACTERS` | `12000` | 埋め込み入力へ含める最大文字数 |
| `NEWSZNAC_EMBEDDING_INPUT_VERSION` | `embedding-v1` | 埋め込み入力形式の版。変更すると再生成 |
| `NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD` | `0.86` | 「読むべきかも？」に表示する最低類似度 |
| `NEWSZNAC_ANALYSIS_PROMPT_VERSION` | `analysis-v2` | 分析結果のプロンプト版 |
| `NEWSZNAC_TRANSLATION_PROMPT_VERSION` | `translate-v1` | 翻訳結果のプロンプト版 |

Web、収集、分析を個別に起動する場合は、次のコマンドを使います。

```sh
mise run server
mise run worker:collection -- --watch
mise run worker:analysis -- --watch
```

CLIとOpenClawからの操作は [docs/openclaw.md](docs/openclaw.md)、SQLiteのバックアップは [docs/backup.md](docs/backup.md) を参照してください。

## 開発とOpenSpec

このプロジェクトでは、機能の提案、設計、仕様、実装タスクの管理に[OpenSpec](https://github.com/Fission-AI/OpenSpec)を使用しています。共有する設計資料は`openspec/`に保存し、Gitで追跡します。`.codex/skills/`はOpenSpec CLIがCodex向けに生成する連携ファイルのため、リポジトリでは追跡しません。

クローン後にOpenSpecとCodex向けの連携ファイルを用意する場合は、OpenSpec CLIをインストールして初期化します。

```sh
mise install
mise run spec:init
```

OpenSpec CLIを更新した後は、プロジェクト直下で次を実行すると連携ファイルを再生成できます。

```sh
mise run spec:update
```

OpenSpecの設計資料を含む現在の仕様は、次のコマンドで検証できます。

```sh
mise run spec:validate
```

## 検証

```sh
mise run test
mise run spec:validate
```
