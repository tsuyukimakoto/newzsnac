## Why

Qwen 3.8の推論量をLM Studio側の既定値へ任せると、全文翻訳と記事問答で必要以上に推論時間と出力トークンを使う可能性がある。Newzsnacから呼び出しごとの推論量を明示し、ローカル環境に合わせて変更できるようにする。

## What Changes

- LM Studioの自由文生成に使用するreasoning effortを設定へ追加し、既定値を`medium`にする。
- `.env`または起動時の環境変数でreasoning effortを上書きできるようにする。
- 全文翻訳と記事問答のOpenAI互換リクエストへ設定値を送る。
- 構造化出力の安定性のため推論を無効にしている記事分析は、従来どおり`none`を明示する。
- 対応値以外は起動時に拒否し、LM Studioへ不正な値を送らない。

非目標:

- LM Studioのモデルロード設定やモデル自体の既定値は変更しない。
- 保存済みの分析、翻訳、問答を再生成しない。
- 埋め込み生成へ推論設定を適用しない。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `content-enrichment`: 全文翻訳へ設定済みのreasoning effortを適用し、記事分析の推論無効化を維持する。
- `article-ai-chat`: 記事問答へ設定済みのreasoning effortを適用する。

## Impact

- `src/config.ts`の設定契約と`.env`読込
- `src/enrichment/client.ts`のLM Studio Chat Completionsリクエスト
- 分析ワーカーとWebアプリケーションにおけるクライアント生成
- READMEのローカル設定手順
- 設定およびLM Studioクライアントのテスト
