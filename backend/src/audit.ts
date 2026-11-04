import type { Tx } from './db.js';

export interface AuditEntry {
  actorId: string;
  onBehalfOf?: string | null;
  entityType: string;
  entityId: string;
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * R3: every state change writes an audit row, in the SAME transaction as the change, so the two commit or
 * roll back together. The table itself is append-only (trigger in 002_integrity_triggers.sql).
 */
export async function audit(tx: Tx, e: AuditEntry | AuditEntry[]): Promise<void> {
  for (const x of Array.isArray(e) ? e : [e]) {
    await tx.query(
      `INSERT INTO audit_log (actor_id, on_behalf_of, entity_type, entity_id, field, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [x.actorId, x.onBehalfOf ?? null, x.entityType, x.entityId, x.field,
       x.oldValue === undefined ? null : JSON.stringify(x.oldValue),
       x.newValue === undefined ? null : JSON.stringify(x.newValue)],
    );
  }
}
