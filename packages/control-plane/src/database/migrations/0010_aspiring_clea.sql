ALTER TABLE "provider" ADD COLUMN "oauth_preset" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "credential_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "credential_error" text;