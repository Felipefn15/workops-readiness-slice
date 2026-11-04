import { DATABASE_URL } from './config.js';
import { createPool, withTx, type Db, type Tx } from './db.js';
import { migrate } from './migrate.js';
import { audit } from './audit.js';

const SEED = 'system:seed';
const JO = 'JO-2026-0142';
const TERMS_V1 = 'tv-0142-v1';
const TERMS_V2 = 'tv-0142-v2';
export const SEED_IDS = { jobOrder: JO, termsV1: TERMS_V1, termsV2: TERMS_V2 };

type DocState = 'approved' | 'pending' | 'rejected';
interface W {
  n: number; name: string;
  employer: boolean; terms: string;
  docs: Record<'passport' | 'ds160_confirmation' | 'signed_contract', DocState>;
  passportCapturedBy?: string;
}
const A: W['docs'] = { passport: 'approved', ds160_confirmation: 'approved', signed_contract: 'approved' };
const WORKERS: W[] = [
  { n: 1, name: 'Ana López',    employer: true,  terms: TERMS_V2, docs: A },
  // Bruno: passport captured by Rosa and still pending. Other two approved (so approving the passport => ready).
  { n: 2, name: 'Bruno Díaz',   employer: true,  terms: TERMS_V2, docs: { ...A, passport: 'pending' }, passportCapturedBy: 'u-rosa' },
  { n: 3, name: 'Carla Ruiz',   employer: true,  terms: TERMS_V1, docs: A },
  { n: 4, name: 'Diego Mora',   employer: false, terms: TERMS_V2, docs: A },
  { n: 5, name: 'Elena Soto',   employer: true,  terms: TERMS_V2, docs: { ...A, passport: 'rejected' } },
  { n: 6, name: 'Fausto Vega',  employer: true,  terms: TERMS_V2, docs: A },
];

const ALL_TABLES = [
  'audit_log', 'client_submissions', 'tasks', 'qc_reviews', 'document_versions', 'appointment_memberships',
  'appointments', 'acceptances', 'employer_decisions', 'roster_assignments', 'workers', 'required_document_types',
  'terms_versions', 'job_orders', 'user_roles', 'users', 'branches',
];

/** Wipes everything and recreates exactly the starting state described in the brief. Idempotent. */
export async function seed(db: Db): Promise<void> {
  await withTx(db, async (tx) => {
    // The append-only/no-delete triggers must not block a full reset; replica role skips ordinary triggers.
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(`TRUNCATE ${ALL_TABLES.join(', ')}`);
    await tx.query('SET LOCAL session_replication_role = DEFAULT');

    await tx.query(`INSERT INTO branches VALUES ('norte','Norte'),('sur','Sur')`);
    const staff: [string, string, string, string[]][] = [
      ['u-pedro', 'Pedro', 'norte', ['labor_coordinator']],
      ['u-sofia', 'Sofía', 'sur', ['labor_coordinator']],
      ['u-marta', 'Marta', 'norte', ['capturist']],
      ['u-luis', 'Luis', 'norte', ['qc_reviewer']],
      ['u-rosa', 'Rosa', 'norte', ['capturist', 'qc_reviewer']],
    ];
    for (const [id, name, branch, roles] of staff) {
      await tx.query('INSERT INTO users(id,name,branch_id) VALUES ($1,$2,$3)', [id, name, branch]);
      for (const r of roles) await tx.query('INSERT INTO user_roles VALUES ($1,$2)', [id, r]);
    }

    await tx.query(`INSERT INTO job_orders(id, branch_id) VALUES ($1,'norte')`, [JO]);
    await tx.query(`INSERT INTO terms_versions(id, job_order_id, label, status) VALUES
      ($1,$3,'v1','superseded'), ($2,$3,'v2','current')`, [TERMS_V1, TERMS_V2, JO]);
    for (const t of ['passport', 'ds160_confirmation', 'signed_contract'])
      await tx.query('INSERT INTO required_document_types VALUES ($1,$2)', [JO, t]);
    await tx.query(`INSERT INTO appointments(id, job_order_id, capacity, starts_at) VALUES
      ('APT-1',$1,2,'2026-12-01T15:00:00Z'), ('APT-2',$1,1,'2026-12-02T15:00:00Z')`, [JO]);

    for (const w of WORKERS) await seedWorker(tx, w);
  });
}

