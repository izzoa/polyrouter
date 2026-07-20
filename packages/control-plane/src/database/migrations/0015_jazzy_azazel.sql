CREATE TABLE "pricing_refresh_run" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"added" integer NOT NULL,
	"skipped" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_refresh_run_kind_valid" CHECK ("pricing_refresh_run"."kind" IN ('litellm', 'body', 'bundled')),
	CONSTRAINT "pricing_refresh_run_counts_nonneg" CHECK ("pricing_refresh_run"."added" >= 0 AND "pricing_refresh_run"."skipped" >= 0)
);
--> statement-breakpoint
CREATE INDEX "pricing_refresh_run_kind_created_idx" ON "pricing_refresh_run" USING btree ("kind","created_at");