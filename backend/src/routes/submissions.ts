import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireAssignmentAccess } from '../auth.js';
import { audit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

const Body = z.object({
  clientSubmissionId: z.string().min(1).max(128),
  rosterAssignmentId: z.string().min(1),
  documentType: z.string().min(1),
  fields: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  fileRef: z.string().min(1).max(500),
});

export async function submissionRoutes(app: FastifyInstance, db: Db) {
  /**
   * POST /api/mobile/submissions — worker uploads a document version.
   * R4: lands as pending_review. R5: idempotent per (caller, clientSubmissionId). R6: never overwrites approved data.
   */
  app.post('/api/mobile/submissions', { config: { roles: ['worker'] } }, async (req, reply) => {
    const actor = actorOf(req);
    const body = Body.parse(req.body);
    const hash = createHash('sha256')
      .update(JSON.stringify([body.rosterAssignmentId, body.documentType, body.fileRef, Object.entries(body.fields).sort()]))
      .digest('hex');

    const { response, replayed } = await withTx(db, async (tx) => {
      // Lock the assignment first: serialises every write for this worker/order (version numbering, replays, QC).
      const a = await requireAssignmentAccess(tx, actor, body.rosterAssignmentId, { lock: true });
      if (a.worker_id !== actor.workerId) throw notFound('Roster assignment'); // R12: workers act on their own assignments only
      if (a.status !== 'active') throw conflict('assignment_not_active', 'Roster assignment is cancelled');

      // R5: claim the idempotency key. A concurrent twin blocks on the unique index until we commit.
      const claim = await tx.query(
        `INSERT INTO client_submissions (submitted_by, client_submission_id, request_hash)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [actor.id, body.clientSubmissionId, hash]);
      if (claim.rowCount === 0) {
        const prev = (await tx.query(
          `SELECT request_hash, response FROM client_submissions WHERE submitted_by=$1 AND client_submission_id=$2`,
          [actor.id, body.clientSubmissionId])).rows[0];
        if (prev.request_hash !== hash) {
          throw conflict('idempotency_key_reuse', 'clientSubmissionId was already used with a different payload');
        }
        return { response: prev.response, replayed: true };
      }

      const req_ = await tx.query(
        'SELECT 1 FROM required_document_types WHERE job_order_id=$1 AND document_type=$2', [a.job_order_id, body.documentType]);
      if (req_.rowCount === 0) throw badRequest(`'${body.documentType}' is not a required document type for ${a.job_order_id}`);

      // R6: compare against the most recent APPROVED version of this type.
      const approved = (await tx.query(
        `SELECT dv.id, dv.fields FROM document_versions dv JOIN qc_reviews qr ON qr.document_version_id = dv.id AND qr.decision='approved'
          WHERE dv.roster_assignment_id=$1 AND dv.document_type=$2 ORDER BY dv.version_no DESC LIMIT 1`,
        [a.id, body.documentType])).rows[0] as { id: string; fields: Record<string, unknown> } | undefined;
      const diffs = approved
        ? Object.entries(body.fields).filter(([k, v]) => k in approved.fields && String(approved.fields[k]) !== String(v))
        : [];
      const isConflict = diffs.length > 0;

      const versionNo = (await tx.query(
        'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM document_versions WHERE roster_assignment_id=$1 AND document_type=$2',
        [a.id, body.documentType])).rows[0].n as number;
      const dv = (await tx.query(
        `INSERT INTO document_versions (roster_assignment_id, job_order_id, document_type, version_no, fields, file_ref, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.id, a.job_order_id, body.documentType, versionNo, JSON.stringify(body.fields), body.fileRef, actor.id])).rows[0].id as string;
      await audit(tx, { actorId: actor.id, entityType: 'document_version', entityId: dv, field: 'status', newValue: 'pending_review' });

      // A resubmission answers any open QC-rejection correction task for this document type.
      const closed = await tx.query(
        `UPDATE tasks SET status='resolved', resolved_at=now()
          WHERE roster_assignment_id=$1 AND document_type=$2 AND kind='qc_rejection' AND status='open' RETURNING id`,
        [a.id, body.documentType]);
      for (const t of closed.rows)
        await audit(tx, { actorId: actor.id, entityType: 'task', entityId: t.id, field: 'status', oldValue: 'open', newValue: 'resolved' });

      let taskId: string | null = null;
      if (isConflict) {
        const reason = `New ${body.documentType} conflicts with approved data: ` +
          diffs.map(([k, v]) => `${k} ${approved!.fields[k]} -> ${v}`).join(', ');
        taskId = (await tx.query(
          `INSERT INTO tasks (roster_assignment_id, kind, document_type, document_version_id, assigned_to, reason)
           VALUES ($1,'conflict',$2,$3,$4,$5) RETURNING id`, [a.id, body.documentType, dv, a.owner_capturist_id, reason])).rows[0].id;
        await audit(tx, { actorId: actor.id, entityType: 'task', entityId: taskId!, field: 'status', newValue: 'open' });
      }

      const response = {
        documentVersionId: dv,
        documentType: body.documentType,
        versionNo,
        status: 'pending_review',
        // R6: approved stays active on conflict; otherwise the new submission is the latest submitted => active.
        activeVersionId: approved ? approved.id : dv,
        conflict: isConflict,
        correctionTaskId: taskId,
      };
      await tx.query(
        `UPDATE client_submissions SET document_version_id=$3, response=$4
          WHERE submitted_by=$1 AND client_submission_id=$2`,
        [actor.id, body.clientSubmissionId, dv, JSON.stringify(response)]);
      return { response, replayed: false };
    });

    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(replayed ? 200 : 201).send(response);
  });
}
