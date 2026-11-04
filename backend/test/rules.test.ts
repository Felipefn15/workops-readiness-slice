import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { count, JO, passportOf, readyIds, setupCtx, submission, teardown, type Ctx } from './helpers.js';

let c: Ctx;
beforeEach(async () => { if (c) await teardown(c); c = await setupCtx(); });
afterAll(async () => { if (c) await teardown(c); });

describe('seed + readiness (R8)', () => {
  it('only w-1 and w-6 are ready; every other worker shows the specific failing gate', async () => {
    const { res, ready } = await readyIds(c);
    expect(res.status).toBe(200);
    expect(ready).toEqual(['w-1', 'w-6']);
    const by = Object.fromEntries(res.body.assignments.map((a: any) => [a.workerId, a.gates]));
    expect(by['w-2'].qc.pass).toBe(false);
    expect(by['w-2'].qc.reason).toMatch(/passport: pending QC review/);
    expect(by['w-3'].worker_acceptance.code).toBe('outdated_acceptance');
    expect(by['w-4'].employer_approval.code).toBe('no_employer_decision');
    expect(by['w-5'].qc.reason).toMatch(/passport: rejected by QC/);
    // exactly one failing gate each, the others still pass
    expect(Object.values(by['w-3']).filter((g: any) => !g.pass)).toHaveLength(1);
  });
});

describe('R5 idempotent offline replay', () => {
  it('same clientSubmissionId twice: one version, one task, one audit trail, identical result', async () => {
    const before = { dv: await count(c.db, 'document_versions'), audit: await count(c.db, 'audit_log'), tasks: await count(c.db, 'tasks') };
    const first = await c.call('w-5', 'POST', '/api/mobile/submissions', submission());
    expect(first.status).toBe(201);
    const afterFirst = { dv: await count(c.db, 'document_versions'), audit: await count(c.db, 'audit_log'), tasks: await count(c.db, 'tasks') };
    expect(afterFirst.dv).toBe(before.dv + 1);

    const replay = await c.call('w-5', 'POST', '/api/mobile/submissions', submission());
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect({ dv: await count(c.db, 'document_versions'), audit: await count(c.db, 'audit_log'), tasks: await count(c.db, 'tasks') }).toEqual(afterFirst);
    expect((await passportOf(c.db, 'ra-5')).map((v) => v.version_no)).toEqual([1, 2]);
  });

  it('two replays arriving at the same instant still create exactly one version', async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(() => c.call('w-5', 'POST', '/api/mobile/submissions', submission())));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.documentVersionId)).size).toBe(1);
    expect(await passportOf(c.db, 'ra-5')).toHaveLength(2);
  });

  it('reusing the id with a different payload is a 409, not a silent replay', async () => {
    await c.call('w-5', 'POST', '/api/mobile/submissions', submission());
    const r = await c.call('w-5', 'POST', '/api/mobile/submissions', submission({ fileRef: 'files/other.jpg' }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('idempotency_key_reuse');
  });
});

describe('R7 independent QC', () => {
  it('a reviewer cannot approve a version they captured; an independent one can', async () => {
    const [v] = await passportOf(c.db, 'ra-2'); // captured by Rosa
    const denied = await c.call('u-rosa', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'approve' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('reviewer_not_independent');
    expect((await passportOf(c.db, 'ra-2'))[0].status).toBe('pending_review');
    expect((await readyIds(c)).ready).not.toContain('w-2');

    const ok = await c.call('u-luis', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'approve' });
    expect(ok.status).toBe(201);
    expect((await readyIds(c)).ready).toContain('w-2');
  });

  it('the database itself refuses a non-independent review even if the app check is bypassed', async () => {
    const [v] = await passportOf(c.db, 'ra-2');
    await expect(c.db.query(`INSERT INTO qc_reviews(document_version_id, reviewer_id, decision) VALUES ($1,'u-rosa','approved')`, [v.id]))
      .rejects.toMatchObject({ code: 'WK007' });
  });

  it('rejection requires a reason, creates a correction task for the owning capturist, and a version is reviewed once', async () => {
    const [v] = await passportOf(c.db, 'ra-2');
    expect((await c.call('u-luis', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'reject' })).status).toBe(400);
    const rej = await c.call('u-luis', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'reject', reason: 'Glare' });
    expect(rej.status).toBe(201);
    const t = (await c.db.query('SELECT assigned_to, kind, status FROM tasks WHERE id=$1', [rej.body.correctionTaskId])).rows[0];
    expect(t).toEqual({ assigned_to: 'u-marta', kind: 'qc_rejection', status: 'open' });
    const again = await c.call('u-luis', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'approve' });
    expect(again.status).toBe(409);
  });

  it('a resubmission after rejection resets QC: not ready until a fresh independent approval', async () => {
    expect((await readyIds(c)).ready).not.toContain('w-5');
    const sub = await c.call('w-5', 'POST', '/api/mobile/submissions', submission());
    expect(sub.body.status).toBe('pending_review');
    const r1 = await c.call('u-pedro', 'GET', `/api/job-orders/${JO}/readiness`);
    const w5 = r1.body.assignments.find((a: any) => a.workerId === 'w-5');
    expect(w5.ready).toBe(false);
    expect(w5.gates.qc.reason).toMatch(/passport: pending QC review/); // new version is active, old rejection no longer counts
    // the open rejection task was answered by the resubmission
    expect((await c.db.query(`SELECT count(*)::int n FROM tasks WHERE roster_assignment_id='ra-5' AND status='open'`)).rows[0].n).toBe(0);

    expect((await c.call('u-luis', 'POST', `/api/document-versions/${sub.body.documentVersionId}/review`, { decision: 'approve' })).status).toBe(201);
    expect((await readyIds(c)).ready).toContain('w-5');
  });
});

