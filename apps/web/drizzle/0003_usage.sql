CREATE TABLE "usage_record" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"novel_id" integer,
	"novel_title" text DEFAULT '' NOT NULL,
	"chapter" integer,
	"chunk" integer,
	"attempt" integer,
	"key_id" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "provider_key" ADD COLUMN "monthly_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_key_id_provider_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."provider_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_created" ON "usage_record" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_novel" ON "usage_record" USING btree ("novel_id");--> statement-breakpoint
CREATE INDEX "usage_key" ON "usage_record" USING btree ("key_id","created_at");--> statement-breakpoint
-- History before per-request records: one approximate record per translated chapter.
INSERT INTO "usage_record" ("novel_id", "novel_title", "chapter", "key_id", "provider", "model", "input_tokens", "cached_tokens", "output_tokens", "ok", "created_at")
SELECT c."novel_id", n."title", c."idx", n."provider_key_id", coalesce(k."provider", 'unknown'), coalesce(nullif(c."model", ''), nullif(n."model", ''), 'unknown'),
       c."input_tokens", c."cached_tokens", c."output_tokens", c."status" = 'done', coalesce(c."translated_at", c."updated_at")
FROM "chapter" c
JOIN "novel" n ON n."id" = c."novel_id"
LEFT JOIN "provider_key" k ON k."id" = n."provider_key_id"
WHERE c."input_tokens" + c."output_tokens" > 0;
