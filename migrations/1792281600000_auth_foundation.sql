-- Up Migration
-- No accounts are activated or mapped from email automatically.
CREATE TABLE login_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  email text NOT NULL UNIQUE,
  auth_version bigint NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$')
);
CREATE TABLE email_ownership_checks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES login_accounts(user_id),
  email text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('verified','rejected')),
  method text NOT NULL CHECK (length(btrim(method)) BETWEEN 1 AND 500),
  checked_by uuid NOT NULL REFERENCES users(id),
  checked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$')
);
CREATE INDEX ownership_user_time_idx ON email_ownership_checks(user_id, checked_at);
CREATE TABLE auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES login_accounts(user_id),
  provider_key text NOT NULL CHECK (length(btrim(provider_key)) BETWEEN 1 AND 100),
  issuer text NOT NULL CHECK (length(btrim(issuer)) BETWEEN 1 AND 1000),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 500),
  enabled boolean NOT NULL DEFAULT false,
  linked_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider_key, issuer, subject),
  UNIQUE (id, user_id)
);
CREATE INDEX identities_user_idx ON auth_identities(user_id);
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES login_accounts(user_id),
  identity_id uuid NOT NULL,
  slot smallint NOT NULL CHECK (slot IN (1,2)),
  auth_version bigint NOT NULL CHECK (auth_version >= 0),
  issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  step_up_at timestamptz,
  FOREIGN KEY (identity_id, user_id) REFERENCES auth_identities(id, user_id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '8 hours'),
  CHECK (last_seen_at >= issued_at AND last_seen_at <= expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (step_up_at IS NULL OR (step_up_at >= issued_at AND step_up_at <= expires_at))
);
-- Expired sessions must be revoked before reusing a slot; keep their history.
CREATE UNIQUE INDEX sessions_live_slot_idx ON auth_sessions(user_id, slot) WHERE revoked_at IS NULL;
CREATE TABLE account_audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  target_user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_id, request_id)
);
CREATE INDEX account_audit_target_time_idx ON account_audit_events(target_user_id, created_at);
CREATE TRIGGER immutable_ownership BEFORE UPDATE OR DELETE OR TRUNCATE ON email_ownership_checks
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_account_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON account_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'auth_foundation_down_disabled_use_forward_migration'; END $$;
