CREATE TABLE "request_log" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"agent_id" text,
	"provider_id" text,
	"model_id" text,
	"tier_assigned" text,
	"decision_layer" text NOT NULL,
	"routing_reason" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"input_price_snapshot" double precision,
	"output_price_snapshot" double precision,
	"cache_read_price_snapshot" double precision,
	"cache_write_price_snapshot" double precision,
	"price_version_id" text,
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"cost" double precision,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"quality_signal" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_log_tokens_nonneg" CHECK ("request_log"."input_tokens" >= 0 AND "request_log"."output_tokens" >= 0
        AND ("request_log"."cache_read_tokens" IS NULL OR "request_log"."cache_read_tokens" >= 0)
        AND ("request_log"."cache_write_tokens" IS NULL OR "request_log"."cache_write_tokens" >= 0))
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_log_created_idx" ON "request_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_log_owner_idx" ON "request_log" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "request_log_agent_idx" ON "request_log" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "request_log_provider_idx" ON "request_log" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "request_log_model_idx" ON "request_log" USING btree ("model_id");