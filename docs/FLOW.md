# How we got here — the reasoning, in build order

Each step is one or more commits. The point of this file is the *why*, so a reviewer can follow the line of thought
without reconstructing it from the diff.

## 0. Read the brief as a list of things that can go wrong
The brief is twelve rules (R1–R12). Almost every one is a way for the system to lie: an unreviewed document counted
as reviewed (R4), a retry that creates a second record (R5), an approved value silently overwritten (R6), a worker
booked twice (R10). So the design question for every rule was: *where is the cheapest place to make the lie impossible?*
The answer is the deepest layer that can express the rule: the database when it is a property of rows, application code when it needs context (who is calling, what the gates say).

## 1. Schema first (commit 1)
- **Derived status instead of a status column.** `document_versions` is immutable; "approved/rejected" lives only in `qc_reviews` (one row per version). Absence of a review *is* `pending_review`. This makes R2 (immutability) and R4 (only QC approval counts) structural: there is no column to forge.
- **Composite foreign keys** tie children to the same job order (acceptance ↔ terms version, membership ↔ appointment, document ↔ required type), so cross-order mixups cannot be inserted.
- **Partial unique indexes** carry R10 (one live booking per assignment), "one current terms version per order", and "one task per version+kind" (a replay cannot create a second task).
- **Triggers** are backstops for what indexes cannot say: append-only tables (R2/R3), reviewer independence (R7), capacity (R10). The app checks first for good messages; the DB guarantees the invariant even if someone writes with psql.

## 2. Seed = the contract (commit 2)
The seed recreates the brief's starting state exactly and is idempotent. Tests and the UI start from it, so every scenario in the brief is runnable verbatim. Seed writes through the same triggers (Luis can review Marta's work; nothing is faked past the constraints) except the reset itself.

## 3. One readiness function (commit 3)
Gates are computed in `domain/gates.ts` only. The readiness endpoint and the scheduler both call it, and the scheduler calls it *inside the booking transaction after taking locks*. That is how R9 ("never trust the UI") is made true by construction: there is no second implementation that could drift.
Active document version (R6) = most recent approved, else latest submitted — expressed as one `DISTINCT ON` ordering.

## 4. Write paths: lock the assignment, then do the work
Every mutation (submit, review, decide, accept, schedule) takes `SELECT … FOR UPDATE` on the roster assignment(s) first.
That single rule serialises per-worker history (version numbers, replays), and makes scheduling's gate re-check race-free against a concurrent QC approval or terms change on the same worker.
Scheduling's lock order is fixed — appointment, then assignments sorted by id — which prevents deadlocks between coordinators.

## 5. Permissions fail closed
A global hook denies any route that did not declare `config.roles`. Branch/ownership scoping lives in one helper (`requireAssignmentAccess`), and out-of-scope records answer 404 exactly like missing ones.

## 6. Tests prove the risky behaviour
Each test targets a way the system could lie: replay (sequential *and* simultaneous), non-independent review (app *and* DB), resubmission reset, outdated terms, mixed-batch scheduling, concurrent capacity/double-booking (plus DB-level backstops), cross-branch access, unknown routes. Two real bugs were caught here (see AI log in DECISIONS.md).

## 7. UI last
One screen. The server owns all truth: after every schedule call the board refetches gates and capacity; per-worker results are shown inline from the response.
