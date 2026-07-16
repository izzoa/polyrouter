CREATE TABLE "routing_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"structural_enabled" boolean NOT NULL,
	"cascade_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_settings_cascade_implies_structural" CHECK (NOT "routing_settings"."cascade_enabled" OR "routing_settings"."structural_enabled")
);
--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_settings_owner_unique" ON "routing_settings" USING btree ("owner_user_id");