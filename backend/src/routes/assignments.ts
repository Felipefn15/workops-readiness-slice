import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireAssignmentAccess } from '../auth.js';
import { audit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

const Employer = z.object({
  decision: z.enum(['approved', 'rejected']).default('approved'),
  evidence: z.enum(['document', 'verbal']),
  decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
});
const Acceptance = z.object({ termsVersionId: z.string().min(1), method: z.enum(['verbal', 'in_app']) });

export async function assignmentRoutes(app: FastifyInstance, db: Db) {
  /** Gate 1 evidence. Append-only: a new decision supersedes the previous one, history stays (R2). */
  app.post<{ Params: { id: string } }>('/api/roster-assignments/:id/employer-decision',
    { config: { roles: ['labor_coordinator'] } }, async (req, reply) => {
      const actor = actorOf(req);
      const body = Employer.parse(req.body);
      const out = await withTx(db, async (tx) => {
        const a = await requireAssignmentAccess(tx, actor, req.params.id, { lock: true });
        if (a.status !== 'active') throw conflict('assignment_not_active', 'Roster assignment is cancelled');
        const prev = (await tx.query(
          'SELECT decision FROM employer_decisions WHERE roster_assignment_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [a.id])).rows[0];
        const r = (await tx.query(
          `INSERT INTO employer_decisions (roster_assignment_id, decision, evidence, decided_on, decided_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`, [a.id, body.decision, body.evidence, body.decidedOn, actor.id])).rows[0];
        await audit(tx, { actorId: actor.id, entityType: 'roster_assignment', entityId: a.id, field: 'employer_decision',
          oldValue: prev?.decision ?? null, newValue: body.decision });
        return { id: r.id as string, rosterAssignmentId: a.id, ...body };
      });
      return reply.status(201).send(out);
    });

  /**
   * Gate 2 evidence. Accepting an OLD terms version is recorded truthfully but does not satisfy gate 2 (R8) —
   * readiness compares against the current version. Recording the same acceptance twice is a no-op.
   */
  app.post<{ Params: { id: string } }>('/api/roster-assignments/:id/acceptance',
    { config: { roles: ['labor_coordinator', 'worker'] } }, async (req, reply) => {
      const actor = actorOf(req);
      const body = Acceptance.parse(req.body);
      const { out, created } = await withTx(db, async (tx) => {
        const a = await requireAssignmentAccess(tx, actor, req.params.id, { lock: true });
        if (a.status !== 'active') throw conflict('assignment_not_active', 'Roster assignment is cancelled');
        const tv = (await tx.query('SELECT id, label, status FROM terms_versions WHERE id=$1 AND job_order_id=$2',
          [body.termsVersionId, a.job_order_id])).rows[0];
        if (!tv) throw badRequest(`Terms version '${body.termsVersionId}' does not belong to job order ${a.job_order_id}`);
        const onBehalf = a.worker_user_id === actor.id ? null : a.worker_user_id; // R3: coordinator acts on behalf of the worker
        const ins = await tx.query(
          `INSERT INTO acceptances (roster_assignment_id, job_order_id, terms_version_id, method, accepted_by, on_behalf_of)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (roster_assignment_id, terms_version_id) DO NOTHING RETURNING id`,
          [a.id, a.job_order_id, tv.id, body.method, actor.id, onBehalf]);
        const row = ins.rowCount
          ? ins.rows[0]
          : (await tx.query('SELECT id FROM acceptances WHERE roster_assignment_id=$1 AND terms_version_id=$2', [a.id, tv.id])).rows[0];
        if (ins.rowCount) {
          await audit(tx, { actorId: actor.id, onBehalfOf: onBehalf, entityType: 'roster_assignment', entityId: a.id,
            field: 'accepted_terms_version', newValue: tv.label });
        }
        return {
          created: !!ins.rowCount,
          out: { id: row.id as string, rosterAssignmentId: a.id, termsVersionId: tv.id, termsLabel: tv.label,
                 isCurrentTerms: tv.status === 'current', method: body.method },
        };
      });
      return reply.status(created ? 201 : 200).send(out);
    });
}
