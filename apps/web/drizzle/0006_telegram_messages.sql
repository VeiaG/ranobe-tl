CREATE TABLE "telegram_message" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"term_id" integer NOT NULL,
	"field" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter" ADD COLUMN "draft" jsonb;--> statement-breakpoint
CREATE INDEX "telegram_message_term" ON "telegram_message" USING btree ("term_id","field");