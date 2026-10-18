-- Up Migration
CREATE TABLE budget_codes (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK (code ~ '^N[0-9]{2}(\.[0-9]{2})?(\.[0-9]{3})?$'),
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 3)
);
CREATE TABLE budget_code_versions (
  id uuid PRIMARY KEY, code_id uuid NOT NULL REFERENCES budget_codes(id),
  version bigint NOT NULL CHECK (version >= 0), parent_id uuid REFERENCES budget_codes(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200), active boolean NOT NULL,
  effective_on date NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(code_id,version)
);
CREATE TABLE budget_accounts (
  line_id uuid PRIMARY KEY REFERENCES budget_lines(id),
  code_version_id uuid NOT NULL REFERENCES budget_code_versions(id), classification_snapshot jsonb NOT NULL,
  business_name text NOT NULL, business_year integer NOT NULL, academic_year integer NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL CHECK (period_end >= period_start),
  fund text NOT NULL CHECK (length(btrim(fund)) BETWEEN 1 AND 200),
  current_amount bigint NOT NULL CHECK (current_amount >= 0),
  committed_amount bigint NOT NULL DEFAULT 0 CHECK (committed_amount >= 0 AND committed_amount <= current_amount),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE budget_changes (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), applicant_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  kind text NOT NULL CHECK (kind IN ('transfer','total')),
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','reviewing','confirmed','rejected','cancelled')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  supersedes uuid REFERENCES budget_changes(id), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE budget_change_lines (
  change_id uuid NOT NULL REFERENCES budget_changes(id), line_id uuid NOT NULL REFERENCES budget_accounts(line_id),
  before_amount bigint NOT NULL CHECK (before_amount >= 0), after_amount bigint NOT NULL CHECK (after_amount >= 0),
  expected_version bigint NOT NULL CHECK (expected_version >= 0), PRIMARY KEY(change_id,line_id)
);
CREATE TABLE budget_files (
  id uuid PRIMARY KEY, change_id uuid NOT NULL REFERENCES budget_changes(id),
  filename text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 5242880),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(change_id,version)
);
ALTER TABLE work_items ADD CONSTRAINT work_project_unique UNIQUE(id,project_id);
CREATE TABLE spend_states (
  case_id uuid PRIMARY KEY, project_id uuid NOT NULL, work_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0), paid_amount bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= amount),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','reviewing','supplement','approved')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  processing_by uuid REFERENCES users(id), processing_at timestamptz,
  FOREIGN KEY(case_id,project_id) REFERENCES spend_cases(id,project_id),
  FOREIGN KEY(work_id,project_id) REFERENCES work_items(id,project_id),
  CHECK (paid_amount = 0 OR state='approved'),
  CHECK ((processing_by IS NULL) = (processing_at IS NULL))
);
CREATE INDEX budget_changes_project_idx ON budget_changes(project_id);
CREATE INDEX budget_files_change_idx ON budget_files(change_id);
CREATE INDEX spend_states_work_idx ON spend_states(work_id);
CREATE TABLE budget_events (
  id uuid PRIMARY KEY, project_id uuid REFERENCES projects(id), entity_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
  action text NOT NULL, reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL, after_state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX budget_events_entity_idx ON budget_events(entity_id,created_at);
CREATE TRIGGER immutable_budget_codes BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_codes FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_budget_code_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_code_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_budget_change_lines BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_change_lines FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_budget_files BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_files FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_budget_events BEFORE UPDATE OR DELETE OR TRUNCATE ON budget_events FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE FUNCTION protect_budget_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'budget_snapshot_immutable'; END IF;
  IF TG_TABLE_NAME='budget_accounts' AND
    (to_jsonb(NEW)-ARRAY['current_amount','committed_amount','version']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['current_amount','committed_amount','version']) THEN RAISE EXCEPTION 'budget_snapshot_immutable'; END IF;
  IF TG_TABLE_NAME='budget_changes' AND
    (to_jsonb(NEW)-ARRAY['state','version']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','version']) THEN RAISE EXCEPTION 'budget_snapshot_immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER protect_budget_account BEFORE UPDATE OR DELETE ON budget_accounts FOR EACH ROW EXECUTE FUNCTION protect_budget_snapshot();
CREATE TRIGGER protect_budget_change BEFORE UPDATE OR DELETE ON budget_changes FOR EACH ROW EXECUTE FUNCTION protect_budget_snapshot();
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'budget_down_disabled_use_forward_migration'; END $$;
