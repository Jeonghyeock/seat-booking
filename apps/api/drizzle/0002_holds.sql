CREATE TABLE "holds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "holds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"performance_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "performance_seats" ADD COLUMN "hold_id" bigint;--> statement-breakpoint
ALTER TABLE "performance_seats" ADD COLUMN "hold_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_performance_id_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."performances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holds_user_performance_idx" ON "holds" USING btree ("user_id","performance_id");--> statement-breakpoint
ALTER TABLE "performance_seats" ADD CONSTRAINT "performance_seats_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performance_seats_hold_id_idx" ON "performance_seats" USING btree ("hold_id");--> statement-breakpoint
ALTER TABLE "performance_seats" ADD CONSTRAINT "performance_seats_hold_matches_status" CHECK (("performance_seats"."status" = 'available') = ("performance_seats"."hold_id" is null));--> statement-breakpoint
ALTER TABLE "performance_seats" ADD CONSTRAINT "performance_seats_hold_fields_together" CHECK (("performance_seats"."hold_id" is null) = ("performance_seats"."hold_expires_at" is null));