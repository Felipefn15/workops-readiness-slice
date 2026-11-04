# DECISIONS

Rule IDs (R1–R12) are the brief's. Stack: **Fastify + `pg` (raw SQL) + Zod**, PostgreSQL 16, React/Vite, Vitest.

**Why raw SQL instead of an ORM?** The risky parts of this slice are locks (`FOR UPDATE`), `DISTINCT ON`, partial indexes, triggers
and `ON CONFLICT`. An ORM would hide exactly the statements I need to see and reason about. Cost: more hand-written SQL and no generated types; for
a slice this size that is acceptable, and the migrations are plain SQL regardless.

## Data model
Key tables: `branches`, `users`/`user_roles`, `job_orders` (stub, external id), `terms_versions`, `required_document_types`, `workers`,
`roster_assignments`, `employer_decisions`, `acceptances`, `document_versions`, `qc_reviews`, `client_submissions`, `tasks`,
`appointments`, `appointment_memberships`, `audit_log`.

| Rule | Where enforced | How |
|---|---|---|
| R1 | DB | Worker ≠ assignment (`UNIQUE(worker_id, job_order_id)`); job order is a stub keyed by external id |
| R2 | DB | Immutable-table triggers (versions, reviews, acceptances, employer decisions, audit); delete-blocking triggers elsewhere; cancel via `status` |
| R3 | DB + app | App writes an audit row in the same transaction as every change; table is append-only by trigger (stretch goal #3) |
| R4 | DB | `status` is not a column: derived from `qc_reviews` (no row = pending_review) |
| R5 | DB + app | PK `(submitted_by, client_submission_id)`; unique `tasks(version, kind)` |
| R6 | App | Needs comparison of field values: done in the submission transaction; active version is a query |
| R7 | DB + app | Trigger on `qc_reviews`; app pre-checks for a precise 403; `UNIQUE(document_version_id)` = one verdict |
| R8 | App | Context-dependent; one function (`gates.ts`) |
| R9 | App | Gates re-evaluated inside the booking transaction |
| R10 | DB + app | Appointment row lock; partial unique index (one live booking per assignment); capacity trigger |
| R11 | App | Nothing removes memberships; gates only gate *new* bookings; an existing booking reports `already_scheduled` |
| R12 | App | Server-side route policy + scoping helpers (no RLS: see "What you cut") |

Why split like this: invariants that are properties of rows (uniqueness, immutability, capacity, independence) belong in the DB because they hold for every
future writer. Rules that need business context (gates, who may call) belong in code, where they can be tested and explained.

## Idempotency (R5)
`client_submissions` has PK `(submitted_by, clientSubmissionId)`, a SHA-256 of the request, and the **original response JSON**.
Flow, inside one transaction holding the assignment lock: `INSERT … ON CONFLICT DO NOTHING`. If we won, do the work and store the response; if we lost, read the stored response
and return it (HTTP 200 + `Idempotent-Replayed: true`, body identical). The key is scoped per caller so one worker cannot probe another's keys.
Same key with a different payload → 409 `idempotency_key_reuse` instead of silently returning something that does not match the request.
**Simultaneous replays:** the assignment lock serialises them; the loser waits, then finds the committed receipt. Even without that lock the unique index would block the second insert until the first commits.
A test fires four identical requests at once: one 201, three 200, one version. Trade-off: replays return the *original* result even if the version has since been reviewed; the client should poll state for current status.

## Scheduling under concurrency (R9, R10)
One transaction, READ COMMITTED, explicit locks, in this order: (1) appointment row `FOR UPDATE`; (2) requested assignment rows `FOR UPDATE ORDER BY id`;
(3) re-evaluate the gates with the same function the board uses; (4) count live bookings; (5) insert memberships for the eligible, in request order, until capacity.
Why not SERIALIZABLE: it would also be correct but forces retry loops for serialization failures and gives worse tail latency for a hot appointment; here the contended resources are known up front (one appointment + a handful of assignments), so pessimistic locks are simpler and deterministic.
Why not only a unique index/trigger: that makes the *second* request fail, but a batch needs partial success with per-worker reasons; the locks make the decision before inserting, and the index/trigger remain as a backstop (tested directly).
Fixed lock order (appointment → sorted assignments) prevents deadlock. Because review/acceptance/employer-decision also lock the assignment, a QC rejection cannot slip between "gates passed" and "booked" for that worker.
A worker requested for two appointments at once is booked once (assignment lock + partial unique index). The batch always returns HTTP 200 with per-assignment outcomes, including when everything is refused.

## Permissions (R12)
- Identity: `X-User-Id` → `users` + `user_roles`. Missing/unknown/inactive → 401; user with no roles → 403.
- A **global preHandler denies any route that has no `config.roles`**, so a forgotten policy fails closed (tested by registering such a route).
- Branch/ownership: `requireJobOrderInBranch` and `requireAssignmentAccess` (workers: own assignments only; staff: own branch). Used by every handler.
- **403 vs 404:** wrong *role* → 403 (the endpoint is not a secret). Existing record outside your scope → **404**, identical to a missing one, so ids cannot be enumerated across branches/workers. Cost: a mistyped id and a forbidden id look the same to a legitimate user; the UI explains both.

## Assumptions
1. **Seed ambiguity:** Bruno's other two documents are approved (so approving his passport makes him ready, as the scenario says). Worker acceptance in the seed is verbal, recorded by Pedro on the worker's behalf.
2. **Conflict (R6)** = any field present in both the approved version and the new submission whose value differs (e.g. `documentNumber`). A new file with identical fields is not a conflict: it becomes the next pending version while the approved one stays active (active = most recent *approved*), so the worker stays ready. Renewed passports (new expiry only) *do* raise a correction task; I preferred a false alarm over silent overwrite.
3. "Resubmission clears prior QC" is realised by derivation: after a rejection there is no approved version, so the new pending version is active and the worker is not ready until approved.
4. A resubmission resolves open `qc_rejection` tasks of that document type; a QC verdict resolves open tasks tied to that version.
5. A document type must be in the order's required list (else 400). Missing required doc fails gate 3 *and* gate 4 (gate 4 reason says "not submitted").
6. Employer decisions are append-only; the latest wins; `rejected` is allowed so approval can be withdrawn. Acceptance of the same terms twice is a no-op (200). Coordinators may record either method; the audit row stores `on_behalf_of`.
7. A worker booked in a *different* appointment is refused (`already_booked_elsewhere`); booked in *this* one → `already_scheduled`. Cancelling bookings has no endpoint (schema supports it).
8. Reviewers must belong to the job order's branch; a reviewer who is also the worker is refused. `captured_by` exists on versions for staff-keyed data (seeded for Rosa) but no capture endpoint was built.
9. Unknown user → 401 (authentication), not 403. Everything else follows the brief's codes.

## What you cut / what is fragile
- **No RLS**: scoping is in handlers. A new handler that forgets the helper would leak; the route-policy hook covers roles, not scoping. Next: Postgres RLS keyed on a per-request `SET LOCAL app.user_id`.
- Audit rows are written by application code (field-level), not generated by triggers, so a future writer could skip them (it cannot edit or delete them).
- No pagination on readiness (fine for 6, not for 300; see Q3). No cancel-booking, QC-queue, capture or reconfirmation endpoints. No i18n toggle.
- Stretch goals: only **#3 (audit append-only enforced in the database)** was done. Fewer, finished and tested.
- Gate re-check is race-free only for writes that take the assignment lock (all current ones). Direct SQL changes would not.
- UI has no tests; it was verified manually in the browser. File upload is a string `fileRef` per the brief.
- READ COMMITTED: the readiness *board* reads several queries without a shared snapshot, so it may show a state that is a few ms inconsistent. Scheduling does not depend on it.

## AI usage log
- **Tool:** Claude Code (Claude Sonnet 5.5) for scaffolding, SQL, tests, UI and drafting these docs. I gave it the full brief and rule IDs up front, and the design decisions above were set before code (derived status, lock order, fail-closed hook).
- **Where it was wrong #1:** first draft of the active-version query ordered `(decision='approved') DESC NULLS LAST, version_no DESC`. An unreviewed new version has no review row, so its value is NULL and sorted *behind* an older *rejected* version: the resubmission was invisible and Elena stayed "rejected". Caught by the resubmission test; fixed with `COALESCE(..., false)`.
- **Where it was wrong #2:** the gate queries passed `[jobOrderId, ids]` while referencing only `$2`; Postgres cannot infer the type of an unused parameter and the scheduler returned 500s. Caught by the mixed-batch test; restructured to fetch ids first and pass one array.
- **Smaller:** it proposed a global `UNIQUE(client_submission_id)`; I scoped it per caller to avoid cross-worker probing. Its first test tried to register a route after `app.ready()` (Fastify forbids it); rewritten with a second app instance.
- **Verification:** every rule has a test against real Postgres; concurrency tests run repeatedly (3 consecutive green runs) and also assert the DB backstops directly by bypassing the app; UI checked by hand in a browser (schedule Ana+Fausto → capacity 0/2 and inline results).

## Written questions
**1. Three offline actions, terms v3 published meanwhile.** Passport upload: accept; it is evidence, independent of terms, and lands pending_review (idempotent by clientSubmissionId). Terms acceptance: it names a specific version; if that is v2 it is recorded truthfully but does *not* satisfy gate 2 (current is v3), so the server returns the recorded acceptance with `isCurrentTerms:false` and the worker sees "terms changed, please review v3". Never silently upgrade consent to a document they did not see. Arrival confirmation: accept and record it if the assignment is still active; it does not bypass gates. The worker sees per-action results: uploaded (pending review), "accepted old terms – action needed", confirmed.

**2. "Order released" event from the case system.** Make the consumer idempotent: the event carries a stable id (order external id + event version); we store it in a processed-events table with a unique key and create intake tasks with unique `(job_order_id, kind)`, so redelivery is a no-op. Return 2xx only after commit; failures are retried with backoff plus a dead-letter. With the other team, agree a short contract first: payload schema with a version field, delivery semantics (at-least-once), auth/signing, a sandbox, and a feature flag so they can ship their side dark. They own their change; we ship tolerant reader code first, then they switch on, then we tighten validation.

**3. 300 workers, several coordinators.** First: the readiness endpoint, which computes every gate for the whole order on each refresh with no pagination, and the UI rendering 300 rows. Next: scheduling batches hold up to 300 assignment locks and serialise all coordinators on one appointment. Changes: paginate/filter readiness server-side, cache or materialise gate results invalidated by the lock-holding writes, cap batch size (~50) and lock only eligible rows after a cheap pre-filter, add indexes by order status, and use `SKIP LOCKED`-style claiming if coordinators work a shared queue.

**4. Two family members share one phone number.** The phone cannot be the identity: sign-in by number alone would let either person act as the other, which breaks R12 (workers see only their own data). Keep `Worker` as the identity, and treat phone as a *contact channel* that can map to many workers. Proposal: login = phone OTP **plus** a worker selector confirmed by a second factor tied to that person (date of birth or document number last digits, or a staff-issued invite code per worker); device-bound sessions per worker; audit records which worker acted. Staff flag shared-phone numbers so reminders name the worker.
