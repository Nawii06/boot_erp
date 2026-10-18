-- Up Migration
ALTER TABLE login_accounts ADD COLUMN binding_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE login_accounts ADD COLUMN ownership_after timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE projects ADD COLUMN business_year integer CHECK (business_year BETWEEN 2000 AND 2200);
ALTER TABLE projects ADD COLUMN version bigint NOT NULL DEFAULT 0 CHECK (version >= 0);
CREATE TABLE oauth_flows (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE otp_credentials (
  user_id uuid PRIMARY KEY REFERENCES login_accounts(user_id),
  encrypted_secret text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  last_counter bigint NOT NULL DEFAULT -1,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) <= 5000),
  assigned_to uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX work_project_idx ON work_items(project_id);
CREATE INDEX work_assignee_idx ON work_items(assigned_to);
CREATE TABLE work_history (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL REFERENCES work_items(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX work_history_time_idx ON work_history(work_id, created_at);
CREATE TRIGGER immutable_work_history BEFORE UPDATE OR DELETE OR TRUNCATE ON work_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TABLE project_history (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX project_history_time_idx ON project_history(project_id, created_at);
CREATE TRIGGER immutable_project_history BEFORE UPDATE OR DELETE OR TRUNCATE ON project_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'access_services_down_disabled_use_forward_migration'; END $$;
