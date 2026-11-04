-- Database-level backstops. The application checks the same rules first (to give good error messages);
-- these triggers make sure no other writer (script, future service, psql) can break them.

-- R2 / R3: append-only tables cannot be updated, deleted or truncated.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R2/R3: % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'WK002';
END $$;

-- R2: nothing is deleted anywhere else either (cancel / archive / supersede instead).
CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'R2: % rows are never deleted; cancel or supersede instead', TG_TABLE_NAME USING ERRCODE = 'WK002';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','document_versions','qc_reviews','employer_decisions','acceptances'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['branches','users','user_roles','job_orders','terms_versions','required_document_types',
                           'workers','roster_assignments','tasks','appointments','appointment_memberships'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t || '_no_delete', t);
  END LOOP;
END $$;

-- R7: reviewer must be independent of whoever submitted or captured the version.
CREATE FUNCTION qc_enforce_independence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dv document_versions%ROWTYPE;
BEGIN
  SELECT * INTO dv FROM document_versions WHERE id = NEW.document_version_id;
  IF NEW.reviewer_id = dv.submitted_by OR NEW.reviewer_id = dv.captured_by THEN
    RAISE EXCEPTION 'R7: reviewer % submitted or captured version %', NEW.reviewer_id, dv.id USING ERRCODE = 'WK007';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_reviews_independence BEFORE INSERT ON qc_reviews
  FOR EACH ROW EXECUTE FUNCTION qc_enforce_independence();

-- R10: capacity. Locking the appointment row serialises concurrent bookings into the same appointment,
-- so the count below is always read after every earlier booking has committed.
CREATE FUNCTION enforce_appointment_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer; taken integer;
BEGIN
  IF NEW.status <> 'booked' THEN RETURN NEW; END IF;
  SELECT capacity INTO cap FROM appointments WHERE id = NEW.appointment_id FOR UPDATE;
  SELECT count(*) INTO taken FROM appointment_memberships
   WHERE appointment_id = NEW.appointment_id AND status = 'booked' AND id <> NEW.id;
  IF taken >= cap THEN
    RAISE EXCEPTION 'R10: appointment % is full (% of %)', NEW.appointment_id, taken, cap USING ERRCODE = 'WK010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_capacity BEFORE INSERT OR UPDATE OF status ON appointment_memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_appointment_capacity();
