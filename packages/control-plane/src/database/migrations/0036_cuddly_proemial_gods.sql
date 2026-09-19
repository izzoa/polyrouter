ALTER TABLE "agent" ADD COLUMN "calibrated_high" double precision;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "calibrated_low" double precision;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "calibrated_anchor_high" double precision;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "calibrated_anchor_low" double precision;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "calibration_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "structural_scope" text;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "membership_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threshold_calibration_event" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_calibration_quad" CHECK (("agent"."calibrated_high" IS NULL) = ("agent"."calibrated_low" IS NULL) AND ("agent"."calibrated_high" IS NULL) = ("agent"."calibrated_anchor_high" IS NULL) AND ("agent"."calibrated_high" IS NULL) = ("agent"."calibrated_anchor_low" IS NULL));--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_calibration_range" CHECK (("agent"."calibrated_high" IS NULL OR ("agent"."calibrated_high" > 0 AND "agent"."calibrated_high" <= 1 AND "agent"."calibrated_low" >= 0 AND "agent"."calibrated_low" < "agent"."calibrated_high")) AND ("agent"."calibrated_anchor_high" IS NULL OR ("agent"."calibrated_anchor_high" > 0 AND "agent"."calibrated_anchor_high" <= 1 AND "agent"."calibrated_anchor_low" >= 0 AND "agent"."calibrated_anchor_low" < "agent"."calibrated_anchor_high")));--> statement-breakpoint
-- add-per-agent-calibration: added NOT VALID, on the rule 0019 set for this table
-- (add-semantic-routing clink r2 Med-3) -- so the boot migration does NOT full-scan
-- a large hot log table under a DDL lock. Every existing row has a freshly-added,
-- all-NULL structural_scope and would pass anyway; NOT VALID still enforces the
-- check on every row inserted or updated from here on. The agent-table checks
-- above stay validated: that table is small and the scan is free.
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_structural_scope_valid" CHECK ("request_log"."structural_scope" IS NULL OR "request_log"."structural_scope" IN ('tenant', 'agent')) NOT VALID;