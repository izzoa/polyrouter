ALTER TABLE "provider" ADD COLUMN "key_preset" text;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_key_preset_exclusive" CHECK ("provider"."key_preset" IS NULL OR "provider"."oauth_preset" IS NULL);--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_key_preset_subscription" CHECK ("provider"."key_preset" IS NULL OR "provider"."kind" = 'subscription');