describe('R6 conflicts never overwrite approved data', () => {
  it('different passport number: approved stays active, new is pending, correction task created, worker stays ready', async () => {
    const r = await c.call('w-1', 'POST', '/api/mobile/submissions', submission({ rosterAssignmentId: 'ra-1', clientSubmissionId: 'c-1' }));
    expect(r.status).toBe(201);
    const versions = await passportOf(c.db, 'ra-1');
    expect(versions.map((v) => v.status)).toEqual(['approved', 'pending_review']);
    expect(r.body.conflict).toBe(true);
    expect(r.body.activeVersionId).toBe(versions[0].id);
    const t = (await c.db.query('SELECT kind, assigned_to FROM tasks WHERE id=$1', [r.body.correctionTaskId])).rows[0];
    expect(t).toEqual({ kind: 'conflict', assigned_to: 'u-marta' });
    expect((await readyIds(c)).ready).toContain('w-1');
  });
});

describe('R8 gate 2 — terms versions', () => {
  it('accepting an outdated terms version is recorded but does not satisfy gate 2; the current one does', async () => {
    const old = await c.call('u-pedro', 'POST', '/api/roster-assignments/ra-3/acceptance', { termsVersionId: 'tv-0142-v1', method: 'verbal' });
    expect(old.status).toBe(200); // already on record from the seed => no-op
    expect(old.body.isCurrentTerms).toBe(false);
    expect((await readyIds(c)).ready).not.toContain('w-3');
    const cur = await c.call('w-3', 'POST', '/api/roster-assignments/ra-3/acceptance', { termsVersionId: 'tv-0142-v2', method: 'in_app' });
    expect(cur.status).toBe(201);
    expect((await readyIds(c)).ready).toContain('w-3');
    const a = (await c.db.query(`SELECT on_behalf_of FROM audit_log WHERE entity_id='ra-3' AND field='accepted_terms_version'`)).rows;
    expect(a).toHaveLength(1);
  });

  it('R11: a new terms version fails gate 2 but does not remove an existing booking', async () => {
    const s = await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] });
    expect(s.body.results[0].outcome).toBe('scheduled');
    await c.db.query(`UPDATE terms_versions SET status='superseded' WHERE id='tv-0142-v2'`);
    await c.db.query(`INSERT INTO terms_versions(id, job_order_id, label, status) VALUES ('tv-0142-v3','${JO}','v3','current')`);
    const r = await c.call('u-pedro', 'GET', `/api/job-orders/${JO}/readiness`);
    const w1 = r.body.assignments.find((a: any) => a.workerId === 'w-1');
    expect(w1.gates.worker_acceptance.pass).toBe(false);
    expect(w1.booking).toEqual({ appointmentId: 'APT-1' });
    const again = await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] });
    expect(again.body.results[0].outcome).toBe('already_scheduled');
  });
});

