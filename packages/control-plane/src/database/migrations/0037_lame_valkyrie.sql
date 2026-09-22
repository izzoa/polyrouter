ALTER TABLE "model_price" ALTER COLUMN "supports_tools" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "model_price" ALTER COLUMN "supports_tools" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_price" ALTER COLUMN "supports_vision" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "model_price" ALTER COLUMN "supports_vision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_price" ALTER COLUMN "supports_reasoning" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "model_price" ALTER COLUMN "supports_reasoning" DROP NOT NULL;