import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireAssignmentAccess } from '../auth.js';
import { audit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

const Body = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(1000).optional() });

export async function reviewRoutes(app: FastifyInstance, db: Db) {
  /** POST /api/document-versions/:id/review — independent QC (R7). Only an approval makes a document count (R4). */
  app.post<{ Params: { id: string } }>('/api/document-versions/:id/review', { config: { roles: ['qc_reviewer'] } }, async (req, reply) => {
    const actor = actorOf(req);
    const body = Body.parse(req.body);
    if (body.decision === 'reject' && !body.reason?.trim()) throw badRequest('A rejection requires a reason');

    const out = await withTx(db, async (tx) => {
      const dv = (await tx.query(
        'SELECT id, roster_assignment_id, document_type, submitted_by, captured_by FROM document_versions WHERE id=$1', [req.params.id])).rows[0];
      if (!dv) throw notFound('Document version');
      // Branch scope + lock the assignment (serialises with submissions and scheduling for this worker).
      const a = await requireAssignmentAccess(tx, actor, dv.roster_assignment_id, { lock: true });
      if (a.worker_user_id === actor.id) throw notFound('Document version');

      // R7 (also enforced by trigger qc_reviews_independence)
      if (dv.submitted_by === actor.id || dv.captured_by === actor.id) {
        throw forbidden('reviewer_not_independent', 'You submitted or captured this version; a different reviewer must decide (R7)');
      }
      const decision = body.decision === 'approve' ? 'approved' : 'rejected';
      const ins = await tx.query(
        `INSERT INTO qc_reviews (document_version_id, reviewer_id, decision, reason) VALUES ($1,$2,$3,$4)
         ON CONFLICT (document_version_id) DO NOTHING RETURNING id`, [dv.id, actor.id, decision, body.reason ?? null]);
      if (ins.rowCount === 0) throw conflict('already_reviewed', 'This version already has a QC decision; submit a new version instead (R2)');
      await audit(tx, { actorId: actor.id, entityType: 'document_version', entityId: dv.id, field: 'status', oldValue: 'pending_review', newValue: decision });

      // Any open conflict task about this exact version is answered by the verdict.
      const closed = await tx.query(
        `UPDATE tasks SET status='resolved', resolved_at=now() WHERE document_version_id=$1 AND status='open' RETURNING id`, [dv.id]);
      for (const t of closed.rows)
        await audit(tx, { actorId: actor.id, entityType: 'task', entityId: t.id, field: 'status', oldValue: 'open', newValue: 'resolved' });

      let taskId: string | null = null;
      if (decision === 'rejected') {
        taskId = (await tx.query(
          `INSERT INTO tasks (roster_assignment_id, kind, document_type, document_version_id, assigned_to, reason)
           VALUES ($1,'qc_rejection',$2,$3,$4,$5) RETURNING id`,
          [a.id, dv.document_type, dv.id, a.owner_capturist_id, body.reason])).rows[0].id;
        await audit(tx, { actorId: actor.id, entityType: 'task', entityId: taskId!, field: 'status', newValue: 'open' });
      }
      return { documentVersionId: dv.id, status: decision, reviewId: ins.rows[0].id as string, correctionTaskId: taskId };
    });
    return reply.status(201).send(out);
  });
}