describe('R9 scheduling a mixed batch', () => {
  it('books eligible workers, refuses the rest with reasons, changes nobody else', async () => {
    const r = await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1', 'ra-3', 'ra-4', 'ra-6'] });
    expect(r.status).toBe(200);
    const o = Object.fromEntries(r.body.results.map((x: any) => [x.rosterAssignmentId, x]));
    expect(o['ra-1'].outcome).toBe('scheduled');
    expect(o['ra-6'].outcome).toBe('scheduled');
    expect(o['ra-3'].outcome).toBe('refused');
    expect(o['ra-3'].reasons[0].message).toMatch(/accepted v1 only/i);
    expect(o['ra-4'].outcome).toBe('refused');
    expect(o['ra-4'].reasons[0].code).toBe('employer_approval:no_employer_decision');
    expect(r.body).toMatchObject({ capacity: 2, booked: 2, remaining: 0 });
    expect((await c.db.query(`SELECT roster_assignment_id FROM appointment_memberships ORDER BY 1`)).rows.map((x) => x.roster_assignment_id)).toEqual(['ra-1', 'ra-6']);
  });

  it('re-checks gates on the server at booking time, ignoring what any UI showed', async () => {
    const [v] = await passportOf(c.db, 'ra-1');
    await c.call('w-1', 'POST', '/api/mobile/submissions', submission({ rosterAssignmentId: 'ra-1', clientSubmissionId: 'x', fields: { documentNumber: 'P-100001', expiresOn: '2031-05-20' } }));
    // ra-1 is ready now; make it not ready (employer rejects) and try to schedule
    await c.call('u-pedro', 'POST', '/api/roster-assignments/ra-1/employer-decision', { decision: 'rejected', evidence: 'verbal', decidedOn: '2026-11-01' });
    const r = await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] });
    expect(r.body.results[0].outcome).toBe('refused');
    expect(v).toBeTruthy();
  });

  it('is idempotent for already-booked workers and refuses unknown ids', async () => {
    await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] });
    const r = await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1', 'nope', 'ra-1'] });
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['already_scheduled', 'refused']);
    expect(await count(c.db, 'appointment_memberships')).toBe(1);
  });
});

describe('R10 concurrency', () => {
  it('two simultaneous calls for APT-2 (capacity 1): exactly one worker is booked', async () => {
    const [a, b] = await Promise.all([
      c.call('u-pedro', 'POST', '/api/appointments/APT-2/schedule', { rosterAssignmentIds: ['ra-1'] }),
      c.call('u-pedro', 'POST', '/api/appointments/APT-2/schedule', { rosterAssignmentIds: ['ra-6'] }),
    ]);
    const outcomes = [a, b].map((r) => r.body.results[0].outcome).sort();
    expect(outcomes).toEqual(['refused', 'scheduled']);
    const refused = [a, b].find((r) => r.body.results[0].outcome === 'refused')!;
    expect(refused.body.results[0].reasons[0].code).toBe('capacity_full');
    expect(await count(c.db, 'appointment_memberships')).toBe(1);
  });

  it('many concurrent callers never exceed capacity', async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      c.call('u-pedro', 'POST', `/api/appointments/${i % 2 ? 'APT-1' : 'APT-2'}/schedule`, { rosterAssignmentIds: ['ra-1', 'ra-6'] }));
    await Promise.all(calls);
    const rows = (await c.db.query(`SELECT appointment_id, count(*)::int n FROM appointment_memberships WHERE status='booked' GROUP BY 1`)).rows;
    for (const r of rows) expect(r.n).toBeLessThanOrEqual(r.appointment_id === 'APT-1' ? 2 : 1);
    const per = (await c.db.query(`SELECT roster_assignment_id, count(*)::int n FROM appointment_memberships WHERE status='booked' GROUP BY 1`)).rows;
    for (const r of per) expect(r.n).toBe(1);
  });

  it('the same worker requested for two appointments at once is booked only once', async () => {
    const [a, b] = await Promise.all([
      c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] }),
      c.call('u-pedro', 'POST', '/api/appointments/APT-2/schedule', { rosterAssignmentIds: ['ra-1'] }),
    ]);
    expect([a, b].map((r) => r.body.results[0].outcome).sort()).toEqual(['refused', 'scheduled']);
    expect(await count(c.db, 'appointment_memberships')).toBe(1);
  });

  it('database backstops hold without the app: no double booking, no overbooking', async () => {
    await c.db.query(`INSERT INTO appointment_memberships(appointment_id, roster_assignment_id, job_order_id, booked_by) VALUES ('APT-2','ra-1','${JO}','u-pedro')`);
    await expect(c.db.query(`INSERT INTO appointment_memberships(appointment_id, roster_assignment_id, job_order_id, booked_by) VALUES ('APT-1','ra-1','${JO}','u-pedro')`))
      .rejects.toMatchObject({ code: '23505' });
    await expect(c.db.query(`INSERT INTO appointment_memberships(appointment_id, roster_assignment_id, job_order_id, booked_by) VALUES ('APT-2','ra-6','${JO}','u-pedro')`))
      .rejects.toMatchObject({ code: 'WK010' });
  });
});

