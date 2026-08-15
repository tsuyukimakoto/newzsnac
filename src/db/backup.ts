import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";

export async function createBackup(database: DatabaseSync, destinationPath: string): Promise<number> {
  mkdirSync(dirname(destinationPath), { recursive: true });
  return backup(database, destinationPath);
}

export function restoreBackup(backupPath: string, databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  copyFileSync(backupPath, databasePath);
}
