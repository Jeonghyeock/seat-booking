CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT date_trunc('milliseconds', clock_timestamp()) NOT NULL,
	"user_id" bigint NOT NULL,
	"event_name" text NOT NULL,
	"properties" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"parked_at" timestamp with time zone,
	"park_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_events_name_valid" CHECK ("outbox_events"."event_name" in ('seats_held', 'order_created', 'payment_succeeded')),
	CONSTRAINT "outbox_events_sent_or_parked" CHECK ("outbox_events"."sent_at" is null or "outbox_events"."parked_at" is null),
	CONSTRAINT "outbox_events_park_reason_with_parked" CHECK (("outbox_events"."parked_at" is null) = ("outbox_events"."park_reason" is null))
);
--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."sent_at" is null and "outbox_events"."parked_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_sent_idx" ON "outbox_events" USING btree ("sent_at") WHERE "outbox_events"."sent_at" is not null;