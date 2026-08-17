## Why

Qwen 3.8の推論量をLM Studio側の既定値へ任せたり、記事分析だけ根拠のない小さな出力上限と推論無効化へ固定したりすると、品質と安定性を比較できない。Newzsnacから推論量と十分な出力上限を明示し、実際の利用量を観測できるようにする。

## What Changes

- LM Studioの全テキスト生成に使用するreasoning effortを設定へ追加し、既定値を`medium`にする。
- `.env`または起動時の環境変数でreasoning effortを上書きできるようにする。
- 記事分析、全文翻訳、記事問答のOpenAI互換リクエストへ設定値を送る。
- 記事分析の最大出力を`8,096`トークンへ広げる。
- 記事分析ごとに終了理由、入力・出力・推論トークン数、最終回答の文字数、検証結果を本文を含めず構造化ログへ出す。
- 分析ログは既定で無効にし、`.env`または起動時の環境変数で明示的に有効化できるようにする。
- 対応値以外は起動時に拒否し、LM Studioへ不正な値を送らない。

非目標:

- LM Studioのモデルロード設定やモデル自体の既定値は変更しない。
- 保存済みの分析、翻訳、問答を再生成しない。
- 埋め込み生成へ推論設定を適用しない。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `content-enrichment`: 記事分析と全文翻訳へ設定済みのreasoning effortを適用し、記事分析の出力上限と利用量を観測可能にする。
- `article-ai-chat`: 記事問答へ設定済みのreasoning effortを適用する。

## Impact

- `src/config.ts`の設定契約と`.env`読込
- `src/enrichment/client.ts`のLM Studio Chat Completionsリクエスト
- 分析ワーカーとWebアプリケーションにおけるクライアント生成
- READMEのローカル設定手順
- 設定およびLM Studioクライアントのテスト
