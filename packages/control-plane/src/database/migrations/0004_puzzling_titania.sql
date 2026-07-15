CREATE TABLE "request_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"request_log_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"attempt_index" integer NOT NULL,
	"tier_key" text,
	"provider_id" text,
	"model_id" text,
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
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_attempt_tokens_nonneg" CHECK ("request_attempt"."input_tokens" >= 0 AND "request_attempt"."output_tokens" >= 0
        AND ("request_attempt"."cache_read_tokens" IS NULL OR "request_attempt"."cache_read_tokens" >= 0)
        AND ("request_attempt"."cache_write_tokens" IS NULL OR "request_attempt"."cache_write_tokens" >= 0))
);
--> statement-breakpoint
ALTER TABLE "request_attempt" ADD CONSTRAINT "request_attempt_request_log_id_request_log_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempt" ADD CONSTRAINT "request_attempt_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempt" ADD CONSTRAINT "request_attempt_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_attempt_request_idx" ON "request_attempt" USING btree ("request_log_id");--> statement-breakpoint
CREATE INDEX "request_attempt_owner_idx" ON "request_attempt" USING btree ("owner_user_id");