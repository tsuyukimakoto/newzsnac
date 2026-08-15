## Why

RSS、Hacker News、Bluesky、Zennに分散した情報を、利用者が自分の関心に合わせて短時間で読み進められる場所が必要である。
外部サービスへ閲覧履歴や本文を送らず、ローカルで収集、要約、翻訳、優先度判定まで行える個人用リーダーを構築する。

## What Changes

- RSS/Atom、Hacker News、Bluesky、Zennの取得対象を登録して定期収集する
- 取得した項目をSQLiteへ正規化して保存し、同一記事と類似記事をまとめる
- LM Studio上のQwenで日本語要約、翻訳、ラベル、優先度とその理由を生成する
- 背景処理が停止していても、収集済み記事の閲覧、検索、既読、保存を継続できるようにする
- キーボード中心の連続閲覧、精読、安定した読書セッションを提供する
- 記事、著者、リンク、トピック、共有関係から情報源候補を提示し、利用者の確認後に登録する
- OpenClawから検証済みのアプリケーション操作を呼び出せるようにする

## Non-goals

- Xからの収集または`x_search`との統合
- 情報源の自動購読
- 試用購読または期間限定購読
- クラウド上の言語モデルへの本文送信
- 複数利用者、組織共有、ソーシャル機能

## Capabilities

### New Capabilities

- `source-management`: 取得対象の解決、登録、設定、一時停止、削除を扱う
- `content-collection`: 4種類の情報源の定期取得、正規化、本文抽出、重複統合を扱う
- `content-enrichment`: Qwenによる要約、翻訳、ラベル、優先度判定と障害時の動作を扱う
- `reading-workflow`: 高速閲覧、精読、既読、保存、検索、読書セッションを扱う
- `source-discovery`: 記事や購読中の情報源から新しい情報源候補を提示する
- `external-control`: OpenClawなどの外部クライアントへ検証済み操作を公開する

### Modified Capabilities

なし

## Impact

- 定期収集プロセス、SQLiteスキーマ、本文抽出処理、LM Studioワーカーを新設する
- デスクトップ向けWebインターフェースと内部操作APIを新設する
- miseで固定したNode.js、npm、OpenSpecを開発環境として使用する
- RSS/Atom配信元、Hacker News API、Bluesky API、Zenn配信フィードへのネットワークアクセスが発生する
