CREATE TABLE "semantic_learning_event" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"org_id" text,
	"occurrence_id" text NOT NULL,
	"trigger" text NOT NULL,
	"epoch" integer NOT NULL,
	"generation" integer NOT NULL,
	"high_samples" integer DEFAULT 0 NOT NULL,
	"low_samples" integer DEFAULT 0 NOT NULL,
	"high_drift" double precision,
	"low_drift" double precision,
	"high_similarity" double precision,
	"low_similarity" double precision,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "semantic_learning_event_trigger_valid" CHECK ("semantic_learning_event"."trigger" IN ('apply', 'discard_revision', 'revert')),
	CONSTRAINT "semantic_learning_event_counts_nonneg" CHECK ("semantic_learning_event"."high_samples" >= 0 AND "semantic_learning_event"."low_samples" >= 0),
	CONSTRAINT "semantic_learning_event_drift_finite" CHECK (("semantic_learning_event"."high_drift" IS NULL OR ("semantic_learning_event"."high_drift" >= 0 AND "semantic_learning_event"."high_drift" <= 2)) AND ("semantic_learning_event"."low_drift" IS NULL OR ("semantic_learning_event"."low_drift" >= 0 AND "semantic_learning_event"."low_drift" <= 2)))
);
--> statement-breakpoint
ALTER TABLE "semantic_learning_event" ADD CONSTRAINT "semantic_learning_event_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_learning_event" ADD CONSTRAINT "semantic_learning_event_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_learning_event_occurrence_unique" ON "semantic_learning_event" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "semantic_learning_event_owner_created_idx" ON "semantic_learning_event" USING btree ("owner_user_id","created_at");