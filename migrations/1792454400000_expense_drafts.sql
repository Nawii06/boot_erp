-- Up Migration
CREATE TABLE expense_drafts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  work_id uuid NOT NULL,
  applicant_id uuid NOT NULL REFERENCES users(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(work_id,project_id) REFERENCES work_items(id,project_id)
);
CREATE TABLE expense_policy_versions (
  id uuid PRIMARY KEY,
  type_key text NOT NULL,
  subtype text NOT NULL,
  version bigint NOT NULL CHECK (version >= 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type_key,subtype,version)
);
CREATE TABLE expense_draft_versions (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES expense_drafts(id),
  version bigint NOT NULL CHECK (version >= 0),
  budget_line_id uuid REFERENCES budget_accounts(line_id),
  policy_version_id uuid REFERENCES expense_policy_versions(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(draft_id,version)
);
CREATE TABLE expense_files (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES expense_drafts(id),
  slot_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 0),
  filename text NOT NULL,
  label text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 5242880),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(draft_id,slot_id,version)
);
CREATE INDEX expense_drafts_work_idx ON expense_drafts(work_id);
CREATE INDEX expense_files_draft_idx ON expense_files(draft_id);
CREATE TRIGGER immutable_expense_policy_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_policy_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_expense_draft_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_draft_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_expense_files BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_files FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE FUNCTION protect_expense_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expense_draft_immutable'; END IF;
  IF (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version')
    THEN RAISE EXCEPTION 'expense_identity_immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER protect_expense_draft BEFORE UPDATE OR DELETE ON expense_drafts FOR EACH ROW EXECUTE FUNCTION protect_expense_draft();
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'expense_down_disabled_use_forward_migration'; END $$;
