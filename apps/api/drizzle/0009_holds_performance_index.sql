-- 트랜잭션 밖
-- 쓰기를 막지 않고 인덱스를 만든다(DESIGN 6.7 무중단 마이그레이션 예시 1). drizzle-kit이 낸 CREATE INDEX를 손으로 고쳤다.
-- 실패로 남은 INVALID 인덱스가 있으면 지우고 다시 만든다(IF NOT EXISTS는 INVALID를 건너뛰어 쓰지 않는다).
DROP INDEX CONCURRENTLY IF EXISTS "holds_performance_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "holds_performance_idx" ON "holds" USING btree ("performance_id");
