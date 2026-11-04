import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db, Tx } from './db.js';
import { forbidden, notFound, unauthenticated } from './errors.js';

export type Role = 'capturist' | 'qc_reviewer' | 'labor_coordinator' | 'worker';

export interface Actor {
  id: string;
  name: string;
  branchId: string | null;
  roles: ReadonlySet<Role>;
  workerId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null }
  interface FastifyContextConfig { roles?: Role[]; public?: boolean }
}

/** Resolves X-User-Id to an actor. Unknown / inactive / role-less users are rejected (R12: fail closed). */
export async function loadActor(db: Db, userId: string | undefined): Promise<Actor> {
  if (!userId || !userId.trim()) throw unauthenticated('Missing X-User-Id header');
  const u = await db.query(
    `SELECT u.id, u.name, u.branch_id, u.is_active,
            COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
            w.id AS worker_id
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
       LEFT JOIN workers w ON w.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, w.id`, [userId]);
  const row = u.rows[0];
  if (!row || !row.is_active) throw unauthenticated('Unknown user');
  if (row.roles.length === 0) throw forbidden('no_role', 'User has no roles');
  return { id: row.id, name: row.name, branchId: row.branch_id, roles: new Set(row.roles), workerId: row.worker_id };
}

/**
 * Global preHandler. Every route MUST declare `config: { roles: [...] }` (or `public: true`);
 * a route that declares nothing is denied. Adding an endpoint and forgetting auth therefore fails closed.
 */
export function authHook(db: Db) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const cfg = req.routeOptions.config;
    if (cfg.public) return;
    const allowed = cfg.roles;
    if (!allowed || allowed.length === 0) throw forbidden('route_not_authorized', 'Route has no access policy');
    const actor = await loadActor(db, req.headers['x-user-id'] as string | undefined);
    req.actor = actor;
    if (!allowed.some((r) => actor.roles.has(r))) {
      throw forbidden('insufficient_role', `Requires one of: ${allowed.join(', ')}`);
    }
  };
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthenticated('No actor'); // unreachable if authHook ran; still fail closed
  return req.actor;
}

type Q = Db | Tx;

/** Staff may only touch records of their own branch. Returns the job order or 404 (missing and out-of-scope look identical). */
export async function requireJobOrderInBranch(q: Q, actor: Actor, jobOrderId: string, lock = false) {
  const r = await q.query(`SELECT id, branch_id FROM job_orders WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [jobOrderId]);
  const jo = r.rows[0];
  if (!jo || !actor.branchId || jo.branch_id !== actor.branchId) throw notFound('Job order');
  return jo as { id: string; branch_id: string };
}

export interface ScopedAssignment {
  id: string; worker_id: string; job_order_id: string; owner_capturist_id: string; status: string; branch_id: string; worker_user_id: string;
}

/**
 * Loads an assignment the actor is allowed to see, or throws 404.
 * Workers: only their own. Staff: only assignments whose job order is in their branch.
 */
export async function requireAssignmentAccess(q: Q, actor: Actor, assignmentId: string, opts: { lock?: boolean } = {}): Promise<ScopedAssignment> {
  const r = await q.query(
    `SELECT ra.id, ra.worker_id, ra.job_order_id, ra.owner_capturist_id, ra.status, jo.branch_id, w.user_id AS worker_user_id
       FROM roster_assignments ra
       JOIN job_orders jo ON jo.id = ra.job_order_id
       JOIN workers w ON w.id = ra.worker_id
      WHERE ra.id = $1${opts.lock ? ' FOR UPDATE OF ra' : ''}`, [assignmentId]);
  const a = r.rows[0] as ScopedAssignment | undefined;
  if (!a) throw notFound('Roster assignment');
  const isOwnWorker = actor.roles.has('worker') && actor.workerId === a.worker_id;
  const isBranchStaff = !!actor.branchId && actor.branchId === a.branch_id &&
    (actor.roles.has('labor_coordinator') || actor.roles.has('qc_reviewer') || actor.roles.has('capturist'));
  if (!isOwnWorker && !isBranchStaff) throw notFound('Roster assignment');
  return a;
}