async function seedWorker(tx: Tx, w: W): Promise<void> {
  const uid = `w-${w.n}`, aid = `ra-${w.n}`;
  await tx.query('INSERT INTO users(id,name,branch_id) VALUES ($1,$2,$3)', [uid, w.name, 'norte']);
  await tx.query(`INSERT INTO user_roles VALUES ($1,'worker')`, [uid]);
  await tx.query('INSERT INTO workers(id,user_id,full_name) VALUES ($1,$2,$3)', [uid, uid, w.name]);
  await tx.query('INSERT INTO roster_assignments(id,worker_id,job_order_id,owner_capturist_id) VALUES ($1,$2,$3,$4)', [aid, uid, JO, 'u-marta']);
  await audit(tx, { actorId: SEED, entityType: 'roster_assignment', entityId: aid, field: 'status', newValue: 'active' });

  if (w.employer) {
    const r = await tx.query(
      `INSERT INTO employer_decisions(roster_assignment_id, decision, evidence, decided_on, decided_by)
       VALUES ($1,'approved','document','2026-10-01','u-pedro') RETURNING id`, [aid]);
    await audit(tx, { actorId: SEED, entityType: 'employer_decision', entityId: r.rows[0].id, field: 'decision', newValue: 'approved' });
  }
  const acc = await tx.query(
    `INSERT INTO acceptances(roster_assignment_id, job_order_id, terms_version_id, method, accepted_by, on_behalf_of)
     VALUES ($1,$2,$3,'verbal','u-pedro',$4) RETURNING id`, [aid, JO, w.terms, uid]);
  await audit(tx, { actorId: SEED, onBehalfOf: uid, entityType: 'acceptance', entityId: acc.rows[0].id, field: 'terms_version_id', newValue: w.terms });

  const fields: Record<string, object> = {
    passport: { documentNumber: `P-${100000 + w.n}`, expiresOn: '2031-05-20' },
    ds160_confirmation: { confirmationNumber: `AA00${w.n}XYZ` },
    signed_contract: { signedOn: '2026-09-15' },
  };
  for (const [type, state] of Object.entries(w.docs)) {
    const captured = type === 'passport' && w.passportCapturedBy ? w.passportCapturedBy : 'u-marta';
    const dv = await tx.query(
      `INSERT INTO document_versions(roster_assignment_id, job_order_id, document_type, version_no, fields, file_ref, submitted_by, captured_by)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7) RETURNING id`,
      [aid, JO, type, JSON.stringify(fields[type]), `files/${uid}/${type}-1.pdf`, uid, captured]);
    const dvId = dv.rows[0].id;
    await audit(tx, { actorId: SEED, entityType: 'document_version', entityId: dvId, field: 'status', newValue: 'pending_review' });
    if (state === 'pending') continue;
    const decision = state === 'approved' ? 'approved' : 'rejected';
    await tx.query(
      `INSERT INTO qc_reviews(document_version_id, reviewer_id, decision, reason) VALUES ($1,'u-luis',$2,$3)`,
      [dvId, decision, decision === 'rejected' ? 'Photo is blurry, number not legible' : null]);
    await audit(tx, { actorId: 'u-luis', entityType: 'document_version', entityId: dvId, field: 'status', oldValue: 'pending_review', newValue: decision });
    if (decision === 'rejected') {
      const t = await tx.query(
        `INSERT INTO tasks(roster_assignment_id, kind, document_type, document_version_id, assigned_to, reason)
         VALUES ($1,'qc_rejection',$2,$3,'u-marta','Photo is blurry, number not legible') RETURNING id`, [aid, type, dvId]);
      await audit(tx, { actorId: 'u-luis', entityType: 'task', entityId: t.rows[0].id, field: 'status', newValue: 'open' });
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const db = createPool(DATABASE_URL);
  migrate(db).then(() => seed(db))
    .then(() => console.log('seeded: 2 branches, JO-2026-0142, APT-1 (cap 2), APT-2 (cap 1), workers w-1..w-6 (assignments ra-1..ra-6)'))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.end());
}
