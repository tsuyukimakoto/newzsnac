## MODIFIED Requirements

### Requirement: 全文翻訳を要求時に生成する
システムは利用者が全文翻訳を要求した場合に翻訳ジョブを作成し、生成済みの翻訳がある場合は再生成せず返さなければならない（MUST）。翻訳を生成するLM Studioリクエストには設定済みのreasoning effortを明示しなければならず（MUST）、その設定は既定値`medium`を持ち、環境変数または`.env`で上書きできなければならない（MUST）。

#### Scenario: 未翻訳の記事を翻訳する
- **WHEN** 利用者が未翻訳の記事で翻訳表示を選択する
- **THEN** システムは設定済みのreasoning effortで翻訳を要求し、翻訳中であることを表示して、完了後に日本語訳を保存して表示する

#### Scenario: 翻訳済みの記事を再度開く
- **WHEN** 利用者が同じモデル版とプロンプト版で翻訳済みの記事を開く
- **THEN** システムは保存済み翻訳を表示し、新しい翻訳ジョブを作成しない

#### Scenario: reasoning effortを上書きする
- **WHEN** 利用者が環境変数または`.env`へ対応するreasoning effortを設定して起動する
- **THEN** システムは既定値の代わりに設定値を翻訳リクエストへ使用する

#### Scenario: 対応外のreasoning effortを設定する
- **WHEN** 利用者が対応していないreasoning effortを設定して起動する
- **THEN** システムは不正な設定として起動を中止し、LM Studioへリクエストを送らない
