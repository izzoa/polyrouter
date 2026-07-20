ALTER TABLE "request_log" ADD COLUMN "routing_header_name" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "routing_header_value" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_routing_header_pair" CHECK ("request_log"."routing_header_value" IS NULL OR "request_log"."routing_header_name" IS NOT NULL);