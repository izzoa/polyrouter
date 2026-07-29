ALTER TABLE "budget" ADD COLUMN "metering_basis" text DEFAULT 'notional' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_attempt" ADD COLUMN "provider_kind" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "provider_kind" text;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_metering_basis_valid" CHECK ("budget"."metering_basis" IN ('cash', 'notional'));--> statement-breakpoint
ALTER TABLE "request_attempt" ADD CONSTRAINT "request_attempt_provider_kind_known" CHECK ("request_attempt"."provider_kind" IS NULL OR "request_attempt"."provider_kind" IN ('api_key','subscription','custom','local'));--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_provider_kind_known" CHECK ("request_log"."provider_kind" IS NULL OR "request_log"."provider_kind" IN ('api_key','subscription','custom','local'));