# seat-booking

공연 좌석 예매 서비스. 예매가 열리는 순간 많은 사람이 같은 좌석을 동시에 눌러도 한 좌석은 한 번만 팔리고, 결제하지 않은 선점은 시간이 지나면 풀리고, 같은 요청이 두 번 와도 한 번만 처리되게 만든다. 백엔드와 PostgreSQL을 직접 운영하는 것이 목적이다.

> 진행 중(0단계). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · Drizzle ORM · PostgreSQL 18 · zod · Vitest · React + Vite(5단계) · k6(6단계)

## 로컬 실행

필요: Node.js 22.12 이상, PostgreSQL 18.

앱은 슈퍼유저가 아니라 전용 role로 접속한다. 슈퍼유저로 psql에 들어가 한 번만 만든다. `CREATEDB`는 테스트가 DB를 복제하는 데 쓴다.

```sql
CREATE ROLE seat_booking LOGIN CREATEDB PASSWORD '비밀번호';
CREATE DATABASE seat_booking OWNER seat_booking;
```

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`의 비밀번호를 채운 뒤 실행한다.

```sh
npm ci
npm run db:migrate -w @seat-booking/api   # 마이그레이션(apps/api/drizzle/)
npm test                                  # 템플릿 DB를 복제한 테스트 DB에서 돌고, 끝나면 지운다
npm run dev                               # http://127.0.0.1:3001/health
```
