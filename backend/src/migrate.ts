import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DATABASE_URL } from './config.js';
import { createPool, type Db } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Plain-SQL migrations applied in filename order, each in its own transaction, tracked in schema_migrations. */
export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  const c = await db.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7770001)'); // two runners must not race
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    await c.query('SELECT pg_advisory_unlock(7770001)');
  } finally {
    c.release();
  }
  return applied;
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const db = createPool(DATABASE_URL);
  migrate(db)
    .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'database already up to date'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.end());
}
