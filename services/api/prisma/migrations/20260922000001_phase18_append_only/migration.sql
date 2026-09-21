-- Phase 18 — append-only enforcement for subscription_events.
--
-- Financial history must never be mutated or deleted. This migration adds a
-- database trigger that rejects UPDATE and DELETE on subscription_events.
-- Combined with the ON DELETE CASCADE from the subscription FK, this means
-- deleting a subscription with history will fail rather than silently
-- erasing financial records — subscriptions with events are effectively
-- immutable, matching the Phase 16 admin_audit_logs pattern.

CREATE OR REPLACE FUNCTION reject_subscription_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_events is append-only: % is not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscription_events_no_update ON "subscription_events";
CREATE TRIGGER subscription_events_no_update
  BEFORE UPDATE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION reject_subscription_event_mutation();

DROP TRIGGER IF EXISTS subscription_events_no_delete ON "subscription_events";
CREATE TRIGGER subscription_events_no_delete
  BEFORE DELETE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION reject_subscription_event_mutation();
