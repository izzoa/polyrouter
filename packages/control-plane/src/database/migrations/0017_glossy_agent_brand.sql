CREATE TABLE "body_capture_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"mode" text DEFAULT 'off' NOT NULL,
	"retention_days" integer DEFAULT 30,
	"capture_epoch" integer DEFAULT 0 NOT NULL,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"last_purge_at" timestamp with time zone,
	"last_purge_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "body_capture_mode_valid" CHECK ("body_capture_settings"."mode" IN ('off', 'errors_only', 'all')),
	CONSTRAINT "body_capture_retention_valid" CHECK ("body_capture_settings"."retention_days" IS NULL OR ("body_capture_settings"."retention_days" >= 1 AND "body_capture_settings"."retention_days" <= 3650)),
	CONSTRAINT "body_capture_counters_nonneg" CHECK ("body_capture_settings"."capture_epoch" >= 0 AND "body_capture_settings"."dropped_count" >= 0 AND "body_capture_settings"."last_purge_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_body" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"request_log_id" text NOT NULL,
	"direction" text NOT NULL,
	"content_encrypted" text NOT NULL,
	"bytes" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_body_direction_valid" CHECK ("request_body"."direction" IN ('request', 'response')),
	CONSTRAINT "request_body_bytes_nonneg" CHECK ("request_body"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_body_tombstone" (
	"request_log_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "body_capture_override" text;--> statement-breakpoint
ALTER TABLE "body_capture_settings" ADD CONSTRAINT "body_capture_settings_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_capture_settings" ADD CONSTRAINT "body_capture_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body" ADD CONSTRAINT "request_body_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body" ADD CONSTRAINT "request_body_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body" ADD CONSTRAINT "request_body_request_log_id_request_log_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body_tombstone" ADD CONSTRAINT "request_body_tombstone_request_log_id_request_log_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body_tombstone" ADD CONSTRAINT "request_body_tombstone_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_body_tombstone" ADD CONSTRAINT "request_body_tombstone_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "body_capture_settings_owner_unique" ON "body_capture_settings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_body_request_direction_unique" ON "request_body" USING btree ("request_log_id","direction");--> statement-breakpoint
CREATE INDEX "request_body_owner_created_idx" ON "request_body" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "request_body_tombstone_owner_idx" ON "request_body_tombstone" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_body_capture_override_valid" CHECK ("agent"."body_capture_override" IS NULL OR "agent"."body_capture_override" IN ('always', 'never'));