ALTER TABLE "performances" DROP CONSTRAINT "performances_sales_before_start";--> statement-breakpoint
-- 생성된 SQL은 NOT NULL 열을 바로 더해 행이 있는 DB에서 실패한다. 비워 두고 채운 뒤 NOT NULL로 바꾼다(스냅샷은 생성된 그대로).
-- 이미 있는 회차는 공연 3시간 전에 닫는다. 판매 시작이 그보다 늦으면 공연 시작에 닫는다(옛 CHECK가 판매 시작 < 공연 시작을 지켰다).
ALTER TABLE "performances" ADD COLUMN "sales_close_at" timestamp with time zone;--> statement-breakpoint
UPDATE "performances"
   SET "sales_close_at" = CASE WHEN "starts_at" - interval '3 hours' > "sales_open_at" THEN "starts_at" - interval '3 hours'
                               ELSE "starts_at" END;--> statement-breakpoint
ALTER TABLE "performances" ALTER COLUMN "sales_close_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "performances" ADD CONSTRAINT "performances_sales_window_valid" CHECK ("performances"."sales_open_at" < "performances"."sales_close_at" and "performances"."sales_close_at" <= "performances"."starts_at");
