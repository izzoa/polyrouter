CREATE TABLE "budget" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"agent_id" text,
	"window" text NOT NULL,
	"action" text NOT NULL,
	"amount" double precision NOT NULL,
	"notify_channel_ids" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_amount_range" CHECK ("budget"."amount" > 0 AND "budget"."amount" <= 1000000000),
	CONSTRAINT "budget_scope_valid" CHECK ("budget"."scope" IN ('global', 'agent')),
	CONSTRAINT "budget_window_valid" CHECK ("budget"."window" IN ('day', 'week', 'month')),
	CONSTRAINT "budget_action_valid" CHECK ("budget"."action" IN ('alert', 'block')),
	CONSTRAINT "budget_agent_iff_scope" CHECK (("budget"."scope" = 'agent') = ("budget"."agent_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_owner_idx" ON "budget" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "request_attempt_owner_created_idx" ON "request_attempt" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "request_log_owner_created_idx" ON "request_log" USING btree ("owner_user_id","created_at");