import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// DATE columns are returned as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url: string, max = 10): Db {
  return new pg.Pool({ connectionString: url, max });
}

/**
 * Runs fn inside one transaction (READ COMMITTED; correctness relies on explicit row locks, see DECISIONS.md).
 * Rolls back on any throw.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
