ALTER TABLE "model" ADD COLUMN "listed_supports_tools" boolean;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_supports_vision" boolean;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_supports_reasoning" boolean;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_context_window" integer;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "listed_capabilities_captured_at" timestamp with time zone;