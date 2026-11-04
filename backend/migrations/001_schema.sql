-- Worker-operations slice: schema.
-- Rule IDs (R1..R12) refer to the take-home brief; each constraint says which rule it backs.

-- ---------------------------------------------------------------------------
-- Identity & access (R12). Authentication is out of scope: X-User-Id maps to a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id   text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE users (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  branch_id  text REFERENCES branches(id),          -- NULL only for users with no branch scope
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users(id),
  role    text NOT NULL CHECK (role IN ('capturist','qc_reviewer','labor_coordinator','worker')),
  PRIMARY KEY (user_id, role)
);

-- ---------------------------------------------------------------------------
-- R1: job orders are *referenced* from the case system by external id; this is a stub.
-- ---------------------------------------------------------------------------
CREATE TABLE job_orders (
  id         text PRIMARY KEY,                       -- external id, e.g. JO-2026-0142
  branch_id  text NOT NULL REFERENCES branches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terms_versions (
  id           text PRIMARY KEY,
  job_order_id text NOT NULL REFERENCES job_orders(id),
  label        text NOT NULL,                        -- v1, v2 ...
  status       text NOT NULL CHECK (status IN ('current','superseded')),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_order_id, label),
  UNIQUE (id, job_order_id)                          -- target of composite FKs below
);
-- Exactly one current terms version per job order (gate 2 depends on it).
CREATE UNIQUE INDEX terms_one_current_per_order ON terms_versions (job_order_id) WHERE status = 'current';

CREATE TABLE required_document_types (
  job_order_id  text NOT NULL REFERENCES job_orders(id),
  document_type text NOT NULL,
  PRIMARY KEY (job_order_id, document_type)
);

-- ---------------------------------------------------------------------------
-- R1: Worker = persistent identity (outlives a season). Roster assignment = worker on one order.
-- ---------------------------------------------------------------------------
CREATE TABLE workers (
  id         text PRIMARY KEY,
  user_id    text NOT NULL UNIQUE REFERENCES users(id),
  full_name  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roster_assignments (
  id                 text PRIMARY KEY,
  worker_id          text NOT NULL REFERENCES workers(id),
  job_order_id       text NOT NULL REFERENCES job_orders(id),
  owner_capturist_id text NOT NULL REFERENCES users(id),   -- receives correction tasks (R7)
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')), -- R2
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, job_order_id),
  UNIQUE (id, job_order_id)
);
CREATE INDEX roster_assignments_order_idx ON roster_assignments (job_order_id);

-- ---------------------------------------------------------------------------
-- Gate 1 / gate 2 evidence. Append-only: the latest row wins, history stays (R2).
-- ---------------------------------------------------------------------------
CREATE TABLE employer_decisions (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  roster_assignment_id text NOT NULL REFERENCES roster_assignments(id),
  decision             text NOT NULL CHECK (decision IN ('approved','rejected')),
  evidence             text NOT NULL CHECK (evidence IN ('document','verbal')),
  decided_on           date NOT NULL,
  decided_by           text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX employer_decisions_assignment_idx ON employer_decisions (roster_assignment_id, created_at DESC);

CREATE TABLE acceptances (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  roster_assignment_id text NOT NULL,
  job_order_id         text NOT NULL,
  terms_version_id     text NOT NULL,
  method               text NOT NULL CHECK (method IN ('verbal','in_app')),
  accepted_by          text NOT NULL REFERENCES users(id),
  on_behalf_of         text REFERENCES users(id),     -- set when a coordinator records it for the worker
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The terms version and the assignment must belong to the SAME job order (DB-enforced).
  FOREIGN KEY (roster_assignment_id, job_order_id) REFERENCES roster_assignments (id, job_order_id),
  FOREIGN KEY (terms_version_id, job_order_id)     REFERENCES terms_versions (id, job_order_id),
  UNIQUE (roster_assignment_id, terms_version_id)     -- accepting the same version twice is a no-op
);

-- ---------------------------------------------------------------------------
-- R2/R4/R5/R6: document versions are immutable; "status" is NOT a column, it is derived from
-- qc_reviews (no review row => pending_review). That makes "approved" impossible to forge by UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE document_versions (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  roster_assignment_id text NOT NULL,
  job_order_id         text NOT NULL,
  document_type        text NOT NULL,
  version_no           integer NOT NULL CHECK (version_no > 0),
  fields               jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_ref             text NOT NULL,
  submitted_by         text NOT NULL REFERENCES users(id),
  captured_by          text REFERENCES users(id),        -- staff who keyed it in, if any (R7)
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (roster_assignment_id, job_order_id) REFERENCES roster_assignments (id, job_order_id),
  FOREIGN KEY (job_order_id, document_type)        REFERENCES required_document_types (job_order_id, document_type),
  UNIQUE (roster_assignment_id, document_type, version_no)
);

-- R5: one row per (caller, clientSubmissionId). Stores the ORIGINAL response so a replay returns it verbatim.
CREATE TABLE client_submissions (
  submitted_by         text NOT NULL REFERENCES users(id),
  client_submission_id text NOT NULL,
  request_hash         text NOT NULL,
  document_version_id  text REFERENCES document_versions(id),
  response             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submitted_by, client_submission_id)
);

CREATE TABLE qc_reviews (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_version_id text NOT NULL UNIQUE REFERENCES document_versions(id),  -- one verdict per version
  reviewer_id         text NOT NULL REFERENCES users(id),
  decision            text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (decision = 'approved' OR length(btrim(coalesce(reason,''))) > 0)      -- a rejection must say why
);

CREATE TABLE tasks (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  roster_assignment_id text NOT NULL REFERENCES roster_assignments(id),
  kind                 text NOT NULL CHECK (kind IN ('qc_rejection','conflict')),
  document_type        text,
  document_version_id  text REFERENCES document_versions(id),
  assigned_to          text NOT NULL REFERENCES users(id),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  reason               text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);
-- At most one task of a kind per document version: a replay can never create a second task (R5).
CREATE UNIQUE INDEX tasks_one_per_version_kind ON tasks (document_version_id, kind) WHERE document_version_id IS NOT NULL;
CREATE INDEX tasks_assignee_open_idx ON tasks (assigned_to) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Scheduling (R9-R11)
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id           text PRIMARY KEY,
  job_order_id text NOT NULL REFERENCES job_orders(id),
  capacity     integer NOT NULL CHECK (capacity > 0),
  starts_at    timestamptz NOT NULL,
  UNIQUE (id, job_order_id)
);

CREATE TABLE appointment_memberships (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  appointment_id       text NOT NULL,
  roster_assignment_id text NOT NULL,
  job_order_id         text NOT NULL,
  status               text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  booked_by            text NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at         timestamptz,
  FOREIGN KEY (appointment_id, job_order_id)       REFERENCES appointments (id, job_order_id),
  FOREIGN KEY (roster_assignment_id, job_order_id) REFERENCES roster_assignments (id, job_order_id)
);
-- R10: an assignment can hold at most ONE live booking, across all appointments.
CREATE UNIQUE INDEX one_live_booking_per_assignment ON appointment_memberships (roster_assignment_id) WHERE status = 'booked';
CREATE INDEX memberships_appointment_idx ON appointment_memberships (appointment_id) WHERE status = 'booked';

-- ---------------------------------------------------------------------------
-- R3: audit log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     text NOT NULL,                 -- not an FK: allows 'system:*' actors (seed, jobs)
  on_behalf_of text,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  field        text NOT NULL,
  old_value    jsonb,
  new_value    jsonb,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, id);
