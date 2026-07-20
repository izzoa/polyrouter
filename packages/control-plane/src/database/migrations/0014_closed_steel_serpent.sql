CREATE TABLE "threshold_calibration_event" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"trigger" text NOT NULL,
	"old_high" double precision NOT NULL,
	"old_low" double precision NOT NULL,
	"new_high" double precision NOT NULL,
	"new_low" double precision NOT NULL,
	"anchor_high" double precision NOT NULL,
	"anchor_low" double precision NOT NULL,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"edge" text,
	"edge_samples" integer,
	"edge_failures" integer,
	"reason" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threshold_calibration_event_trigger_valid" CHECK ("threshold_calibration_event"."trigger" IN ('calibrator', 'revert', 'rebase')),
	CONSTRAINT "threshold_calibration_event_edge_valid" CHECK ("threshold_calibration_event"."edge" IS NULL OR "threshold_calibration_event"."edge" IN ('high', 'low'))
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "escalation_source" text;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN "structural_epoch" integer;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibration_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibrated_high" double precision;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibrated_low" double precision;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibrated_anchor_high" double precision;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibrated_anchor_low" double precision;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD COLUMN "calibration_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threshold_calibration_event" ADD CONSTRAINT "threshold_calibration_event_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threshold_calibration_event" ADD CONSTRAINT "threshold_calibration_event_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threshold_calibration_event_owner_created_idx" ON "threshold_calibration_event" USING btree ("owner_user_id","created_at");--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_escalation_source_valid" CHECK ("request_log"."escalation_source" IS NULL OR ("request_log"."escalation_source" IN ('quality_gate', 'cheap_error') AND "request_log"."escalated"));--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_calibration_quad" CHECK (("routing_settings"."calibrated_high" IS NULL) = ("routing_settings"."calibrated_low" IS NULL) AND ("routing_settings"."calibrated_high" IS NULL) = ("routing_settings"."calibrated_anchor_high" IS NULL) AND ("routing_settings"."calibrated_high" IS NULL) = ("routing_settings"."calibrated_anchor_low" IS NULL));--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_calibration_range" CHECK ("routing_settings"."calibrated_high" IS NULL OR ("routing_settings"."calibrated_low" >= 0 AND "routing_settings"."calibrated_high" <= 1 AND "routing_settings"."calibrated_low" < "routing_settings"."calibrated_high"));