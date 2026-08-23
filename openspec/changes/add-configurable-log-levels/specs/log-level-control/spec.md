## Purpose

アプリケーション全体の出力を共通の重大度と最小レベル設定で制御し、通常運用では意味のある動作と問題を確認しながら、必要な場合だけ高頻度の詳細を表示できるようにする。

## ADDED Requirements

### Requirement: 共通ログレベル
システムはすべてのアプリケーションログを `DEBUG`、`INFO`、`WARN`、`ERROR` のいずれかとして共通の仕組みから出力しなければならない（SHALL）。重大度は `DEBUG < INFO < WARN < ERROR` の順でなければならない（MUST）。各ログ行は短いローカル日時、レベル、イベント名を含まなければならない（MUST）。

#### Scenario: 各レベルを出力する
- **WHEN** 各重大度のイベントをロガーへ渡す
- **THEN** 各行は対応する `DEBUG`、`INFO`、`WARN`、`ERROR` を一つだけ含む

### Requirement: 最小ログレベルの設定
システムは `NEWSZNAC_LOG_LEVEL` に `debug`、`info`、`warn`、`error` のいずれかを受け付け、指定したレベル以上のログだけを出力しなければならない（SHALL）。未設定時は `info` を使用しなければならない（MUST）。不正な値では起動を拒否しなければならない（MUST）。

#### Scenario: 初期設定で起動する
- **WHEN** `NEWSZNAC_LOG_LEVEL` が未設定である
- **THEN** システムはINFO、WARN、ERRORを出力し、DEBUGを出力しない

#### Scenario: debugを設定する
- **WHEN** `NEWSZNAC_LOG_LEVEL=debug` で起動する
- **THEN** システムはDEBUG、INFO、WARN、ERRORを出力する

#### Scenario: warnを設定する
- **WHEN** `NEWSZNAC_LOG_LEVEL=warn` で起動する
- **THEN** システムはWARNとERRORだけを出力する

#### Scenario: 不正な値を設定する
- **WHEN** `NEWSZNAC_LOG_LEVEL` に定義外の値を指定する
- **THEN** 設定読み込みは許可される値を示すエラーで失敗する

### Requirement: レベルに応じた出力先
システムはDEBUGとINFOを標準出力へ、WARNとERRORを標準エラー出力へ書き出さなければならない（SHALL）。レベルで抑制されたイベントはどちらにも書き出してはならない（MUST NOT）。

#### Scenario: 通常ログと問題ログを分離する
- **WHEN** INFOとWARNを一件ずつ出力する
- **THEN** INFOは標準出力だけに、WARNは標準エラー出力だけに現れる

### Requirement: INFOイベントの分類
システムはWeb、収集ワーカー、分析ワーカーの起動完了と、収集、記事分析、推薦など利用者がアプリケーションの動作を把握するための完了イベントをINFOとして出力しなければならない（SHALL）。

#### Scenario: アプリケーションを起動する
- **WHEN** Web、収集ワーカー、分析ワーカーが利用可能になる
- **THEN** 各サービスはホスト、ポート、監視モードなど利用可能な起動情報をINFOで出力する

#### Scenario: 記事処理が完了する
- **WHEN** 収集、記事分析、推薦計算のいずれかが意味のある処理を完了する
- **THEN** システムは既定のINFO設定で処理結果を出力する

### Requirement: DEBUGイベントの分類
システムは収集および分析ワーカーの定期ポーリング結果と、設定で有効化された詳細分析テレメトリをDEBUGとして出力しなければならない（SHALL）。ポーリングログは処理件数が0件の場合も含め、各周期の結果と所要時間を含まなければならない（MUST）。

#### Scenario: 初期設定で空ポーリングする
- **WHEN** INFO設定でワーカーが処理対象0件のポーリングを行う
- **THEN** ポーリングログは表示されない

#### Scenario: debug設定で空ポーリングする
- **WHEN** DEBUG設定でワーカーが処理対象0件のポーリングを行う
- **THEN** ワーカー名、処理件数0、所要時間を含むDEBUGログが表示される

### Requirement: WARNイベントの分類
システムは処理全体を停止せず再試行または継続できるものの、利用者の注意が必要な事象をWARNとして出力しなければならない（SHALL）。個別の情報源取得失敗はWARNに分類しなければならない（MUST）。

#### Scenario: 一つの情報源取得が失敗する
- **WHEN** 収集サイクル内の一つの情報源が失敗し、他の情報源の処理を継続する
- **THEN** 情報源IDと原因を含むWARNログが表示される

### Requirement: ERRORイベントの分類
システムは要求された処理が失敗した事象をERRORとして出力しなければならない（SHALL）。分析・推薦などのジョブ試行失敗、子プロセスの予期しない停止、サービス起動後の致命的失敗はERRORに分類し、利用可能なジョブID、記事ID、試行回数、原因を含めなければならない（MUST）。

#### Scenario: ジョブ試行が失敗する
- **WHEN** バックグラウンドジョブが失敗して再試行待ちまたは失敗状態へ移る
- **THEN** ジョブ種別、ジョブID、記事ID、試行回数、原因を含むERRORログが表示される

#### Scenario: 子プロセスが予期せず停止する
- **WHEN** 親プロセスがWebまたはワーカーの予期しない停止を検出する
- **THEN** サービス名と終了理由を含むERRORログが表示される

### Requirement: JSON応答との分離
システムはCLI、停止コマンド、HTTP APIが呼び出し元へ返すJSON応答をログレベルフィルターの対象にしてはならない（MUST NOT）。

#### Scenario: INFOより高いレベルでCLIを実行する
- **WHEN** `NEWSZNAC_LOG_LEVEL=error` でCLIの正常なコマンドを実行する
- **THEN** CLIは従来どおり呼び出し結果のJSONを標準出力へ返す
