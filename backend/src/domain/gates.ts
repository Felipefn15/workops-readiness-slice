import type { Db, Tx } from '../db.js';

/**
 * R8 — the four hard gates. This is the ONLY place readiness is computed: the readiness board and the
 * scheduler (R9, which re-evaluates inside its transaction) both call evaluateAssignments, so the UI can
 * never show something the server would not enforce.
 */
export const GATE_KEYS = ['employer_approval', 'worker_acceptance', 'documents', 'qc'] as const;
export type GateKey = (typeof GATE_KEYS)[number];

export interface Gate { pass: boolean; code: string; reason: string }
export interface ActiveDoc {
  documentType: string;
  versionId: string | null;
  versionNo: number | null;
  status: 'pending_review' | 'approved' | 'rejected' | 'missing';
  reviewReason: string | null;
}
export interface Evaluation {
  assignmentId: string;
  workerId: string;
  workerName: string;
  assignmentStatus: string;
  ready: boolean;
  gates: Record<GateKey, Gate>;
  documents: ActiveDoc[];
  booking: { appointmentId: string } | null;
}

type Q = Db | Tx;

export async function evaluateAssignments(q: Q, jobOrderId: string, assignmentIds?: string[]): Promise<Evaluation[]> {
  const [terms, req, asg] = await Promise.all([
    q.query(`SELECT id, label FROM terms_versions WHERE job_order_id = $1 AND status = 'current'`, [jobOrderId]),
    q.query(`SELECT document_type FROM required_document_types WHERE job_order_id = $1 ORDER BY document_type`, [jobOrderId]),
    q.query(
      `SELECT ra.id, ra.status, ra.worker_id, w.full_name FROM roster_assignments ra
         JOIN workers w ON w.id = ra.worker_id
        WHERE ra.job_order_id = $1 AND ($2::text[] IS NULL OR ra.id = ANY($2::text[])) ORDER BY ra.id`,
      [jobOrderId, assignmentIds ?? null]),
  ]);
  const ids: string[] = asg.rows.map((r) => r.id);

  const [emp, acc, docs, book] = await Promise.all([
    // latest employer decision per assignment wins; older ones stay as history (R2)
    q.query(
      `SELECT DISTINCT ON (roster_assignment_id) roster_assignment_id AS aid, decision, evidence, decided_on
         FROM employer_decisions WHERE roster_assignment_id = ANY($1::text[])
        ORDER BY roster_assignment_id, created_at DESC, id DESC`, [ids]),
    q.query(
      `SELECT a.roster_assignment_id AS aid, a.terms_version_id, t.label FROM acceptances a
         JOIN terms_versions t ON t.id = a.terms_version_id
        WHERE a.roster_assignment_id = ANY($1::text[]) ORDER BY a.created_at`, [ids]),
    // R6 active version per (assignment, type): most recent APPROVED, else latest submitted.
    // COALESCE matters: an unreviewed version has no qc row, and NULL must not sort behind a rejected one.
    q.query(
      `SELECT DISTINCT ON (dv.roster_assignment_id, dv.document_type)
              dv.roster_assignment_id AS aid, dv.document_type, dv.id, dv.version_no,
              COALESCE(qr.decision, 'pending_review') AS status, qr.reason
         FROM document_versions dv
         LEFT JOIN qc_reviews qr ON qr.document_version_id = dv.id
        WHERE dv.roster_assignment_id = ANY($1::text[])
        ORDER BY dv.roster_assignment_id, dv.document_type, COALESCE(qr.decision = 'approved', false) DESC, dv.version_no DESC`, [ids]),
    q.query(
      `SELECT roster_assignment_id AS aid, appointment_id FROM appointment_memberships
        WHERE status = 'booked' AND roster_assignment_id = ANY($1::text[])`, [ids]),
  ]);

  const current = terms.rows[0] as { id: string; label: string } | undefined;
  const requiredTypes: string[] = req.rows.map((r) => r.document_type);
  const empBy = new Map(emp.rows.map((r) => [r.aid, r]));
  const bookBy = new Map(book.rows.map((r) => [r.aid, r.appointment_id as string]));

  return asg.rows.map((a): Evaluation => {
    // Gate 1 — employer approval
    const e = empBy.get(a.id);
    const g1: Gate = !e
      ? { pass: false, code: 'no_employer_decision', reason: 'No employer hiring approval recorded' }
      : e.decision !== 'approved'
        ? { pass: false, code: 'employer_rejected', reason: `Employer did not approve hiring (decided ${e.decided_on})` }
        : { pass: true, code: 'ok', reason: `Employer approved on ${e.decided_on} (${e.evidence})` };

    // Gate 2 — acceptance of the CURRENT terms version (R8). Older versions never count; phone contact is not acceptance.
    const mine = acc.rows.filter((r) => r.aid === a.id);
    const g2: Gate = !current
      ? { pass: false, code: 'no_current_terms', reason: 'Job order has no current terms version' }
      : mine.some((r) => r.terms_version_id === current.id)
        ? { pass: true, code: 'ok', reason: `Accepted current terms ${current.label}` }
        : mine.length === 0
          ? { pass: false, code: 'no_acceptance', reason: `Worker has not accepted terms (current is ${current.label})` }
          : { pass: false, code: 'outdated_acceptance',
              reason: `Accepted ${mine.map((r) => r.label).join(', ')} only; current terms are ${current.label} and need re-acceptance` };

    // Gates 3 & 4 — documents
    const activeBy = new Map(docs.rows.filter((d) => d.aid === a.id).map((d) => [d.document_type, d]));
    const documents: ActiveDoc[] = requiredTypes.map((t) => {
      const d = activeBy.get(t);
      return d
        ? { documentType: t, versionId: d.id, versionNo: d.version_no, status: d.status === 'approved' ? 'approved' : d.status === 'rejected' ? 'rejected' : 'pending_review', reviewReason: d.reason }
        : { documentType: t, versionId: null, versionNo: null, status: 'missing', reviewReason: null };
    });
    const missing = documents.filter((d) => d.status === 'missing').map((d) => d.documentType);
    const g3: Gate = missing.length
      ? { pass: false, code: 'missing_documents', reason: `Missing documents: ${missing.join(', ')}` }
      : { pass: true, code: 'ok', reason: 'All required documents submitted' };
    const notApproved = documents.filter((d) => d.status !== 'approved');
    const g4: Gate = notApproved.length
      ? { pass: false, code: 'qc_not_approved',
          reason: notApproved.map((d) =>
            d.status === 'missing' ? `${d.documentType}: not submitted`
            : d.status === 'rejected' ? `${d.documentType}: rejected by QC${d.reviewReason ? ` (${d.reviewReason})` : ''}`
            : `${d.documentType}: pending QC review`).join('; ') }
      : { pass: true, code: 'ok', reason: 'All required documents QC-approved' };

    const gates = { employer_approval: g1, worker_acceptance: g2, documents: g3, qc: g4 };
    return {
      assignmentId: a.id, workerId: a.worker_id, workerName: a.full_name, assignmentStatus: a.status,
      ready: a.status === 'active' && Object.values(gates).every((g) => g.pass),
      gates, documents,
      booking: bookBy.has(a.id) ? { appointmentId: bookBy.get(a.id)! } : null,
    };
  });
}
