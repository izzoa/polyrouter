ALTER TABLE "routing_settings" ADD COLUMN "semantic_learning_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "semantic_learning_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "semantic_learning_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_learning_implies_semantic" CHECK (NOT "routing_settings"."semantic_learning_enabled" OR "routing_settings"."semantic_enabled");