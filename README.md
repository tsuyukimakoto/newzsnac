# Newzsnac

Newzsnac は RSS/Atom、Hacker News、Bluesky、Zenn をローカルの SQLite に収集する個人用ニュースリーダーです。収集済みの記事はネットワークや LM Studio が停止していても閲覧、検索、既読、保存を操作できます。LM Studio に Qwen が読み込まれている場合は、日本語要約、ラベル、優先度判定、要求時の翻訳も実行します。

## 起動

必要な環境は Node.js 24 以降です。mise を使う場合は、リポジトリに固定されたバージョンを利用できます。

```sh
mise install
npm install
npm run build
npm start
```

ブラウザーで [http://127.0.0.1:4317](http://127.0.0.1:4317) を開きます。`npm start` は次の三つをまとめて起動します。

- Web 画面と操作 API
- 10秒ごとに登録済み情報源を確認する収集ワーカー
- 2秒ごとに分析・翻訳ジョブを確認する分析ワーカー

終了するときは、`npm start` を実行したターミナルで `Ctrl-C` を押します。

## 最初の情報源を追加する

1. 左下の「情報源を追加」を押す
2. RSS/Atom またはWebサイトのURL、`https://news.ycombinator.com`、Zenn URL、Blueskyハンドルのいずれかを入力する
3. 「内容を確認」で取得先、最近の記事、推定週間件数を確認する
4. 「この情報源を追加」を押す

追加した情報源は10秒以内に最初の収集対象になります。画面の総記事数、未読数、保存数、情報源別件数は SQLite の内容から集計されます。初期状態ではすべて0件です。

## LM Studio

LM Studio が停止している場合も、収集と閲覧は動作します。要約と翻訳を使う場合は LM Studio で Qwen を読み込み、OpenAI互換のローカルサーバーを `http://127.0.0.1:1234/v1` で起動します。初期値の `qwen` を名前に含むモデルが読み込まれている場合は、その実際のモデルIDを自動選択します。別名のモデルを使う場合は、起動前に指定します。

```sh
NEWSZNAC_LM_STUDIO_MODEL='実際のモデルID' npm start
```

画面左下に `SQLite · LM Studio (モデルID)` と表示されれば接続済みです。`LM Studio 未接続` の場合、分析ジョブは SQLite に残り、接続後に再試行されます。

## 気になった記事と「読むべきかも？」

記事ペインの「気になった」または`i`キーで、保存・既読とは別に関心を記録できます。左側の「気になった」から後で一覧できます。

内容が近い未読記事へ「読むべきかも？」を表示するには、LM Studioで埋め込みモデルを読み込み、そのモデルIDを指定して起動します。埋め込みにはOpenAI互換の`/v1/embeddings`を使い、記事本文とベクトルはこの端末の外へ送りません。

```sh
NEWSZNAC_EMBEDDING_MODEL='LM Studioで読み込んだ埋め込みモデルID' npm start
```

初回起動後は新しい記事から順に背景でベクトル化します。「気になった」記事と類似度0.86以上の未読記事が「読むべきかも？」へ現れ、根拠になった記事名と類似度を確認できます。記事ごとに閾値だけで判定するため、固定の表示件数や上位件数による打ち切りはありません。埋め込みモデルを停止しても、収集、閲覧、検索、関心フラグの変更は継続します。再起動後に未処理ジョブが再試行されます。

閾値を調整する場合は`NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD`へ`-1`から`1`の値を指定します。モデルや入力形式を変更してベクトルを再生成する場合は、`NEWSZNAC_EMBEDDING_INPUT_VERSION`を新しい値へ変更します。旧ベクトルは保持されますが、現在のモデルと入力版の推薦だけが表示されます。

## 記事を読み進める

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

| 環境変数 | 初期値 | 用途 |
| --- | --- | --- |
| `NEWSZNAC_DATABASE_PATH` | `data/newzsnac.sqlite` | SQLiteファイル |
| `NEWSZNAC_PORT` | `4317` | Web画面のポート |
| `NEWSZNAC_HOST` | `127.0.0.1` | Web画面の待受先。ループバックのみ |
| `NEWSZNAC_LM_STUDIO_URL` | `http://127.0.0.1:1234/v1` | LM StudioのOpenAI互換API |
| `NEWSZNAC_LM_STUDIO_MODEL` | `qwen` | 分析、翻訳、記事問答に使うモデルID |
| `NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS` | `24000` | 記事問答でLM Studioへ渡す文脈の最大文字数 |
| `NEWSZNAC_EMBEDDING_MODEL` | 未設定 | 記事ベクトルに使うLM Studioの埋め込みモデルID |
| `NEWSZNAC_EMBEDDING_MAX_CHARACTERS` | `12000` | 埋め込み入力へ含める最大文字数 |
| `NEWSZNAC_EMBEDDING_INPUT_VERSION` | `embedding-v1` | 埋め込み入力形式の版。変更すると再生成 |
| `NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD` | `0.86` | 「読むべきかも？」に表示する最低類似度 |
| `NEWSZNAC_ANALYSIS_PROMPT_VERSION` | `analysis-v1` | 分析結果のプロンプト版 |
| `NEWSZNAC_TRANSLATION_PROMPT_VERSION` | `translate-v1` | 翻訳結果のプロンプト版 |

Web、収集、分析を個別に起動する場合は、次のコマンドを使います。

```sh
npm run server
npm run worker:collection -- --watch
npm run worker:analysis -- --watch
```

CLIとOpenClawからの操作は [docs/openclaw.md](docs/openclaw.md)、SQLiteのバックアップは [docs/backup.md](docs/backup.md) を参照してください。

## 検証

```sh
npm test
openspec validate add-interest-based-recommendations --strict
openspec validate improve-reading-and-article-chat --strict
```
