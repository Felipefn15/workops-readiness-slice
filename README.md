# Worker-operations slice — submissions, independent QC, readiness gates, scheduling

Backend (Fastify + PostgreSQL) and one staff screen (React): a worker's phone submits documents (retries included),
independent QC reviews them, the server decides who is ready, and a labor coordinator books eligible workers
into a consular appointment — safely under concurrency.

Docs: [`DECISIONS.md`](DECISIONS.md) (trade-offs, assumptions, AI log, written answers) ·
[`docs/FLOW.md`](docs/FLOW.md) (the reasoning, in the order we built it).

## Run it

Requires Node 20+ and Docker.

```bash
npm install
npm run db:up      # 1. start PostgreSQL 16 (docker compose, host port 5455)
npm run seed       # 2. migrate + (re)create the exact starting state from the brief; safe to re-run
npm run dev        # 3. API on :3300 and staff UI on http://localhost:5273
npm test           # 4. 25 tests against a real Postgres (creates/uses database workops_test)
```

`npm run typecheck` checks both packages. Ports are non-default on purpose (5455/3300/5273) so they do not clash with local services.

## Seeded identities (send as `X-User-Id`)

| User | Role / branch | | Worker user | Assignment |
|---|---|---|---|---|
| `u-pedro` | labor_coordinator, Norte | | `w-1` Ana | `ra-1` |
| `u-sofia` | labor_coordinator, Sur | | `w-2` Bruno | `ra-2` |
| `u-marta` | capturist, Norte | | `w-3` Carla | `ra-3` |
| `u-luis` | qc_reviewer, Norte | | `w-4` Diego | `ra-4` |
| `u-rosa` | capturist + qc_reviewer, Norte | | `w-5` Elena | `ra-5` |
| | | | `w-6` Fausto | `ra-6` |

Job order `JO-2026-0142` (Norte), terms `tv-0142-v1` (superseded) / `tv-0142-v2` (current), appointments `APT-1` (cap 2), `APT-2` (cap 1).

## API

| Endpoint | Who | Notes |
|---|---|---|
| `POST /api/mobile/submissions` | worker (own assignment) | 201 new, **200 + `Idempotent-Replayed: true`** on replay, 409 if the id is reused with a different payload |
| `POST /api/document-versions/:id/review` | qc_reviewer (branch) | `{decision: approve\|reject, reason}`; 403 `reviewer_not_independent` |
| `POST /api/roster-assignments/:id/employer-decision` | labor_coordinator | `{decision?, evidence: document\|verbal, decidedOn}` |
| `POST /api/roster-assignments/:id/acceptance` | coordinator or the worker | `{termsVersionId, method}`; repeats are no-ops |
| `GET  /api/job-orders/:id/readiness` | labor_coordinator | four gates per assignment with reasons |
| `GET  /api/job-orders/:id/appointments` | labor_coordinator | capacity / remaining (added for the UI) |
| `POST /api/appointments/:id/schedule` | labor_coordinator | partial batch → per-assignment `scheduled \| already_scheduled \| refused` + reasons; HTTP 200 |
| `GET  /api/me` | any role | who the server thinks you are |

Errors are always `{ "error": { "code", "message", "details?" } }`: 400 invalid input · 401 missing/unknown user · 403 wrong role or non-independent reviewer · 404 missing **or out-of-scope** record · 409 conflict.

Try the brief's scenarios:

```bash
curl -s localhost:3300/api/job-orders/JO-2026-0142/readiness -H 'X-User-Id: u-pedro' | jq '.assignments[] | {workerId, ready}'
curl -s -XPOST localhost:3300/api/appointments/APT-1/schedule -H 'X-User-Id: u-pedro' -H 'content-type: application/json' \
  -d '{"rosterAssignmentIds":["ra-1","ra-3","ra-4","ra-6"]}' | jq .results
```

## Layout

```
docker-compose.yml           PostgreSQL
backend/migrations/          001 schema · 002 integrity triggers (plain SQL, no ORM sync)
backend/src/domain/gates.ts  the ONLY place readiness is computed (board + scheduler share it)
backend/src/routes/          submissions · reviews · assignments · readiness · schedule
backend/src/auth.ts          actor loading, fail-closed route policy, branch/ownership scoping
backend/test/                real-Postgres tests, one per rule that can hurt
web/src/App.tsx              the readiness board
```
