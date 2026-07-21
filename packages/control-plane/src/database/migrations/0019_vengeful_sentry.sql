ALTER TABLE "request_log" ADD COLUMN "semantic_band" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "semantic_score" double precision;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "semantic_source" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "semantic_revision" text;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "semantic_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- add-semantic-routing High-2: backfill the new preference from the existing
-- structural intent BEFORE the semantic⇒structural check is added, so a stored
-- full opt-out (structural_enabled=false) stays a full opt-out rather than
-- violating the constraint under the column's `true` default.
UPDATE "routing_settings" SET "semantic_enabled" = "structural_enabled";--> statement-breakpoint
-- add-semantic-routing (clink r2 Med-3): the four request_log checks are added
-- NOT VALID so the boot migration does NOT full-scan a large hot log table four
-- times under a DDL lock. Every existing row has all-NULL semantic columns
-- (freshly added) and would pass anyway; NOT VALID still enforces the checks
-- for every new/updated row from this point on. Validation of the historical
-- rows can be done later out-of-band (`VALIDATE CONSTRAINT`) if ever desired.
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_semantic_quad" CHECK (("request_log"."semantic_band" IS NULL) = ("request_log"."semantic_score" IS NULL) AND ("request_log"."semantic_band" IS NULL) = ("request_log"."semantic_source" IS NULL) AND ("request_log"."semantic_band" IS NULL) = ("request_log"."semantic_revision" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_semantic_band_valid" CHECK ("request_log"."semantic_band" IS NULL OR "request_log"."semantic_band" IN ('high', 'low', 'ambiguous')) NOT VALID;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_semantic_source_valid" CHECK ("request_log"."semantic_source" IS NULL OR "request_log"."semantic_source" IN ('bundled', 'learned')) NOT VALID;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_semantic_score_range" CHECK ("request_log"."semantic_score" IS NULL OR ("request_log"."semantic_score" >= -2 AND "request_log"."semantic_score" <= 2)) NOT VALID;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_semantic_implies_structural" CHECK (NOT "routing_settings"."semantic_enabled" OR "routing_settings"."structural_enabled");