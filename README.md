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

## 主な設定

| 環境変数 | 初期値 | 用途 |
| --- | --- | --- |
| `NEWSZNAC_DATABASE_PATH` | `data/newzsnac.sqlite` | SQLiteファイル |
| `NEWSZNAC_PORT` | `4317` | Web画面のポート |
| `NEWSZNAC_HOST` | `127.0.0.1` | Web画面の待受先。ループバックのみ |
| `NEWSZNAC_LM_STUDIO_URL` | `http://127.0.0.1:1234/v1` | LM StudioのOpenAI互換API |
| `NEWSZNAC_LM_STUDIO_MODEL` | `qwen` | 分析と翻訳に使うモデルID |
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
openspec validate build-personal-news-reader --strict
```
