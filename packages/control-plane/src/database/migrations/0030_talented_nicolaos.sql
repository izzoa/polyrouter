ALTER TABLE "model_price" ADD COLUMN "batch_input_price_per_1m" double precision;--> statement-breakpoint
ALTER TABLE "model_price" ADD COLUMN "batch_output_price_per_1m" double precision;--> statement-breakpoint
ALTER TABLE "model_price" ADD CONSTRAINT "model_price_batch_pair" CHECK (("model_price"."batch_input_price_per_1m" IS NULL) = ("model_price"."batch_output_price_per_1m" IS NULL));--> statement-breakpoint
ALTER TABLE "model_price" ADD CONSTRAINT "model_price_batch_nonneg" CHECK (("model_price"."batch_input_price_per_1m" IS NULL OR "model_price"."batch_input_price_per_1m" >= 0)
        AND ("model_price"."batch_output_price_per_1m" IS NULL OR "model_price"."batch_output_price_per_1m" >= 0));