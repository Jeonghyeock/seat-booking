# seat-booking

공연 좌석 예매 서비스. 예매가 열리는 순간 많은 사람이 같은 좌석을 동시에 눌러도 한 좌석은 한 번만 팔리고, 결제하지 않은 선점은 시간이 지나면 풀리고, 같은 요청이 두 번 와도 한 번만 처리되게 만든다. 백엔드와 PostgreSQL을 직접 운영하는 것이 목적이다.

> 진행 중(2단계 완료, 다음은 3단계 — 주문, 가짜 결제, 멱등성). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md)

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
npm run db:seed -w @seat-booking/api      # 샘플 공연장·회차로 개발 DB를 다시 채운다
npm test                                  # 템플릿 DB를 복제한 테스트 DB에서 돌고, 끝나면 지운다
npm run dev                               # http://127.0.0.1:3001
```

## API

| 경로 | 내용 |
|---|---|
| `GET /health` | DB에 닿으면 200, 아니면 503 |
| `GET /performances` | 회차 목록(작품, 공연장, 공연 시작, 판매 시작) |
| `GET /performances/:id/seats` | 좌석 지도(구역·열·번호·등급·가격·판매 상태), 없는 회차는 404 |
| `POST /performances/:id/holds` | 좌석 1~4개 선점(5분, 공연 시작을 넘지 않는다). 전부 잡거나 하나도 잡지 않는다. 회차당 1인 4석까지(구매 포함). 판매 기간이 아니거나, 가격 없는 좌석·이미 선점된 좌석이 있거나, 한도를 넘으면 409(이유별 본문) |
| `GET /performances/:id/me` | 이 회차에서 내 유효한 선점(좌석·만료 시각·붙은 주문)과 한도(선점·구매·남은 수), 서버 시각 |
| `POST /holds/:id/orders` | 선점으로 주문(pending)을 만든다. 좌석과 그때의 가격을 복사한다. `Idempotency-Key` 필수(같은 키로 다시 보내면 처음 응답). 선점 만료·이미 있는 주문·가격 없는 좌석은 409 |
| `GET /orders/:id` | 주문(좌석·가격·결제·표·결제 마감·서버 시각). 남의 주문은 404 |

요청과 응답은 `packages/shared`의 zod 스키마로 검증한다.

4단계(인증) 전까지는 `X-User-Id` 헤더로 사용자를 가린다. 인증이 아닌 임시 방식이다.
