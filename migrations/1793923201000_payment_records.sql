-- Up Migration
-- Append-only manual facts. No remittance, external authentication or automatic tax calculation.
CREATE TABLE external_claim_links (
  case_id uuid PRIMARY KEY REFERENCES spend_states(case_id),
  document_number text NOT NULL UNIQUE CHECK(length(btrim(document_number)) BETWEEN 1 AND 200),
  actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE external_claim_attempts (
  id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES external_claim_links(case_id),
  project_id uuid NOT NULL REFERENCES projects(id),kind text NOT NULL CHECK(kind IN ('submitted','rejected','resubmitted')),
  occurred_on date NOT NULL,evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 1000),
  actor_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(case_id,project_id) REFERENCES spend_cases(id,project_id),UNIQUE(actor_id,request_id)
);
CREATE TABLE payment_records (
  id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES external_claim_links(case_id),project_id uuid NOT NULL REFERENCES projects(id),
  gross_amount bigint NOT NULL CHECK(gross_amount>0),withheld_amount bigint NOT NULL CHECK(withheld_amount>=0),net_amount bigint NOT NULL CHECK(net_amount>=0),
  paid_on date NOT NULL,evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 1000),
  actor_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(withheld_amount::numeric+net_amount::numeric=gross_amount),
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(case_id,project_id) REFERENCES spend_cases(id,project_id),UNIQUE(actor_id,request_id),UNIQUE(id,case_id)
);
CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY,payment_id uuid NOT NULL,case_id uuid NOT NULL REFERENCES spend_states(case_id),project_id uuid NOT NULL REFERENCES projects(id),
  amount bigint NOT NULL CHECK(amount>0),refunded_on date NOT NULL,evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 1000),
  actor_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(payment_id,case_id) REFERENCES payment_records(id,case_id),FOREIGN KEY(case_id,project_id) REFERENCES spend_cases(id,project_id),
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(actor_id,request_id),UNIQUE(id,case_id)
);
CREATE TABLE refund_restorations (
  refund_id uuid PRIMARY KEY,case_id uuid NOT NULL,restored_on date NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(refund_id,case_id) REFERENCES payment_refunds(id,case_id),
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(actor_id,request_id)
);
CREATE TABLE settlement_events (
  id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES spend_states(case_id),project_id uuid NOT NULL REFERENCES projects(id),
  action text NOT NULL CHECK(action IN ('close','reopen')),actor_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(case_id,project_id) REFERENCES spend_cases(id,project_id),
  FOREIGN KEY(actor_id,request_id) REFERENCES command_receipts(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(actor_id,request_id)
);
CREATE INDEX external_claim_attempt_case_idx ON external_claim_attempts(case_id,created_at,id);
CREATE INDEX payment_records_case_idx ON payment_records(case_id,paid_on,id);
CREATE INDEX payment_refunds_case_idx ON payment_refunds(case_id,refunded_on,id);
CREATE INDEX settlement_events_case_idx ON settlement_events(case_id,created_at,id);
CREATE TRIGGER immutable_external_claim_links BEFORE UPDATE OR DELETE OR TRUNCATE ON external_claim_links FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_external_claim_attempts BEFORE UPDATE OR DELETE OR TRUNCATE ON external_claim_attempts FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_payment_records BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_records FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_payment_refunds BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_refunds FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_refund_restorations BEFORE UPDATE OR DELETE OR TRUNCATE ON refund_restorations FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_settlement_events BEFORE UPDATE OR DELETE OR TRUNCATE ON settlement_events FOR EACH STATEMENT EXECUTE FUNCTION reject_foundation_rewrite();
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'payments_down_disabled_use_forward_migration'; END $$;
