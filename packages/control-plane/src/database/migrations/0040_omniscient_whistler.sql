ALTER TABLE "provider" ADD COLUMN "last_error_kind" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "status_source" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "status_rev" bigint;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "traffic_state" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "traffic_error_kind" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "traffic_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "traffic_seq" bigint;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "traffic_rev" bigint;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "health_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_oauth_sweep_idx" ON "provider" USING btree ("id") WHERE "provider"."oauth_preset" IS NOT NULL;