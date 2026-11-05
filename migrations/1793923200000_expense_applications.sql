-- Up Migration
CREATE TABLE expense_applications (
  id uuid PRIMARY KEY REFERENCES spend_cases(id),
  draft_id uuid NOT NULL UNIQUE REFERENCES expense_drafts(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE expense_submission_versions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES expense_applications(id),
  version bigint NOT NULL CHECK(version>=0),
  draft_version bigint NOT NULL CHECK(draft_version>=0),
  policy_version_id uuid NOT NULL REFERENCES expense_policy_versions(id),
  applicable_on date NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
  files_snapshot jsonb NOT NULL CHECK(jsonb_typeof(files_snapshot)='array'),
  actor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(application_id,version)
);
CREATE TABLE expense_review_notes (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES expense_applications(id),
  submission_id uuid NOT NULL REFERENCES expense_submission_versions(id),
  document_kind text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('note','missing','accepted')),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 2000),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX expense_submission_application_idx ON expense_submission_versions(application_id,version DESC);
CREATE INDEX expense_review_application_idx ON expense_review_notes(application_id,created_at);
CREATE TRIGGER immutable_expense_applications BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_applications FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_expense_submission_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_submission_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_expense_review_notes BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_review_notes FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'application_down_disabled_use_forward_migration'; END $$;
