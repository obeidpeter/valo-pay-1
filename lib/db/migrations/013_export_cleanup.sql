-- Apply with the schema owner to the sandbox/service schema before deploying.
-- No FK: these deletion tombstones must survive removal of their source lender.
-- Do not apply to restricted runtime schemas or grant tenant runtime access.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS valopay_export_cleanup (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  bucket text NOT NULL,
  object_name text NOT NULL,
  checksum text,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT valopay_export_cleanup_attempts CHECK (attempts >= 0),
  last_failure text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS valopay_export_cleanup_due ON valopay_export_cleanup(next_attempt_at,id);
REVOKE ALL ON valopay_export_cleanup FROM PUBLIC;
COMMIT;
