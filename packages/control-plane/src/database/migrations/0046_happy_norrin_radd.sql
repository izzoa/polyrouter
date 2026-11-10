CREATE TABLE "plan_usage_sample" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"window_key" text NOT NULL,
	"used_percent" numeric(5, 2),
	"reset_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_usage_sample_used_percent_range" CHECK ("plan_usage_sample"."used_percent" IS NULL OR ("plan_usage_sample"."used_percent" >= 0 AND "plan_usage_sample"."used_percent" <= 100))
);
--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "check_plan_usage" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_usage_sample" ADD CONSTRAINT "plan_usage_sample_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_usage_sample_observation_uniq" ON "plan_usage_sample" USING btree ("provider_id","window_key","observed_at");--> statement-breakpoint
CREATE INDEX "plan_usage_sample_provider_observed_idx" ON "plan_usage_sample" USING btree ("provider_id","observed_at");--> statement-breakpoint
CREATE INDEX "plan_usage_sample_observed_idx" ON "plan_usage_sample" USING btree ("observed_at");