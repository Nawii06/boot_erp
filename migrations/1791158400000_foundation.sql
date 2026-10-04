-- Up Migration
CREATE TABLE people (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  person_id uuid REFERENCES people(id),
  auth_subject text UNIQUE,
  role text NOT NULL CHECK (role IN ('researcher','principal_investigator','staff','admin')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('research','program')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE project_memberships (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  UNIQUE (project_id, user_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX memberships_user_idx ON project_memberships(user_id);
-- This is an immutable initial amount, not current/available budget or a reservation policy.
CREATE TABLE budget_lines (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  internal_label text NOT NULL CHECK (length(btrim(internal_label)) BETWEEN 1 AND 200),
  original_amount bigint NOT NULL CHECK (original_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, project_id)
);
CREATE TABLE spend_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  applicant_id uuid NOT NULL REFERENCES users(id),
  budget_line_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, project_id),
  FOREIGN KEY (budget_line_id, project_id) REFERENCES budget_lines(id, project_id)
);
CREATE INDEX spend_cases_project_idx ON spend_cases(project_id);
CREATE TABLE command_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_id, request_id),
  FOREIGN KEY (actor_id, request_id) REFERENCES command_receipts(actor_id, request_id)
);
CREATE INDEX audit_project_time_idx ON audit_events(project_id, created_at);

CREATE FUNCTION reject_foundation_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_record' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE OR TRUNCATE ON command_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_initial_budget BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();

-- Down Migration
-- Initial schema rollback is deliberately prohibited after data can exist.
-- Test disposable databases by recreating their own schema; add forward corrections in shared DBs.
DO $$ BEGIN RAISE EXCEPTION 'foundation_down_disabled_use_forward_migration'; END $$;
