import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Appointment, type GateKey, type Readiness, type Row, type ScheduleResult } from './api';

const USERS = [
  { id: 'u-pedro', label: 'Pedro — coordinator, Norte' },
  { id: 'u-sofia', label: 'Sofía — coordinator, Sur' },
  { id: 'u-marta', label: 'Marta — capturist, Norte' },
  { id: 'u-luis', label: 'Luis — QC reviewer, Norte' },
  { id: 'u-rosa', label: 'Rosa — capturist + QC, Norte' },
];
const GATES: { key: GateKey; label: string }[] = [
  { key: 'employer_approval', label: '1 Employer approval' },
  { key: 'worker_acceptance', label: '2 Terms accepted' },
  { key: 'documents', label: '3 Documents' },
  { key: 'qc', label: '4 QC approved' },
];

const load = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: fine */ } };

type State<T> = { status: 'loading' } | { status: 'error'; error: ApiError | Error } | { status: 'ok'; data: T };

export function App() {
  const [userId, setUserId] = useState(() => load('userId', 'u-pedro'));
  const [jobOrderId, setJobOrderId] = useState('JO-2026-0142');
  const [board, setBoard] = useState<State<{ readiness: Readiness; appointments: Appointment[] }>>({ status: 'loading' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apptId, setApptId] = useState<string>('');
  const [results, setResults] = useState<Map<string, ScheduleResult['results'][number]>>(new Map());
  const [busy, setBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [readiness, appts] = await Promise.all([
        api<Readiness>(userId, 'GET', `/api/job-orders/${jobOrderId}/readiness`),
        api<{ appointments: Appointment[] }>(userId, 'GET', `/api/job-orders/${jobOrderId}/appointments`),
      ]);
      setBoard({ status: 'ok', data: { readiness, appointments: appts.appointments } });
      setApptId((cur) => cur || appts.appointments[0]?.id || '');
    } catch (e) { setBoard({ status: 'error', error: e as Error }); }
  }, [userId, jobOrderId]);

  useEffect(() => { setBoard({ status: 'loading' }); setSelected(new Set()); setResults(new Map()); setScheduleError(null); refresh(); }, [refresh]);

  const schedule = async () => {
    setBusy(true); setScheduleError(null);
    try {
      const out = await api<ScheduleResult>(userId, 'POST', `/api/appointments/${apptId}/schedule`, { rosterAssignmentIds: [...selected] });
      setResults(new Map(out.results.map((r) => [r.rosterAssignmentId, r])));
      setSelected(new Set());
      await refresh(); // server is the source of truth for gates and remaining capacity
    } catch (e) { setScheduleError((e as Error).message); } finally { setBusy(false); }
  };

  const rows = board.status === 'ok' ? board.data.readiness.assignments : [];
  const appt = board.status === 'ok' ? board.data.appointments.find((a) => a.id === apptId) : undefined;
  const blockers = useMemo(() => GATES.map((g) => ({ ...g, failing: rows.filter((r) => !r.gates[g.key].pass).length })), [rows]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectable = rows.filter((r) => !r.booking);

  return (
    <div className="page">
      <header>
        <h1>Readiness board</h1>
        <label>Acting as&nbsp;
          <select value={userId} onChange={(e) => { setUserId(e.target.value); save('userId', e.target.value); }}>
            {USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </label>
        <label>Job order&nbsp;<input value={jobOrderId} onChange={(e) => setJobOrderId(e.target.value.trim())} /></label>
        <button onClick={() => { setBoard({ status: 'loading' }); refresh(); }}>Refresh</button>
      </header>

      {board.status === 'loading' && <p className="muted" role="status">Loading…</p>}
      {board.status === 'error' && (
        <div className="error" role="alert">
          <strong>{board.error instanceof ApiError ? `${board.error.status} ${board.error.code}` : 'Error'}</strong>: {board.error.message}
          {board.error instanceof ApiError && board.error.status === 404 && <div>This job order does not exist or is outside your branch.</div>}
          {board.error instanceof ApiError && board.error.status === 403 && <div>Your role cannot use this screen. Switch to a labor coordinator.</div>}
        </div>
      )}

      {board.status === 'ok' && (
        <>
          <section className="summary">
            <div className="big"><b>{board.data.readiness.summary.ready}</b> of {board.data.readiness.summary.total} ready to schedule
              <span className="muted"> · current terms {board.data.readiness.currentTermsVersion?.label ?? 'none'}</span></div>
            <div className="blockers">
              {blockers.map((b) => <span key={b.key} className={b.failing ? 'chip bad' : 'chip good'}>{b.label}: {b.failing ? `${b.failing} blocked` : 'all clear'}</span>)}
            </div>
          </section>

          <section className="appts">
            {board.data.appointments.map((a) => (
              <label key={a.id} className={`appt ${a.id === apptId ? 'on' : ''}`}>
                <input type="radio" name="appt" checked={a.id === apptId} onChange={() => setApptId(a.id)} />
                <b>{a.id}</b> <span>{new Date(a.startsAt).toLocaleString()}</span>
                <div className="cap"><div style={{ width: `${(a.booked / a.capacity) * 100}%` }} /></div>
                <span className={a.remaining === 0 ? 'bad-text' : ''}>{a.remaining} of {a.capacity} spots left</span>
              </label>
            ))}
            {board.data.appointments.length === 0 && <p className="muted">No appointments for this job order.</p>}
          </section>

          <section className="actions">
            <button disabled={busy || selected.size === 0 || !apptId} onClick={schedule}>
              {busy ? 'Scheduling…' : `Schedule ${selected.size} selected into ${apptId || '—'}`}
            </button>
            <button className="ghost" onClick={() => setSelected(new Set(rows.filter((r) => r.ready && !r.booking).map((r) => r.assignmentId)))}>Select all ready</button>
            <button className="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Clear</button>
            {appt && selected.size > appt.remaining && <span className="warn">Selection exceeds remaining capacity ({appt.remaining}); the server will refuse the overflow.</span>}
            {scheduleError && <span className="error inline" role="alert">{scheduleError}</span>}
          </section>

          {rows.length === 0 ? <p className="muted">No roster assignments on this job order yet.</p> : (
            <table>
              <thead>
                <tr><th></th><th>Worker</th>{GATES.map((g) => <th key={g.key}>{g.label}</th>)}<th>Status / result</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => <RowView key={r.assignmentId} row={r} checked={selected.has(r.assignmentId)} disabled={!!r.booking} onToggle={() => toggle(r.assignmentId)} result={results.get(r.assignmentId)} />)}
              </tbody>
            </table>
          )}
          <p className="muted small">{selectable.length} unbooked · gates are computed by the server; scheduling re-checks them at booking time.</p>
        </>
      )}
    </div>
  );
}

