CREATE TABLE "idempotency_keys" (
	"user_id" bigint NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"owner_token" uuid NOT NULL,
	"response_code" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_route_key_pk" PRIMARY KEY("user_id","route","key"),
	CONSTRAINT "idempotency_keys_status_valid" CHECK ("idempotency_keys"."status" in ('processing', 'done')),
	CONSTRAINT "idempotency_keys_key_length" CHECK (char_length("idempotency_keys"."key") between 1 and 255),
	CONSTRAINT "idempotency_keys_response_matches_status" CHECK (("idempotency_keys"."status" = 'done') = ("idempotency_keys"."response_code" is not null)),
	CONSTRAINT "idempotency_keys_response_fields_together" CHECK (("idempotency_keys"."response_code" is null) = ("idempotency_keys"."response_body" is null))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"order_id" bigint NOT NULL,
	"seat_id" bigint NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "order_items_order_id_seat_id_pk" PRIMARY KEY("order_id","seat_id"),
	CONSTRAINT "order_items_price_not_negative" CHECK ("order_items"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"hold_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" integer NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_hold_id_unique" UNIQUE("hold_id"),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" in ('pending', 'paid', 'cancelled')),
	CONSTRAINT "orders_amount_not_negative" CHECK ("orders"."amount" >= 0),
	CONSTRAINT "orders_cancel_reason_valid" CHECK ("orders"."cancel_reason" in ('user', 'expired')),
	CONSTRAINT "orders_cancel_reason_matches_status" CHECK (("orders"."status" = 'cancelled') = ("orders"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_webhooks" (
	"event_id" text PRIMARY KEY NOT NULL,
	"payment_id" bigint,
	"type" text NOT NULL,
	"result" text DEFAULT 'received' NOT NULL,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhooks_result_valid" CHECK ("payment_webhooks"."result" in ('received', 'processed', 'ignored', 'unmatched'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"refund_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_order_idempotency_key_unique" UNIQUE("order_id","idempotency_key"),
	CONSTRAINT "payments_status_valid" CHECK ("payments"."status" in ('requested', 'succeeded', 'failed', 'refund_pending', 'refunded', 'refund_failed')),
	CONSTRAINT "payments_amount_not_negative" CHECK ("payments"."amount" >= 0),
	CONSTRAINT "payments_refund_attempts_not_negative" CHECK ("payments"."refund_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"performance_id" bigint NOT NULL,
	"seat_id" bigint NOT NULL,
	"status" text DEFAULT 'valid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_status_valid" CHECK ("tickets"."status" in ('valid', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_performance_seat_fk" FOREIGN KEY ("performance_id","seat_id") REFERENCES "public"."performance_seats"("performance_id","seat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_item_fk" FOREIGN KEY ("order_id","seat_id") REFERENCES "public"."order_items"("order_id","seat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_pending_hold_idx" ON "orders" USING btree ("hold_id") WHERE "orders"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_unique" ON "payments" USING btree ("provider_ref") WHERE "payments"."provider_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_requested_per_order" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_succeeded_per_order" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "payments_order_created_idx" ON "payments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_requested_created_idx" ON "payments" USING btree ("created_at") WHERE "payments"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "payments_refund_pending_created_idx" ON "payments" USING btree ("created_at") WHERE "payments"."status" = 'refund_pending';--> statement-breakpoint
CREATE INDEX "payments_refund_failed_updated_idx" ON "payments" USING btree ("updated_at") WHERE "payments"."status" = 'refund_failed';--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_one_valid_per_seat" ON "tickets" USING btree ("performance_id","seat_id") WHERE "tickets"."status" = 'valid';--> statement-breakpoint
CREATE INDEX "tickets_order_idx" ON "tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "performance_seats_held_expiry_idx" ON "performance_seats" USING btree ("hold_expires_at") WHERE "performance_seats"."status" = 'held';