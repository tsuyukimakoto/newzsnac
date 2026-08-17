# OpenClawからの操作

OpenClawはNewzsnacのCLIを同一端末上で実行する。SQLiteファイルは直接変更せず、CLIが公開するアプリケーション操作を使用する。

## 呼び出し形式

```sh
mise run cli -- <operation> '<JSON input>' --caller openclaw
```

成功時は終了コード`0`で標準出力へ結果を返す。検証エラーや状態遷移エラーは終了コード`2`で標準エラーへ返す。

```json
{
  "ok": true,
  "operation": "article.save",
  "data": {
    "articleId": 42,
    "saved": true
  }
}
```

```json
{
  "ok": false,
  "operation": "source.pause",
  "error": {
    "code": "invalid_operation",
    "message": "Source must be active before changing to paused"
  }
}
```

## 操作例

```sh
mise run cli -- source.resolve '{"input":"https://example.com"}' --caller openclaw
mise run cli -- source.preview '{"input":"https://example.com"}' --caller openclaw
mise run cli -- source.add '{"input":"https://zenn.dev/example"}' --caller openclaw
mise run cli -- source.pause '{"sourceId":1}' --caller openclaw
mise run cli -- source.resume '{"sourceId":1}' --caller openclaw
mise run cli -- candidate.dismiss '{"candidateId":4}' --caller openclaw
mise run cli -- article.search '{"query":"SQLite AND local"}' --caller openclaw
mise run cli -- article.save '{"articleId":42,"saved":true}' --caller openclaw
mise run cli -- article.read '{"articleId":42,"read":true}' --caller openclaw
mise run cli -- article.readLater '{"articleId":42,"readLater":true}' --caller openclaw
mise run cli -- article.readLaterBatch '{"articleIds":[42,43,44]}' --caller openclaw
mise run cli -- article.interest '{"articleId":42,"interested":true}' --caller openclaw
mise run cli -- article.translate '{"articleId":42,"modelId":"qwen","promptVersion":"translate-v1"}' --caller openclaw
```

## 入力規則

- IDは1以上の整数
- `saved`、`read`、`readLater`、`interested`は真偽値
- `article.readLater`で`readLater`を`true`にすると、同じ操作で記事も既読になる。`false`にしても既読状態は維持する
- `article.readLaterBatch`は1件から100件の重複しない`articleIds`を受け取り、対象を「あとで読む」から一括削除する
- 検索語、モデルID、プロンプト版、情報源入力は空でない文字列
- 情報源追加は解決済みURLを受け取らず、`input`を共通の情報源解決処理で検証
- 重複する情報源追加は新規作成せず、既存IDと状態を返却
- 状態変更は操作名、対象、呼び出し元、日時、結果を`action_history`へ保存