function RowView({ row, checked, disabled, onToggle, result }: {
  row: Row; checked: boolean; disabled: boolean; onToggle: () => void; result?: ScheduleResult['results'][number];
}) {
  return (
    <tr className={row.ready ? 'ready' : ''}>
      <td><input type="checkbox" aria-label={`select ${row.workerName}`} checked={checked} disabled={disabled} onChange={onToggle} /></td>
      <td><b>{row.workerName}</b><div className="muted small">{row.workerId} · {row.assignmentId}</div></td>
      {GATES.map((g) => {
        const gate = row.gates[g.key];
        return <td key={g.key} className={gate.pass ? 'pass' : 'fail'}><span aria-label={gate.pass ? 'pass' : 'fail'}>{gate.pass ? '✓' : '✗'}</span>{!gate.pass && <div className="why">{gate.reason}</div>}</td>;
      })}
      <td>
        {row.booking ? <span className="tag booked">Booked · {row.booking.appointmentId}</span> : row.ready ? <span className="tag go">Can go</span> : <span className="tag stop">Blocked</span>}
        {result && (
          <div className={`result ${result.outcome}`}>
            <b>{result.outcome === 'scheduled' ? 'Scheduled' : result.outcome === 'already_scheduled' ? 'Already scheduled' : 'Refused'}</b>
            {result.reasons.map((x) => <div key={x.code} className="why">{x.message}</div>)}
          </div>
        )}
      </td>
    </tr>
  );
}
