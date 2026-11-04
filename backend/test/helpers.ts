import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TEST_DATABASE_URL } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { seed } from '../src/seed.js';

export interface Ctx { db: Db; app: FastifyInstance; call: Call }
export type Call = (user: string | null, method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: any; headers: Record<string, any> }>;

export const JO = 'JO-2026-0142';

/** Fresh real database in the exact seeded state, before every test. */
export async function setupCtx(): Promise<Ctx> {
  const db = createPool(TEST_DATABASE_URL, 10);
  await seed(db);
  const app = buildApp(db);
  await app.ready();
  const call: Call = async (user, method, url, body) => {
    const res = await app.inject({ method, url, headers: user ? { 'x-user-id': user } : {}, payload: body as any });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  return { db, app, call };
}
export async function teardown(c: Ctx) { await c.app.close(); await c.db.end(); }

export const passportOf = async (db: Db, assignment: string) =>
  (await db.query(
    `SELECT dv.id, dv.version_no, COALESCE(qr.decision,'pending_review') AS status FROM document_versions dv
       LEFT JOIN qc_reviews qr ON qr.document_version_id = dv.id
      WHERE dv.roster_assignment_id=$1 AND dv.document_type='passport' ORDER BY dv.version_no`, [assignment])).rows;

export const count = async (db: Db, table: string) => (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

export const submission = (over: Record<string, unknown> = {}) => ({
  clientSubmissionId: 'sub-0001', rosterAssignmentId: 'ra-5', documentType: 'passport',
  fields: { documentNumber: 'P-NEW-555', expiresOn: '2032-01-01' }, fileRef: 'files/new.jpg', ...over,
});

export async function readyIds(c: Ctx, user = 'u-pedro') {
  const r = await c.call(user, 'GET', `/api/job-orders/${JO}/readiness`);
  return { res: r, ready: r.body.assignments?.filter((a: any) => a.ready).map((a: any) => a.workerId) as string[] };
}
