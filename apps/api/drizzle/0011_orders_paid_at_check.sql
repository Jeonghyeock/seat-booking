-- expand → contract 4(DESIGN 6.7). NOT VALID라 옛 행을 훑지 않고 새로 쓰는 행만 검사한다. drizzle-kit이 낸 문장에 NOT VALID를 붙였다.
-- ACCESS EXCLUSIVE지만 훑지 않아 짧다. 옛 paid 주문을 채우는 명령(ops:backfill-paid-at)은 이것과 0012 사이에 돌린다.
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_at_set" CHECK ("orders"."status" <> 'paid' or "orders"."paid_at" is not null) NOT VALID;
