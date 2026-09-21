-- Phase 16 — admin audit foundation. Append-only log of privileged admin
-- actions (role changes, artist verification, ...). Rows are immutable by
-- construction: the HTTP surface exposes only reads, and the
-- `admin_audit_logs_no_mutation` trigger below rejects any UPDATE or DELETE
-- as defense in depth.

CREATE TABLE "admin_audit_logs" (
  "id" uuid NOT NULL,
  "actor_id" uuid,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_audit_logs_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" ("created_at" DESC);
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs" ("action");
CREATE INDEX "admin_audit_logs_actor_id_idx" ON "admin_audit_logs" ("actor_id");

CREATE OR REPLACE FUNCTION "admin_audit_logs_no_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admin_audit_logs_no_mutation"
BEFORE UPDATE OR DELETE ON "admin_audit_logs"
FOR EACH ROW EXECUTE FUNCTION "admin_audit_logs_no_mutation"();
