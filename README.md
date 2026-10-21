# seat-booking

공연 좌석 예매 서비스. 예매가 열리는 순간 많은 사람이 같은 좌석을 동시에 눌러도 한 좌석은 한 번만 팔리고, 결제하지 않은 선점은 시간이 지나면 풀리고, 같은 요청이 두 번 와도 한 번만 처리되게 만든다. 백엔드와 PostgreSQL을 직접 운영하는 것이 목적이다.

> 진행 중(0단계). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · Drizzle ORM · PostgreSQL 18 · zod · Vitest · React + Vite(5단계) · k6(6단계)
