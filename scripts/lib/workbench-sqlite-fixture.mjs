// Independent read-only SQLite assertions for isolated binary-contract fixtures.
// Never imported by production code; no compatibility reader or diagnostic IPC.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function operationRecords(root, operation) {
  const database = new DatabaseSync(join(root, 'workbench.sqlite3'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=5000');
    if (database.prepare('PRAGMA user_version').get().user_version !== 3)
      throw new Error('fixture requires a format3 database');
    const select = 'SELECT operation,fingerprint,status,result,checksum FROM operations';
    const rows =
      operation === undefined
        ? database.prepare(`${select} ORDER BY operation`).all()
        : database.prepare(`${select} WHERE operation=? ORDER BY operation`).all(operation);
    return rows.map((row) => ({
      ...row,
      result: row.result === null ? null : Buffer.from(row.result),
    }));
  } finally {
    database.close();
  }
}
