# seat-booking

공연 좌석 예매 서비스. 예매가 열리는 순간 많은 사람이 같은 좌석을 동시에 눌러도 한 좌석은 한 번만 팔리고, 결제하지 않은 선점은 시간이 지나면 풀리고, 같은 요청이 두 번 와도 한 번만 처리되게 만든다. 백엔드와 PostgreSQL을 직접 운영하는 것이 목적이다.

> 진행 중(6단계 완료 — 부하 측정과 개선: 병목은 Node 한 스레드, 좌석 지도 JSON을 DB가 만들어 꺾이는 점 초당 250 → 약 1,000건. 다음은 7단계 — 운영). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md) · 부하 측정 결과: [load/RESULTS.md](load/RESULTS.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · Drizzle ORM · PostgreSQL 18 · zod · Vitest · React + Vite(5단계) · k6(6단계)

## 로컬 실행

필요: Node.js 22.22 이상(24.x 권장), PostgreSQL 18.

슈퍼유저가 아닌 role 둘로 접속한다. 슈퍼유저로 psql에 들어가 한 번만 만든다.
- 소유자 `seat_booking`: 표의 주인이다. 마이그레이션·시드와 테스트·E2E·부하 준비가 쓴다. `CREATEDB`는 테스트가 DB를 복제하는 데 쓴다.
- 앱 `seat_booking_app`: 서버가 쓴다. DML만 하고, 권한은 마이그레이션이 준다.
- 마지막 줄은 소유자가 앱 연결이 남은 테스트 DB를 지울 수 있게 한다.

```sql
CREATE ROLE seat_booking LOGIN CREATEDB PASSWORD '비밀번호';
CREATE DATABASE seat_booking OWNER seat_booking;
CREATE ROLE seat_booking_app LOGIN PASSWORD '다른 비밀번호';
GRANT seat_booking_app TO seat_booking;
```

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`(앱)과 `DATABASE_OWNER_URL`(소유자)의 비밀번호를 채운 뒤 실행한다. 화면을 쓰려면 `.env`에 `APP_ORIGIN=http://localhost:5173`과 `COOKIE_SECURE=false`가 있어야 한다(없으면 화면의 모든 POST가 403이다).

```sh
npm ci
npm run db:migrate -w @seat-booking/api   # 마이그레이션(apps/api/drizzle/)
npm run db:seed -w @seat-booking/api      # 샘플 공연장·회차로 개발 DB를 다시 채운다(날짜는 지금 판매 중이 되게 옮긴다)
npm test                                  # 템플릿 DB를 복제한 테스트 DB에서 돌고, 끝나면 지운다
npm run dev                               # API: http://127.0.0.1:3001
npm run dev -w @seat-booking/web          # 화면: http://localhost:5173 (/api를 API로 넘긴다)
```

E2E(가입 → 선점 → 결제 → 내 예매)는 E2E 전용 DB(`seat_booking_e2e`)와 다른 포트(API 3101, 화면 5174)로 API와 화면을 직접 띄워 돈다. 처음 한 번 브라우저를 받는다.

```sh
npm exec -w @seat-booking/web -- playwright install --only-shell chromium   # 처음 한 번
npm run test:e2e -w @seat-booking/web
```

## API

| 경로 | 내용 |
|---|---|
| `GET /health` | DB에 닿으면 200, 아니면 503 |
| `POST /auth/signup` | 가입(이메일, 비밀번호 8~128자)하고 바로 로그인한다. 이미 있는 이메일은 409 |
| `POST /auth/login` | 로그인. 세션 쿠키(운영 `__Host-sid`, 개발 `sid`)를 굽는다. 틀리면 401(이유를 나누지 않는다) |
| `POST /auth/logout` | 세션을 지우고 쿠키를 지운다 |
| `GET /auth/me` | 지금 로그인한 사용자 |
| `GET /performances` | 회차 목록(작품, 공연장, 공연 시작, 판매 시작·종료) |
| `GET /performances/:id/seats` | 좌석 지도(구역·열·번호·등급·가격·판매 상태)와 서버 시각, 없는 회차는 404 |
| `POST /performances/:id/holds` | 좌석 1~4개 선점(5분, 공연 시작을 넘지 않는다). 전부 잡거나 하나도 잡지 않는다. 회차당 1인 4석까지(구매 포함). 판매 기간(판매 시작~회차별 판매 종료)이 아니거나, 가격 없는 좌석·이미 선점된 좌석이 있거나, 한도를 넘으면 409(이유별 본문). 판매 종료 전에 잡은 선점은 만료까지 주문·결제할 수 있다(결제 요청은 만료 30초 전까지) |
| `GET /performances/:id/me` | 이 회차에서 내 유효한 선점(좌석·만료 시각·붙은 주문)과 한도(선점·구매·남은 수), 서버 시각 |
| `POST /holds/:id/orders` | 선점으로 주문(pending)을 만든다. 좌석과 그때의 가격을 복사한다. `Idempotency-Key` 필수(같은 키로 다시 보내면 처음 응답). 선점 만료·이미 있는 주문·가격 없는 좌석은 409 |
| `GET /orders` | 내 예매: 결제 대기·결제 완료 주문과, 결제 확인 중·환불 중·환불이 끝난 취소 주문, 최근 것부터 100개. 선점이 지난 결제 대기는 시간 초과(취소)로 보인다 |
| `GET /orders/:id` | 주문(좌석·가격·결제·표·결제 마감·서버 시각). 남의 주문은 404 |
| `POST /orders/:id/cancel` | 결제 전 주문을 취소하고 좌석을 푼다. 이미 취소됐으면 같은 결과, 결제가 끝난 주문은 409. 결제 확인 중에 취소하고 그 결제가 성공하면 환불로 간다 |
| `POST /orders/:id/payments` | 가짜 결제사에 결제를 요청한다(202, 결과는 웹훅으로). `Idempotency-Key` 필수. 본문 `scenario`로 상황(성공·실패·중복·순서 뒤바뀜·먼저 옴·유실)을 고른다. 결제할 수 없는 주문·진행 중인 결제는 409, 결제사 장애는 503 |
| `POST /webhooks/fake-pay` | 가짜 결제사의 결과 웹훅. 서명(`X-Fake-Signature`)이 틀리면 401, 맞으면 중복·모르는 웹훅도 200. 성공이면 좌석을 팔고 표를 만든다 |
| `GET /admin/venues`, `GET /admin/shows` | 관리자. 공연장과 등급별 좌석 수, 작품 목록(회차 등록 폼용) |
| `POST /admin/performances` | 관리자. 회차 등록(작품 id 또는 새 제목, 공연장, 공연 시작, 판매 시작·종료, 등급별 가격). 등록할 수 없는 이유(등급, 판매 기간, 지난 판매 종료, 같은 제목 등)는 모아서 422, 같은 공연장·같은 시각이면 409 |
| `GET /admin/performances/:id/sales` | 관리자. 회차 판매 현황(좌석·주문·매출·결제 상태별 수, 한 스냅샷) |
| `GET /admin/payments?status=refund_failed` | 관리자. 환불이 다섯 번 실패한 결제(최근 것부터 100개와 `hasMore`) |
| `POST /admin/payments/:id/retry-refund` | 관리자. 환불 실패 결제를 다시 환불 대기로 돌린다(다음 정리 작업이 환불). 다른 상태면 409 |

요청과 응답은 `packages/shared`의 zod 스키마로 검증한다.

서버는 10초마다 정리 작업을 돈다: 만료된 선점 좌석 풀기, 선점이 끝난 주문 취소, 환불, 웹훅을 잃은 결제 대사(결제사에 다시 묻기), 24시간 지난 멱등 키 지우기.

선점·주문·결제·취소와 내 선점 조회는 로그인한 사용자만 부를 수 있다. 사용자는 세션 쿠키로 가린다(DESIGN 6.3).

`/admin/*`은 관리자만 부른다(로그인하지 않았으면 401, 손님이면 403). 관리자는 가입한 계정을 명령으로 올린다. 이메일 확인이 없으니 명령이 보여 주는 가입 시각으로 내가 가입한 계정인지 확인한다. 올린 사용자는 다시 로그인해야 한다.

```sh
npm run admin:promote -w @seat-booking/api -- you@example.com
```

상태를 바꾸는 요청(POST)에는 `X-Requested-With: seat-booking` 헤더가 있어야 한다(CSRF). 브라우저가 Origin을 보내면 `APP_ORIGIN`에 있어야 한다. 손으로 부를 때는 이 헤더와 로그인 응답의 쿠키를 붙인다. 가입은 IP당, 로그인은 IP+이메일당 분당 10회까지다(로그인은 IP 하나로도 분당 100회). 리버스 프록시 뒤에서 띄우면 `TRUST_PROXY`에 프록시 주소를 적어야 IP가 맞다.
