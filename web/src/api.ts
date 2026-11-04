export interface Gate { pass: boolean; code: string; reason: string }
export type GateKey = 'employer_approval' | 'worker_acceptance' | 'documents' | 'qc';
export interface Row {
  assignmentId: string; workerId: string; workerName: string; assignmentStatus: string; ready: boolean;
  gates: Record<GateKey, Gate>; booking: { appointmentId: string } | null;
}
export interface Readiness {
  jobOrderId: string; currentTermsVersion: { id: string; label: string } | null;
  summary: { total: number; ready: number }; assignments: Row[];
}
export interface Appointment { id: string; startsAt: string; capacity: number; booked: number; remaining: number }
export interface ScheduleResult {
  appointmentId: string; capacity: number; booked: number; remaining: number;
  results: { rosterAssignmentId: string; workerName: string | null; outcome: 'scheduled' | 'already_scheduled' | 'refused'; reasons: { code: string; message: string }[] }[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(userId: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'X-User-Id': userId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `HTTP ${res.status}`);
  return json as T;
}
