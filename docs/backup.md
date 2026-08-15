# SQLiteのバックアップと復元

Newzsnacの永続データは設定したSQLiteファイルに保存される。標準の保存先は`data/newzsnac.sqlite`である。

## バックアップ

実行中のアプリケーションからバックアップする場合は、`src/db/backup.ts`の`createBackup`を使う。この関数はSQLiteのオンラインバックアップAPIを使用し、WALの内容を含む一つのバックアップファイルを生成する。

## 復元

1. Webアプリケーション、収集ワーカー、分析ワーカーを停止
2. 復元先のSQLiteファイルを別の場所へ退避
3. `restoreBackup(backupPath, databasePath)`でバックアップを復元
4. アプリケーションを起動し、マイグレーションと起動確認を実行
5. 情報源、記事、分析結果、既読、保存状態を確認

復元中はSQLiteへ接続するプロセスを起動しない。
