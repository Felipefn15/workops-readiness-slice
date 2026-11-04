import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireJobOrderInBranch } from '../auth.js';
import { audit } from '../audit.js';
import { withTx, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { evaluateAssignments, GATE_KEYS } from '../domain/gates.js';

const Body = z.object({ rosterAssignmentIds: z.array(z.string().min(1)).min(1).max(500) });

type Reason = { code: string; message: string };
type Outcome = 'scheduled' | 'already_scheduled' | 'refused';

export async function scheduleRoutes(app: FastifyInstance, db: Db) {
  /**
   * POST /api/appointments/:id/schedule
   *  R9  gates are re-evaluated HERE, inside the booking transaction, after locks are taken — never from the UI.
   *      A batch is partial: eligible workers are booked, the rest get reasons, nobody else's history changes.
   *  R10 lock order is always: appointment row -> assignment rows (sorted). The appointment lock serialises
   *      capacity; assignment locks serialise a worker across appointments and against QC/acceptance writes.
   *      Unique partial index + capacity trigger are the backstop if any writer ever skips the locks.
   *  R11 an assignment already booked in THIS appointment reports already_scheduled even if its gates have
   *      since failed; bookings are never removed here.
   */
  app.post<{ Params: { id: string } }>('/api/appointments/:id/schedule', { config: { roles: ['labor_coordinator'] } }, async (req) => {
    const actor = actorOf(req);
    const body = Body.parse(req.body);
    const requested = [...new Set(body.rosterAssignmentIds)]; // duplicates in one request cannot double-book

    return withTx(db, async (tx) => {
      const probe = (await tx.query('SELECT job_order_id FROM appointments WHERE id=$1', [req.params.id])).rows[0];
      if (!probe) throw notFound('Appointment');
      await requireJobOrderInBranch(tx, actor, probe.job_order_id); // out-of-branch => 404 before any lock is taken

      const appt = (await tx.query('SELECT id, job_order_id, capacity FROM appointments WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      const locked = await tx.query(
        'SELECT id FROM roster_assignments WHERE id = ANY($1::text[]) AND job_order_id=$2 ORDER BY id FOR UPDATE',
        [requested, appt.job_order_id]);
      const found = new Set<string>(locked.rows.map((r) => r.id));

      const evals = new Map((await evaluateAssignments(tx, appt.job_order_id, [...found])).map((e) => [e.assignmentId, e]));
      let booked: number = (await tx.query(
        `SELECT COUNT(*)::int AS n FROM appointment_memberships WHERE appointment_id=$1 AND status='booked'`, [appt.id])).rows[0].n;

      const results: { rosterAssignmentId: string; workerName: string | null; outcome: Outcome; reasons: Reason[] }[] = [];
      const push = (id: string, name: string | null, outcome: Outcome, reasons: Reason[] = []) =>
        results.push({ rosterAssignmentId: id, workerName: name, outcome, reasons });

      for (const id of requested) {
        const e = evals.get(id);
        if (!e) { push(id, null, 'refused', [{ code: 'not_found', message: 'Roster assignment not found on this job order' }]); continue; }
        if (e.booking?.appointmentId === appt.id) { push(id, e.workerName, 'already_scheduled'); continue; }
        if (e.booking) {
          push(id, e.workerName, 'refused', [{ code: 'already_booked_elsewhere', message: `Already booked in ${e.booking.appointmentId}` }]);
          continue;
        }
        const reasons: Reason[] = [];
        if (e.assignmentStatus !== 'active') reasons.push({ code: 'assignment_cancelled', message: 'Roster assignment is cancelled' });
        for (const k of GATE_KEYS) if (!e.gates[k].pass) reasons.push({ code: `${k}:${e.gates[k].code}`, message: e.gates[k].reason });
        if (reasons.length) { push(id, e.workerName, 'refused', reasons); continue; }
        if (booked >= appt.capacity) {
          push(id, e.workerName, 'refused', [{ code: 'capacity_full', message: `${appt.id} is full (${appt.capacity}/${appt.capacity})` }]);
          continue;
        }
        const m = await tx.query(
          `INSERT INTO appointment_memberships (appointment_id, roster_assignment_id, job_order_id, booked_by)
           VALUES ($1,$2,$3,$4) RETURNING id`, [appt.id, id, appt.job_order_id, actor.id]);
        await audit(tx, { actorId: actor.id, entityType: 'appointment_membership', entityId: m.rows[0].id, field: 'status',
          oldValue: null, newValue: `booked:${appt.id}:${id}` });
        booked++;
        push(id, e.workerName, 'scheduled');
      }
      return { appointmentId: appt.id, capacity: appt.capacity, booked, remaining: appt.capacity - booked, results };
    });
  });
}
