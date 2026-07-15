CREATE TABLE "model_price" (
	"id" text PRIMARY KEY NOT NULL,
	"model_key" text NOT NULL,
	"input_price_per_1m" double precision NOT NULL,
	"output_price_per_1m" double precision NOT NULL,
	"cache_read_price_per_1m" double precision,
	"cache_write_price_per_1m" double precision,
	"context_window" integer,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"supports_reasoning" boolean DEFAULT false NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_price_nonneg" CHECK ("model_price"."input_price_per_1m" >= 0 AND "model_price"."output_price_per_1m" >= 0
        AND ("model_price"."cache_read_price_per_1m" IS NULL OR "model_price"."cache_read_price_per_1m" >= 0)
        AND ("model_price"."cache_write_price_per_1m" IS NULL OR "model_price"."cache_write_price_per_1m" >= 0)),
	CONSTRAINT "model_price_free_zero" CHECK (NOT "model_price"."is_free" OR ("model_price"."input_price_per_1m" = 0 AND "model_price"."output_price_per_1m" = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_price_key_valid_from_unique" ON "model_price" USING btree ("model_key","valid_from");