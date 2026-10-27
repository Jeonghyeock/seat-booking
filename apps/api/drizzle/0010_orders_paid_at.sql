-- expand → contract 1(DESIGN 6.7 무중단 마이그레이션 예시 2). nullable이고 기본값이 없어 표를 다시 쓰거나 훑지 않는다.
-- ACCESS EXCLUSIVE는 짧지만 오래 쥔 트랜잭션 뒤에서는 잠금 줄을 만들 수 있어, 실행기의 lock_timeout(1초)이 지킨다.
ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;
