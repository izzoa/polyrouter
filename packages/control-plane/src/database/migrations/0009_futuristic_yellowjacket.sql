ALTER TABLE "model" ADD COLUMN "listed_input_price_per_1m" double precision;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_output_price_per_1m" double precision;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_is_free" boolean;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_price_captured_at" timestamp with time zone;