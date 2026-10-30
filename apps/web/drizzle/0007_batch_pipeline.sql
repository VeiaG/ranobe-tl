CREATE TABLE "batch_job" (
	"id" serial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"key_id" integer,
	"model" text NOT NULL,
	"chapter_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requests" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"counts" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_advice" (
	"novel_id" integer NOT NULL,
	"group_key" text NOT NULL,
	"advice" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_advice_novel_id_group_key_pk" PRIMARY KEY("novel_id","group_key")
);
--> statement-breakpoint
CREATE TABLE "term_candidate" (
	"id" serial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"chapter" integer NOT NULL,
	"source" text NOT NULL,
	"group_key" text NOT NULL,
	"target" text NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"gender" text,
	"note" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chapter" ADD COLUMN "batch_state" jsonb;--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "pipeline" text DEFAULT 'classic' NOT NULL;--> statement-breakpoint
ALTER TABLE "batch_job" ADD CONSTRAINT "batch_job_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_job" ADD CONSTRAINT "batch_job_key_id_provider_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."provider_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_advice" ADD CONSTRAINT "term_advice_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_candidate" ADD CONSTRAINT "term_candidate_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_job_novel" ON "batch_job" USING btree ("novel_id","status");--> statement-breakpoint
CREATE INDEX "term_candidate_group" ON "term_candidate" USING btree ("novel_id","group_key");--> statement-breakpoint
CREATE INDEX "term_candidate_status" ON "term_candidate" USING btree ("novel_id","status");--> statement-breakpoint
CREATE INDEX "term_candidate_chapter" ON "term_candidate" USING btree ("novel_id","chapter");