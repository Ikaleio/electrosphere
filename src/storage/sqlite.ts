import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema.ts';

export interface Storage {
  sqlite: Database;
  db: BunSQLiteDatabase<typeof schema>;
  close(): void;
}

export async function openStorage(dataDir: string): Promise<Storage> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sqlite = new Database(join(dataDir, 'metadata.sqlite'), { create: true, strict: true });
  sqlite.exec('PRAGMA journal_mode=WAL');
  sqlite.exec('PRAGMA synchronous=FULL');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec('PRAGMA busy_timeout=5000');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return {
    sqlite,
    db,
    close() {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      sqlite.close();
    },
  };
}
