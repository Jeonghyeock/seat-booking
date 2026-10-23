-- 같은 공연장·같은 공연 시작의 회차는 하나다(관리자 회차 등록, DESIGN 6.3). 그런 회차가 이미 둘 이상이면 실패한다.
-- 샘플 시드는 회차마다 시각이 달라 그런 행이 없다.
ALTER TABLE "performances" ADD CONSTRAINT "performances_venue_starts_unique" UNIQUE("venue_id","starts_at");