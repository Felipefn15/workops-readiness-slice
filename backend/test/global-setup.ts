import pg from 'pg';
import { TEST_DATABASE_URL } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

/** Creates workops_test if missing and migrates it. Tests run against a REAL Postgres, never mocks. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const db = createPool(TEST_DATABASE_URL, 2);
  await migrate(db);
  await db.end();
}