describe('R12 permissions fail closed', () => {
  it('a coordinator from another branch is denied (404, same as missing) on read and schedule', async () => {
    const v = await c.call('u-sofia', 'GET', `/api/job-orders/${JO}/readiness`);
    expect(v.status).toBe(404);
    const s = await c.call('u-sofia', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] });
    expect(s.status).toBe(404);
    expect(await count(c.db, 'appointment_memberships')).toBe(0);
    const a = await c.call('u-sofia', 'POST', '/api/roster-assignments/ra-1/employer-decision', { evidence: 'verbal', decidedOn: '2026-11-01' });
    expect(a.status).toBe(404);
  });

  it('a worker cannot submit for another worker\'s assignment', async () => {
    const before = await count(c.db, 'document_versions');
    const r = await c.call('w-2', 'POST', '/api/mobile/submissions', submission({ rosterAssignmentId: 'ra-3' }));
    expect(r.status).toBe(404);
    expect(await count(c.db, 'document_versions')).toBe(before);
    expect((await c.call('w-2', 'POST', '/api/roster-assignments/ra-3/acceptance', { termsVersionId: 'tv-0142-v2', method: 'in_app' })).status).toBe(404);
  });

  it('unknown user, missing header and wrong role are denied; roles are enforced per endpoint', async () => {
    expect((await c.call(null, 'GET', `/api/job-orders/${JO}/readiness`)).status).toBe(401);
    expect((await c.call('ghost', 'GET', `/api/job-orders/${JO}/readiness`)).status).toBe(401);
    expect((await c.call('u-luis', 'GET', `/api/job-orders/${JO}/readiness`)).status).toBe(403);
    expect((await c.call('w-1', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: ['ra-1'] })).status).toBe(403);
    expect((await c.call('u-marta', 'POST', '/api/mobile/submissions', submission())).status).toBe(403);
    const [v] = await passportOf(c.db, 'ra-2');
    expect((await c.call('u-marta', 'POST', `/api/document-versions/${v.id}/review`, { decision: 'approve' })).status).toBe(403);
  });

  it('a user with no roles is denied, and a route with no declared policy is denied', async () => {
    await c.db.query(`INSERT INTO users(id,name,branch_id) VALUES ('u-norole','Nobody','norte')`);
    expect((await c.call('u-norole', 'GET', '/api/me')).status).toBe(403);
    const app2 = buildApp(c.db);
    app2.get('/api/forgot-policy', async () => ({ leaked: true })); // developer forgot `config.roles`
    const res = await app2.inject({ method: 'GET', url: '/api/forgot-policy', headers: { 'x-user-id': 'u-pedro' } });
    expect(res.statusCode).toBe(403);
    await app2.close();
  });
});

describe('R2/R3 history', () => {
  it('versions, reviews and the audit log cannot be updated or deleted', async () => {
    await expect(c.db.query(`UPDATE document_versions SET fields='{}'`)).rejects.toMatchObject({ code: 'WK002' });
    await expect(c.db.query(`DELETE FROM audit_log`)).rejects.toMatchObject({ code: 'WK002' });
    await expect(c.db.query(`UPDATE qc_reviews SET decision='approved'`)).rejects.toMatchObject({ code: 'WK002' });
    await expect(c.db.query(`DELETE FROM roster_assignments`)).rejects.toMatchObject({ code: 'WK002' });
  });

  it('every state change writes an audit row with actor and on-behalf-of', async () => {
    const before = await count(c.db, 'audit_log');
    await c.call('u-pedro', 'POST', '/api/roster-assignments/ra-4/employer-decision', { evidence: 'document', decidedOn: '2026-11-02' });
    await c.call('u-pedro', 'POST', '/api/roster-assignments/ra-4/acceptance', { termsVersionId: 'tv-0142-v2', method: 'verbal' });
    const rows = (await c.db.query(`SELECT actor_id, on_behalf_of, field, old_value, new_value FROM audit_log WHERE id > (SELECT max(id) - 2 FROM audit_log)`)).rows;
    expect(await count(c.db, 'audit_log')).toBe(before + 1); // ra-4 already had v2 accepted: only the employer decision is new
    expect(rows.some((r) => r.actor_id === 'u-pedro' && r.field === 'employer_decision' && r.new_value === 'approved')).toBe(true);
    expect((await readyIds(c)).ready).toContain('w-4');
  });
});

describe('input validation', () => {
  it('rejects malformed bodies with 400 and a consistent error shape', async () => {
    const r = await c.call('w-5', 'POST', '/api/mobile/submissions', { clientSubmissionId: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_input');
    expect((await c.call('w-5', 'POST', '/api/mobile/submissions', submission({ documentType: 'selfie' }))).status).toBe(400);
    expect((await c.call('u-pedro', 'POST', '/api/appointments/APT-1/schedule', { rosterAssignmentIds: [] })).status).toBe(400);
    expect((await c.call('u-pedro', 'POST', '/api/roster-assignments/ra-1/acceptance', { termsVersionId: 'tv-bogus', method: 'verbal' })).status).toBe(400);
  });
});
