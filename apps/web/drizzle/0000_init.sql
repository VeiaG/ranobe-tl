CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapter" (
	"id" serial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"idx" integer NOT NULL,
	"source_title" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"title" text,
	"content" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ratio" double precision,
	"error" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration" integer,
	"translated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"chapter" integer,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"chapter" integer NOT NULL,
	"chunk" integer NOT NULL,
	"attempt" integer NOT NULL,
	"prompt" text NOT NULL,
	"output" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"token" text PRIMARY KEY NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"used_by" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "novel" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"original_title" text DEFAULT '' NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"source_language" text DEFAULT 'English' NOT NULL,
	"target_language" text DEFAULT 'Ukrainian' NOT NULL,
	"provider_key_id" integer,
	"model" text DEFAULT '' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_mode" text DEFAULT 'queue' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_key" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"encrypted_key" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "telegram_link" (
	"user_id" text PRIMARY KEY NOT NULL,
	"link_token" text,
	"chat_id" text,
	"username" text,
	"notify_decisions" boolean DEFAULT true NOT NULL,
	"notify_failures" boolean DEFAULT true NOT NULL,
	"notify_finished" boolean DEFAULT true NOT NULL,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_link_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
CREATE TABLE "term" (
	"id" serial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"source" text NOT NULL,
	"source_norm" text NOT NULL,
	"target" text NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"first_chapter" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_change" (
	"id" serial PRIMARY KEY NOT NULL,
	"novel_id" integer NOT NULL,
	"term_id" integer NOT NULL,
	"field" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"chapter" integer,
	"evidence" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_gender" (
	"term_id" integer NOT NULL,
	"from_chapter" integer NOT NULL,
	"gender" text NOT NULL,
	CONSTRAINT "term_gender_term_id_from_chapter_pk" PRIMARY KEY("term_id","from_chapter")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange" ADD CONSTRAINT "exchange_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "novel" ADD CONSTRAINT "novel_provider_key_id_provider_key_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "novel" ADD CONSTRAINT "novel_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_key" ADD CONSTRAINT "provider_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_change" ADD CONSTRAINT "term_change_novel_id_novel_id_fk" FOREIGN KEY ("novel_id") REFERENCES "public"."novel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_change" ADD CONSTRAINT "term_change_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_change" ADD CONSTRAINT "term_change_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_gender" ADD CONSTRAINT "term_gender_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chapter_novel_idx" ON "chapter" USING btree ("novel_id","idx");--> statement-breakpoint
CREATE INDEX "chapter_novel_status" ON "chapter" USING btree ("novel_id","status");--> statement-breakpoint
CREATE INDEX "event_novel_id" ON "event" USING btree ("novel_id","id");--> statement-breakpoint
CREATE INDEX "exchange_novel_chapter" ON "exchange" USING btree ("novel_id","chapter");--> statement-breakpoint
CREATE UNIQUE INDEX "term_novel_norm" ON "term" USING btree ("novel_id","source_norm");--> statement-breakpoint
CREATE INDEX "term_change_novel_status" ON "term_change" USING btree ("novel_id","status");--> statement-breakpoint
CREATE INDEX "term_change_term" ON "term_change" USING btree ("term_id");