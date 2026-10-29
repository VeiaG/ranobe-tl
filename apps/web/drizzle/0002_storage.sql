CREATE TABLE "instance_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter" ADD COLUMN "storage_hash" text;--> statement-breakpoint
ALTER TABLE "chapter" ADD COLUMN "storage_source_hash" text;--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "storage_folder" text;--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "storage_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "novel" ADD COLUMN "storage_meta_hash" text;