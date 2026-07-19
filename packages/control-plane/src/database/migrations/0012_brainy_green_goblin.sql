ALTER TABLE "request_log" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "error_status" integer;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "error_request_id" text;