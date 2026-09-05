CREATE TABLE "batch_job" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"agent_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"tier_assigned" text,
	"upstream_batch_id" text,
	"endpoint" text NOT NULL,
	"protocol" text NOT NULL,
	"status" text NOT NULL,
	"item_count" integer NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"estimated_input_tokens" integer NOT NULL,
	"price_mode" text NOT NULL,
	"input_price_snapshot" double precision,
	"output_price_snapshot" double precision,
	"cache_read_price_snapshot" double precision,
	"cache_write_price_snapshot" double precision,
	"price_version_id" text,
	"price_source" text,
	"reserved_ceiling_micros" bigint,
	"settled_cost_micros" bigint,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"completion_window_ms" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"stalled_since" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"results_expire_at" timestamp with time zone,
	"error_kind" text,
	CONSTRAINT "batch_job_status_valid" CHECK ("batch_job"."status" IN ('submitting', 'submission_unknown', 'validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')),
	CONSTRAINT "batch_job_endpoint_valid" CHECK ("batch_job"."endpoint" IN ('/v1/chat/completions', '/v1/messages')),
	CONSTRAINT "batch_job_protocol_valid" CHECK ("batch_job"."protocol" IN ('openai_compatible', 'anthropic_compatible', 'openai_responses')),
	CONSTRAINT "batch_job_item_count_positive" CHECK ("batch_job"."item_count" > 0),
	CONSTRAINT "batch_job_counts_bounded" CHECK ("batch_job"."completed_count" >= 0 AND "batch_job"."failed_count" >= 0 AND "batch_job"."completed_count" + "batch_job"."failed_count" <= "batch_job"."item_count"),
	CONSTRAINT "batch_job_estimated_tokens_nonneg" CHECK ("batch_job"."estimated_input_tokens" >= 0),
	CONSTRAINT "batch_job_price_mode_valid" CHECK ("batch_job"."price_mode" IN ('sync', 'batch')),
	CONSTRAINT "batch_job_price_pair" CHECK (("batch_job"."input_price_snapshot" IS NULL) = ("batch_job"."output_price_snapshot" IS NULL) AND ("batch_job"."input_price_snapshot" IS NULL) = ("batch_job"."price_source" IS NULL)),
	CONSTRAINT "batch_job_price_source_valid" CHECK ("batch_job"."price_source" IS NULL OR "batch_job"."price_source" IN ('bundled', 'refresh', 'manual', 'native_family', 'listed')),
	CONSTRAINT "batch_job_reserved_nonneg" CHECK ("batch_job"."reserved_ceiling_micros" IS NULL OR "batch_job"."reserved_ceiling_micros" >= 0),
	CONSTRAINT "batch_job_settled_nonneg" CHECK ("batch_job"."settled_cost_micros" IS NULL OR "batch_job"."settled_cost_micros" >= 0),
	CONSTRAINT "batch_job_completion_window_positive" CHECK ("batch_job"."completion_window_ms" > 0),
	CONSTRAINT "batch_job_error_kind_valid" CHECK ("batch_job"."error_kind" IS NULL OR "batch_job"."error_kind" IN ('auth', 'permission', 'rate_limit', 'unavailable', 'bad_request', 'unknown_model', 'insufficient_funds', 'content_policy', 'policy_block', 'upstream_rejected', 'credential', 'submit_lost', 'submit_unresolved', 'upstream_status_unknown', 'provider_missing')),
	CONSTRAINT "batch_job_terminal_at_pair" CHECK (("batch_job"."terminal_at" IS NULL) = ("batch_job"."status" NOT IN ('completed', 'failed', 'expired', 'cancelled')))
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "price_mode" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "batch_job" ADD CONSTRAINT "batch_job_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_job" ADD CONSTRAINT "batch_job_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_job_owner_idx" ON "batch_job" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "batch_job_owner_submitted_idx" ON "batch_job" USING btree ("owner_user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "batch_job_active_idx" ON "batch_job" USING btree ("updated_at") WHERE "batch_job"."status" NOT IN ('completed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE INDEX "request_log_batch_idx" ON "request_log" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_price_mode_valid" CHECK ("request_log"."price_mode" IS NULL OR "request_log"."price_mode" IN ('sync', 'batch'));--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_batch_price_mode_compat" CHECK ("request_log"."price_mode" IS DISTINCT FROM 'batch' OR "request_log"."batch_id" IS NOT NULL);