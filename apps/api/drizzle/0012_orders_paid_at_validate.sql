-- expand → contract 5(DESIGN 6.7). 옛 행을 검사한다. SHARE UPDATE EXCLUSIVE라 읽기·쓰기를 막지 않는다.
-- 옛 paid 주문이 비어 있으면 23514로 실패한다. 그때는 npm run ops:backfill-paid-at -w @seat-booking/api 뒤에 다시 돌린다.
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_paid_at_set";
