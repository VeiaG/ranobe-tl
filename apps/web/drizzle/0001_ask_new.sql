CREATE TABLE "ignored_term" (
	"novel_id" integer NOT NULL,
	"source_norm" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ignored_term_novel_id_source_norm_pk" PRIMARY KEY("novel_id","source_norm")
);
--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "ask_new" jsonb;--> statement-breakpoint
ALTER TABLE "ignored_term" ADD CONSTRAINT "ignored_term_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;