-- expand → contract 4(DESIGN 6.7, 배포 2). 배포 1(결제 확정 때 paid_at을 씀)이 모든 서버에 나가고 다시 채우기를 돌린 뒤에 적용한다.
-- 먼저 빈 옛 paid 주문이 있는지 본다. 있으면 안내하며 실패하고, 이 마이그레이션이 통째로 되돌아가 0012도 돌지 않는다.
-- 이 확인은 표를 훑지만 ACCESS SHARE라 쓰기를 막지 않는다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "status" = 'paid' AND "paid_at" IS NULL) THEN
    RAISE EXCEPTION 'paid_at이 빈 paid 주문이 있습니다. 먼저 npm run ops:backfill-paid-at -w @seat-booking/api 를 돌립니다'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
-- NOT VALID라 옛 행을 훑지 않고 새로 쓰는 행만 검사한다. drizzle-kit이 낸 문장에 NOT VALID를 붙였다.
-- ACCESS EXCLUSIVE지만 훑지 않아 짧다.
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_at_set" CHECK ("orders"."status" <> 'paid' or "orders"."paid_at" is not null) NOT VALID;
