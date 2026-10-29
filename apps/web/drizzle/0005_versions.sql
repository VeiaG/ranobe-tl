CREATE TABLE "chapter_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"chapter_id" integer NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"translated_at" timestamp with time zone,
	"replaced_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter_version" ADD CONSTRAINT "chapter_version_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_version_chapter" ON "chapter_version" USING btree ("chapter_id","id");