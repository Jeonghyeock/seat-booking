-- 앱 role(seat_booking_app)은 DML만 한다(DESIGN 6.7 권한, 10장 92). role은 클러스터에 하나라 슈퍼유저가 먼저 만든다(README).
-- 시퀀스 권한은 주지 않는다. 모든 id가 identity 열이고, identity 열 INSERT는 시퀀스 권한을 보지 않는다.
GRANT USAGE ON SCHEMA public TO seat_booking_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO seat_booking_app;
--> statement-breakpoint
-- 이 마이그레이션을 돌린 role(소유자)이 앞으로 public에 만드는 표에도 같은 권한이 붙는다.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seat_booking_app;
