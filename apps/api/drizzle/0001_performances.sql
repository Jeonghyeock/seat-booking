CREATE TABLE "performance_grades" (
	"performance_id" bigint NOT NULL,
	"grade" text NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "performance_grades_performance_id_grade_pk" PRIMARY KEY("performance_id","grade"),
	CONSTRAINT "performance_grades_price_not_negative" CHECK ("performance_grades"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "performance_seats" (
	"performance_id" bigint NOT NULL,
	"seat_id" bigint NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	CONSTRAINT "performance_seats_performance_id_seat_id_pk" PRIMARY KEY("performance_id","seat_id"),
	CONSTRAINT "performance_seats_status_valid" CHECK ("performance_seats"."status" in ('available', 'held', 'sold'))
);
--> statement-breakpoint
CREATE TABLE "performances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "performances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" bigint NOT NULL,
	"venue_id" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"sales_open_at" timestamp with time zone NOT NULL,
	CONSTRAINT "performances_sales_before_start" CHECK ("performances"."sales_open_at" < "performances"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performance_grades" ADD CONSTRAINT "performance_grades_performance_id_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."performances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_seats" ADD CONSTRAINT "performance_seats_performance_id_performances_id_fk" FOREIGN KEY ("performance_id") REFERENCES "public"."performances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_seats" ADD CONSTRAINT "performance_seats_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performances" ADD CONSTRAINT "performances_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performances" ADD CONSTRAINT "performances_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;