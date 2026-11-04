import type { FastifyInstance } from 'fastify';
import { actorOf, requireJobOrderInBranch } from '../auth.js';
import type { Db } from '../db.js';
import { evaluateAssignments } from '../domain/gates.js';

export async function readinessRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/me', { config: { roles: ['capturist', 'qc_reviewer', 'labor_coordinator', 'worker'] } }, async (req) => {
    const a = actorOf(req);
    return { id: a.id, name: a.name, branchId: a.branchId, roles: [...a.roles] };
  });

  /** Per assignment: the four gates, pass/fail, with a human-readable reason (R8). */
  app.get<{ Params: { id: string } }>('/api/job-orders/:id/readiness', { config: { roles: ['labor_coordinator'] } }, async (req) => {
    const actor = actorOf(req);
    const jo = await requireJobOrderInBranch(db, actor, req.params.id);
    const [evals, terms, docs] = await Promise.all([
      evaluateAssignments(db, jo.id),
      db.query(`SELECT id, label FROM terms_versions WHERE job_order_id=$1 AND status='current'`, [jo.id]),
      db.query('SELECT document_type FROM required_document_types WHERE job_order_id=$1 ORDER BY document_type', [jo.id]),
    ]);
    return {
      jobOrderId: jo.id,
      branchId: jo.branch_id,
      currentTermsVersion: terms.rows[0] ?? null,
      requiredDocumentTypes: docs.rows.map((r) => r.document_type),
      summary: { total: evals.length, ready: evals.filter((e) => e.ready).length },
      assignments: evals,
    };
  });

  /** Appointments of a job order with live remaining capacity, for the scheduling panel. */
  app.get<{ Params: { id: string } }>('/api/job-orders/:id/appointments', { config: { roles: ['labor_coordinator'] } }, async (req) => {
    const actor = actorOf(req);
    const jo = await requireJobOrderInBranch(db, actor, req.params.id);
    const r = await db.query(
      `SELECT a.id, a.capacity, a.starts_at,
              COUNT(m.id) FILTER (WHERE m.status='booked')::int AS booked,
              COALESCE(array_agg(m.roster_assignment_id ORDER BY m.created_at) FILTER (WHERE m.status='booked'), '{}') AS booked_assignments
         FROM appointments a LEFT JOIN appointment_memberships m ON m.appointment_id = a.id
        WHERE a.job_order_id=$1 GROUP BY a.id ORDER BY a.id`, [jo.id]);
    return {
      appointments: r.rows.map((a) => ({
        id: a.id, startsAt: a.starts_at, capacity: a.capacity, booked: a.booked, remaining: a.capacity - a.booked,
        bookedAssignmentIds: a.booked_assignments,
      })),
    };
  });
}
