# 공연 좌석 예매 — 설계 문서

> 상태: 확정(2026-10-21, 10장 권장안 채택). 단계별 결과는 [PROGRESS.md](PROGRESS.md)에 쓴다.

## 1. 목표

인기 공연의 예매가 열리는 순간 많은 사람이 같은 좌석을 동시에 누른다. 이때도 다음을 지키는 예매 서비스를 만든다.

1. 한 좌석은 한 번만 팔린다.
2. 결제하지 않은 선점은 시간이 지나면 풀린다.
3. 같은 요청이 두 번 와도 한 번만 처리된다(결제 재시도, 웹훅 중복).
4. 위 세 가지를 테스트와 부하 측정 **숫자**로 보여 준다.

백엔드와 DB를 직접 운영하는 것이 이 프로젝트의 목적이다. PostgreSQL을 직접 설치해 스키마, 마이그레이션, 권한, 백업을 다룬다. Supabase 같은 BaaS는 쓰지 않는다.

두 번째 프로젝트(이벤트 분석 대시보드)가 이 서비스의 사용자 행동 기록을 받아 퍼널을 그린다. 그 연결은 마지막 단계에서 한다.

### 이력서 주장과 근거

| 쓸 수 있게 될 주장 | 근거(단계) |
|---|---|
| 동시 요청에도 좌석이 두 번 팔리지 않게 했다 | 동시성 테스트, 부하 측정 뒤 SQL로 중복 0 확인(2·6) |
| 결제 재시도와 웹훅 중복에도 한 번만 처리했다 | 멱등성 테스트(3) |
| 서버 세션 인증을 직접 구현했다 | 세션 테이블, 쿠키, CSRF 방어(4) |
| 인덱스와 쿼리를 고쳐 응답 시간을 줄였다 | 고치기 전후 측정표(6) |
| PostgreSQL을 운영했다: 마이그레이션, 권한 분리, 백업·복구 | 운영 문서와 리허설 기록(7) |
| 화면과 API가 같은 스키마 정의를 공유한다 | `packages/shared`의 zod 스키마(1~5) |

구현은 Claude Code와 함께 한다. 단계마다 사용자가 직접 설명할 수 있게 된 뒤 다음으로 간다(8장).

## 2. 하지 않을 것

- **실제 결제 없음.** 같은 서버 안에 가짜 결제 경로를 두고, 지연·중복·실패 웹훅을 일부러 보낸다.
- **Redis, Kafka, 메시지 큐 없음.** PostgreSQL만으로 어디까지 되는지 먼저 잰다. 측정에서 한계가 보일 때만 다시 검토한다.
- 마이크로서비스 없음. API 서버 하나와 DB 하나다.
- **대기열(waiting room)은 v1에서 뺀다.** 6단계 측정을 보고 다시 정한다.
- 배포는 10장에서 정한다(권장: 하지 않음).
- 좌석 배치 편집기 없음. 공연장 좌석 배치는 시드 JSON으로 넣는다.

## 3. 합격 기준

모든 기준은 앱 로그가 아니라 **DB를 직접 조회하는 SQL**로 확인한다.

| # | 상황 | 통과 조건 |
|---|---|---|
| C1 | 좌석 1개에 동시 선점 요청 1,000개 | 성공 정확히 1개, 나머지는 409 |
| C2 | 좌석 N개 공연에 사용자 M명(M ≫ N)이 몰림 | 판매 좌석 ≤ N, 중복 판매 0 |
| C3 | 선점 만료 순간과 결제 확정이 겹침 | 둘 중 하나만 반영된다. 두 순서를 모두 테스트한다 |
| C4 | 같은 `Idempotency-Key`로 결제 요청을 다시 보냄 | 결제 행 1개, 응답은 처음과 같다 |
| C5 | 같은 주문에 취소와 결제 확정이 동시에 옴 | 하나만 성공한다 |
| C6 | 한 사용자가 여러 창에서 동시에 좌석을 선점 | 1인 한도(회차당 4석, 10장 3)를 넘지 않는다 |
| C7 | 부하 중 좌석 지도 조회 | p95를 인덱스 개선 전후로 잰다(숫자) |
| C8 | 백업에서 복구 | 다른 DB로 복구하고 행 수를 대조한 기록 |

## 4. 구조

```
[브라우저: React + Vite]
        │  REST(JSON), 세션 쿠키
[API 서버: Fastify]  ── 가짜 결제 경로 → 웹훅 → 같은 서버
        │  Drizzle + SQL
[PostgreSQL]  ← 만료 정리 작업(같은 프로세스 안 주기 작업)
```

- 언어는 전부 TypeScript다. 요청·응답 스키마는 `packages/shared`의 zod 정의 하나를 API 검증과 화면 타입이 함께 쓴다.
- Fastify를 쓰는 이유: NestJS보다 층이 적어서 트랜잭션과 잠금이 코드에 그대로 보인다.
- Drizzle을 쓰는 이유: SQL에 가깝다. 잠금(`FOR UPDATE`)이나 부분 인덱스처럼 SQL로 써야 하는 부분은 SQL로 쓰고, 마이그레이션도 읽을 수 있는 SQL 파일로 남는다.

## 5. 데이터 모델 (초안)

| 테이블 | 핵심 열 | 비고 |
|---|---|---|
| `users` | email(unique), password_hash, role | role: customer / admin. 2단계에서 id·email만으로 먼저 만들고(선점이 가리킬 사용자), password_hash·role은 4단계에서 더한다 |
| `sessions` | id(무작위 32바이트), user_id, expires_at | 4단계 |
| `venues`, `seats` | 구역·열·번호, 등급 | 시드 JSON |
| `shows` | title | 공연 작품. 1단계에서 더함(회차에 제목을 두면 회차마다 되풀이된다) |
| `performances` | show_id, venue_id, starts_at, sales_open_at | 회차 |
| `performance_grades` | (performance_id, grade) PK, price | 회차별 등급 가격. 1단계에서 더함(가격은 좌석이 아니라 등급마다 정해진다) |
| `performance_seats` | (performance_id, seat_id) PK, status, hold_id, hold_expires_at | 좌석 재고. status: available / held / sold. 빈 좌석에만 hold_id가 없다(팔린 좌석은 어느 선점에서 팔렸는지 남긴다). 만료 시각은 holds와 이 표에 함께 둔다(6.1) |
| `holds` | user_id, performance_id, expires_at | 선점 묶음. 요청 하나로 잡은 좌석들이 같은 hold를 가리킨다 |
| `orders` | user_id, hold_id(unique), status, amount, seat_count, cancel_reason | pending / paid / cancelled. 선점 하나에 주문 하나. amount는 만들 때의 가격 합을 복사하고, seat_count는 결제 확정 때 좌석이 모두 남았는지 견주는 데 쓴다(6.2) |
| `payments` | order_id, provider_ref(unique), status, amount | requested / succeeded / failed / refunded. 결제 시도마다 한 행. 부분 unique `(order_id) WHERE status = 'requested'`(진행 중인 결제는 주문당 하나)와 `(order_id) WHERE status = 'succeeded'` |
| `tickets` | order_id, performance_id, seat_id, status | **부분 unique 인덱스** `(performance_id, seat_id) WHERE status = 'valid'`. 3단계에는 valid만 생긴다(결제 후 취소가 없다, 10장 22) |
| `idempotency_keys` | (user_id, key) PK, request_hash, status, response_code, response_body, created_at, updated_at | processing / done. 24시간 보관(6.2) |
| `outbox_events` | type, payload, created_at, sent_at | 8단계(분석 프로젝트 연결). 그 전에는 만들지 않는다 |

## 6. 핵심 결정

### 6.1 좌석 선점의 동시성 (2단계)

면접에서 가장 많이 물을 부분이라 후보를 모두 적는다.

| 방법 | 동작 | 판단 |
|---|---|---|
| ① 조회 후 수정 | `SELECT status` → 비어 있으면 `UPDATE` | **틀림.** 두 요청이 둘 다 "비어 있음"을 읽고 둘 다 판다. 일부러 실패하는 테스트로 남겨 이 문제를 증명한다 |
| ② `SELECT … FOR UPDATE` | 행을 잠그고 읽은 뒤 수정 | 맞다. 다만 왕복이 두 번이고 잠금을 쥐는 시간이 길다 |
| ③ 조건부 `UPDATE` | `UPDATE performance_seats SET status='held', … WHERE performance_id=$1 AND seat_id=$2 AND (status='available' OR (status='held' AND hold_expires_at < now())) RETURNING seat_id` | **채택.** 한 문장 안에서 확인과 수정을 함께 한다. 두 요청이 겹치면 뒤 요청은 앞 요청이 끝날 때까지 기다린 뒤 바뀐 행으로 조건을 다시 보고, 0행을 받는다(READ COMMITTED에서 PostgreSQL의 동작) |
| ④ DB 불변식 | `tickets`의 부분 unique 인덱스 | ③과 **함께** 둔다. 앱 코드에 버그가 있어도 DB가 중복 판매를 거부한다 |

- 만료를 부분 인덱스 조건에 넣을 수 없는 이유: 인덱스 조건의 함수는 IMMUTABLE이어야 하는데 `now()`는 그렇지 않다. 그래서 만료는 ③의 `WHERE`에서 판단하고, 정리 작업이 만료된 선점을 주기적으로 풀어 좌석 지도의 숫자를 맞춘다. 정리 작업은 `FOR UPDATE SKIP LOCKED`로 몇 행씩 처리한다.
- **여러 좌석을 한 번에 선점한다.** 요청 하나는 1~4석을 전부 잡거나 하나도 잡지 않는다. 한 트랜잭션 안에서 대상 좌석을 좌석 id 순서로 `FOR UPDATE` 잠그고, 같은 문장에서 ③의 조건부 `UPDATE`를 한다. 바뀐 행 수가 요청한 좌석 수보다 적으면 `ROLLBACK`하고 409를 돌려준다.
- **교착을 막는 잠금 순서.** 두 요청이 좌석 1과 3을 서로 반대 순서로 잠그면, 각자 하나를 쥔 채 상대의 것을 기다려 교착(40P01)이 된다. PostgreSQL은 `deadlock_timeout`(기본 1초) 뒤 한쪽을 실패시킨다. 모든 요청이 좌석 id 순서로 잠그면 기다림이 고리를 이루지 않는다. 1인 한도를 지키려고 사용자 단위 잠금을 더하면, 그 잠금은 좌석 잠금보다 **먼저** 잡는다. 순서가 "사용자 → 좌석 id 순" 하나뿐이라 고리가 생기지 않는다.
- **만료 시각을 좌석 재고 행에도 두는 이유.** READ COMMITTED에서 겹친 `UPDATE`는 앞 트랜잭션이 끝날 때까지 기다린 뒤, 고치려는 행의 새 값으로 `WHERE`를 다시 본다. 이때 다른 표는 문장을 시작할 때의 스냅샷으로 본다. 만료 시각이 `holds`에만 있으면 조건이 `holds`를 봐야 하는데, 앞 트랜잭션이 막 넣은 선점은 그 스냅샷에 없다. 조건을 "유효한 선점이 없으면"처럼 쓰면 두 요청이 모두 선점한다. 그래서 만료 판단에 쓰는 값을 같은 행(`hold_expires_at`)에 둔다. 두 곳의 값은 같은 트랜잭션에서 한 번 쓰고 바꾸지 않는다(선점 연장은 없다).
- **만료된 선점은 좌석 지도에서 바로 빈 좌석으로 보인다.** 조회할 때 `hold_expires_at`을 보고 바꿔 보여 준다. 행을 실제로 푸는 정리 작업은 3단계에서 한다(6.2).
- **1인 좌석 한도(C6)는 별개의 동시성 문제다.** 서로 다른 좌석을 동시에 선점하면 ③만으로는 "지금 몇 장 쥐고 있나" 확인이 겹친다. 후보 세 가지를 같은 장면에 넣어 비교했다(`hold-limit.test.ts`). 장면: 이미 2석을 쥔 사용자가 두 창에서 2석씩 더 담는다.

  | 후보 | 결과 | 판단 |
  |---|---|---|
  | 잠금 없음(비교 기준) | 두 창이 모두 "지금 2석"을 보고 통과해 6석이 된다 | 틀림 |
  | 사용자·회차 advisory lock(`pg_advisory_xact_lock`) | 뒤 창은 앞 창이 커밋할 때까지 잠금에서 기다린 뒤 세고 HOLD_LIMIT | **채택.** 표가 필요 없고 회차마다 따로 잠근다. 키는 `hashtextextended('hold:사용자:회차', 0)`. 해시가 겹치면 다른 사용자끼리 기다릴 뿐 결과는 틀리지 않는다 |
  | 사용자 행 잠금(`FOR NO KEY UPDATE`) | advisory lock과 같다 | 맞다. 다만 사용자·회차 행이 따로 없어 사용자 행을 잠그므로, 한 사용자의 다른 회차 선점까지 줄을 선다. `FOR UPDATE`로 잠그면 그 사용자를 가리키는 외래 키 확인(`FOR KEY SHARE`)까지 막는다 |
  | SERIALIZABLE과 재시도 | 두 창 모두 진행하다 한쪽이 직렬화 실패(40001)로 되돌려지고, 다시 세어 HOLD_LIMIT. 어느 쪽이 되돌려질지는 정해져 있지 않다 | 맞다. 잠금 코드가 없는 대신 재시도 루프가 필요하다. 좌석 경쟁도 재시도로 바뀐다: 같은 좌석을 기다린 뒤 조건을 다시 보지 않고 40001을 받는다(테스트로 확인). 술어 잠금은 인덱스 범위를 페이지 단위로 잡아서, 서로 읽고 쓴 범위가 같은 페이지에 걸리면 상관없는 요청끼리도 실패할 수 있다. 같은 장면에서 서로 다른 두 사용자가 다른 좌석을 담게 하면, 이 장면만 돌릴 때 20번 중 20번, 다른 테스트 파일과 함께 돌릴 때 15번 중 11번 한쪽이 40001로 되돌려졌다. 페이지 배치나 실행 계획에 달린 것으로 보여 테스트로 고정하지 않았다 |

  advisory lock은 좌석 잠금보다 먼저 잡는다(위의 잠금 순서). 세는 것은 좌석 재고 행 중 이 사용자의 선점에 묶인 `held`이고 아직 만료되지 않은 것이다. 3단계부터는 팔린 좌석(`sold`)도 센다(10장 18). 팔린 좌석은 선점(`hold_id`)을 남기므로(10장 16) 같은 질의에서 `status = 'sold'`를 더하면 된다.

- **판매 기간.** 선점 트랜잭션 안에서 회차의 `sales_open_at <= now() < starts_at`을 확인하고, 아니면 409 `SALES_CLOSED`다(10장 19). 판매가 열리는 순간에도 앱 서버들의 시계가 아니라 DB 시계 하나로 판단한다.

### 6.2 주문, 가짜 결제, 멱등성 (3단계)

흐름:

```
선점(held) ─주문 생성→ 주문 pending ─결제 요청→ 결제 requested ─웹훅 succeeded→ 결제 확정: 주문 paid, 좌석 sold, 표 valid
                          │                            └─웹훅 failed→ 결제 failed (주문은 pending, 선점이 유효하면 다시 결제)
                          ├─사용자 취소→ 주문 cancelled(user), 좌석 available
                          └─선점 만료(정리 작업)→ 주문 cancelled(expired), 좌석 available
```

**상태 전이.** 모든 전이는 "지금 상태가 이전 상태일 때만" 바꾸는 조건부 `UPDATE`다(`WHERE status = 이전 상태`). 같은 행에 두 전이가 겹치면 하나만 1행을 받는다. 2단계의 좌석 선점과 같은 원리다.

| 표 | 상태 | 전이 |
|---|---|---|
| `orders` | pending, paid, cancelled | pending → paid(결제 확정), pending → cancelled(사용자 취소, 선점 만료). paid·cancelled는 끝 상태 |
| `payments` | requested, succeeded, failed, refunded | requested → succeeded·failed(웹훅), succeeded → refunded(돈은 받았는데 주문을 확정하지 못함) |
| `tickets` | valid | 결제 확정 때 좌석마다 한 장 |

초안의 주문 상태 `refunded`는 결제로 옮겼다. 확정하지 못해 돌려주는 돈은 주문이 아니라 그 결제의 일이고, 결제 후 취소(환불 요청)는 v1에서 하지 않는다(10장 22).

**API.**

| 요청 | 멱등 키 | 하는 일 | 응답 |
|---|---|---|---|
| `POST /holds/:id/orders` | 필수 | 선점이 내 것이고 유효한지, 좌석이 모두 남았는지 확인하고 가격 합을 복사해 주문(pending)을 만든다 | 201 / 409 `HOLD_EXPIRED`·`ORDER_EXISTS`·`PRICE_MISSING` |
| `GET /orders/:id` | - | 주문과 마지막 결제의 상태. 화면이 웹훅 결과를 기다리며 본다 | 200 / 404 |
| `POST /orders/:id/payments` | 필수 | 가짜 결제사에 결제를 만들고(결제 번호 `provider_ref`) 결제 행(requested)을 넣는다. 결과는 웹훅으로 온다 | 202 / 409 `ORDER_NOT_PAYABLE`·`PAYMENT_IN_PROGRESS` |
| `POST /orders/:id/cancel` | 없음 | pending이면 cancelled로 바꾸고 좌석을 푼다. 이미 cancelled면 같은 결과를 돌려준다 | 200 / 409 `ORDER_NOT_CANCELLABLE`(paid) |
| `POST /webhooks/fake-pay` | 결제사 서명 | 결제 결과를 반영한다 | 200(중복·늦은 웹훅도 200) / 401(서명 틀림) |

취소에 멱등 키를 받지 않는 이유: 두 번 와도 두 번째는 0행이라 결과가 같다. 주문 생성과 결제 요청은 두 번 처리되면 행이 하나 더 생긴다(10장 21).

**결제 확정(웹훅 succeeded).** 한 트랜잭션에서 결제 → 주문 → 좌석 순서로 잡는다.

1. `UPDATE payments SET status = 'succeeded' WHERE provider_ref = $1 AND status = 'requested' RETURNING order_id`. 0행이면 이미 처리한 웹훅(중복)이거나 늦게 온 웹훅이다. 아무것도 하지 않고 200을 돌려준다. 결제사는 200을 받을 때까지 다시 보내므로, 무시할 때도 200이어야 한다.
2. `UPDATE orders SET status = 'paid' WHERE id = $2 AND status = 'pending' RETURNING hold_id, seat_count`. 0행이면 그사이 주문이 취소되거나 만료됐다. 결제를 refunded로 바꾸고 커밋한다(가짜 결제사에 환불을 기록한다).
3. 좌석을 2단계와 같이 `seat_id` 순서로 잠그고(`FOR UPDATE`), `status = 'held' AND hold_id = 이 선점 AND hold_expires_at >= now()`인 좌석만 `sold`로 바꾼다. 바뀐 좌석이 `seat_count`보다 적으면(만료돼 정리됐거나 다른 사람이 다시 선점했다) 2를 되돌리고(SAVEPOINT) 주문을 cancelled(expired)로, 결제를 refunded로 바꾼다.
4. 좌석마다 표(valid)를 넣는다. 부분 unique 인덱스가 앱 코드에 버그가 있어도 한 좌석에 유효한 표 두 장을 막는다(6.1의 ④).

**만료 정리 작업.** 같은 프로세스에서 주기적으로 돈다(10초). 테스트에서는 끄고 함수를 직접 부른다. 문장마다 따로 트랜잭션이고, 한 번에 몇백 행씩 처리한다.

1. 좌석 풀기: `status = 'held' AND hold_expires_at < now()`인 좌석을 `FOR UPDATE SKIP LOCKED`로 골라 `available`로 되돌린다(`hold_id`, `hold_expires_at`도 비운다).
2. 주문 취소: 선점이 만료된 pending 주문을 `FOR UPDATE SKIP LOCKED`로 골라 cancelled(expired)로 바꾼다.
3. 24시간 지난 멱등 키를 지운다.

SKIP LOCKED는 다른 트랜잭션이 잠근 행을 기다리지 않고 건너뛴다. 결제 확정이 잡고 있는 좌석은 이번에 건너뛰고, 확정이 끝나면 `sold`라 다음 번에도 대상이 아니다. 확정이 실패해 되돌려졌다면 다음 번에 푼다.

**C3: 만료와 결제 확정이 겹칠 때.** 둘 다 같은 좌석 행을 조건부로 바꾸므로 먼저 잡은 쪽이 이긴다.

- 정리가 먼저: 좌석이 `available`이 된다. 확정의 3에서 0행 → 주문 cancelled(expired), 결제 refunded.
- 확정이 먼저: 좌석이 `sold`가 된다. 정리는 잠긴 행을 건너뛰고, 다음 번에는 `held`가 아니라 대상이 아니다.
- 만료 판단은 둘 다 트랜잭션을 시작한 시각(`now()`)이다. 확정이 만료 직전에 시작했다면, 잠금을 기다리다 만료 뒤에 실행돼도 확정된다. 같은 행을 먼저 잡은 쪽이 이긴다는 규칙은 그대로라, 좌석이 두 번 팔리거나 돈만 받고 좌석이 없는 일은 없다(돈만 받은 경우는 refunded).

**C5: 취소와 결제 확정이 겹칠 때.** 둘 다 `UPDATE orders … WHERE status = 'pending'`이다. 취소가 이기면 확정의 2에서 0행 → 결제 refunded. 확정이 이기면 취소는 409 `ORDER_NOT_CANCELLABLE`.

**잠금 순서.** 2단계의 "사용자 → 좌석 id 순"에 주문과 결제를 더한다: 결제 → 주문 → 좌석(`seat_id` 순). 결제 확정과 취소가 이 순서로 잡는다. 선점은 좌석만 잡으므로 이 순서와 고리를 이루지 않는다. 정리 작업은 SKIP LOCKED라 아무것도 기다리지 않고, 좌석과 주문을 다른 트랜잭션에서 처리해 둘을 함께 쥐지도 않는다.

**멱등성(`Idempotency-Key`).** 주문 생성과 결제 요청에 받는다. 키는 사용자마다 따로다(`(user_id, key)`).

1. 업무를 시작하기 전에 **별도 트랜잭션으로** `INSERT … ON CONFLICT DO NOTHING`(status processing)을 하고 커밋한다. 커밋해 두어야 같은 키로 동시에 온 요청이 이 행을 본다(READ COMMITTED는 커밋된 행만 본다).
2. 업무 트랜잭션의 끝에서 **같은 트랜잭션으로** 응답(상태 코드와 본문)을 저장하고 done으로 바꾼다. 업무가 커밋되면 응답도 저장되고, 되돌려지면 응답도 없다.
3. 1에서 이미 있으면:
   - request_hash가 다르면 422(같은 키를 다른 요청에 썼다).
   - done이면 저장한 응답을 그대로 돌려준다(C4).
   - processing이면 409 `IN_PROGRESS`와 `Retry-After`.
4. 업무가 4xx로 끝나도 응답을 저장한다. 같은 요청을 다시 보내면 같은 답을 받는다. 예외(5xx)로 끝나면 키 행을 지워 다시 보낼 수 있게 한다.
5. 처리 중에 서버가 죽으면 processing 행만 남는다. 업무 트랜잭션은 되돌려졌으므로, `updated_at`이 1분 넘게 지난 processing 행은 조건부 `UPDATE`로 넘겨받아 다시 처리한다. 원래 요청이 아직 살아 있어서 겹치더라도 업무 쪽 제약(선점당 주문 하나, 주문당 진행 중인 결제 하나)이 두 번 처리를 막는다.
6. request_hash는 경로의 id와 본문을 키 순서를 맞춘 JSON으로 만들어 SHA-256으로 잰다. 공백·키 순서만 다른 같은 요청을 다른 요청으로 보지 않는다.

키를 업무와 같은 트랜잭션에 넣는 방법도 있다. 같은 키의 두 번째 요청은 unique 인덱스에서 첫 요청이 끝날 때까지 기다리고, 처리 중 행이 남지 않는다. 대신 중복 요청마다 연결을 쥐고 기다리고, 결제사 호출 같은 바깥 일을 트랜잭션 안에서 해야 한다. 그래서 별도 트랜잭션으로 먼저 넣는다(10장 23).

**가짜 결제사.** 같은 서버 안의 모듈이다.

- 결제 요청 본문의 `scenario`로 상황을 고른다(10장 20). `delayMs`(기본 1000)는 웹훅까지의 지연이다.
  - `success`: succeeded 한 번.
  - `fail`: failed 한 번.
  - `duplicate`: 같은 succeeded를 거의 동시에 두 번.
  - `out_of_order`: succeeded를 먼저 보내고, 그보다 앞서 생긴 processing(중간 상태) 웹훅을 나중에 보낸다. processing은 전이 규칙에 없어 무시된다.
- 웹훅은 앱의 HTTP 경로로 보낸다(개발은 자기 `PORT`로 `fetch`, 테스트는 `app.inject`). 함수를 바로 부르지 않아 서명 확인·검증·응답까지 경로째 시험한다.
- 테스트에서는 타이머를 쓰지 않는다. 쌓인 웹훅을 원하는 순서로 직접 보낸다.
- 웹훅 본문은 `X-Fake-Signature` 헤더(본문의 HMAC-SHA256)로 서명한다. 비밀은 환경 변수이고 테스트는 고정값이다.

주문은 만들 때의 가격 합을 복사해 둔다(`orders.amount`). 나중에 `performance_grades`의 가격이 바뀌어도 이미 낸 금액은 그대로다.

**PR 순서.** 스키마(표 네 개와 제약, 공유 zod 스키마) → 판매 기간·팔린 좌석 한도(2단계에서 미룬 것) → 주문 생성과 멱등 키 → 가짜 결제·웹훅·결제 확정(C4) → 만료 정리(C3) → 취소(C5) → 기록.

### 6.3 인증 (4단계)

bus-review에서는 Supabase가 대신 해 줬던 부분을 직접 만든다.

- 이메일과 비밀번호를 받고, 비밀번호는 argon2id로 해시한다.
- 세션은 `sessions` 테이블에 둔다. 쿠키는 HttpOnly, SameSite=Lax로 굽는다.
- 상태를 바꾸는 요청은 Origin 확인과 사용자 지정 헤더 확인으로 CSRF를 막는다.
- 역할은 customer와 admin 두 가지다. 관리자는 공연·회차 등록과 판매 현황을 다룬다.

### 6.4 테스트와 측정

- **단위·통합 테스트**: Vitest가 진짜 로컬 PostgreSQL에 붙는다. 실행할 때마다 템플릿 DB에서 복제한 새 DB를 쓴다(`CREATE DATABASE … TEMPLATE …`).
- **동시성 테스트**: 연결 여러 개로 같은 요청을 동시에 보내고, 끝난 뒤 SQL로 결과를 센다.
- **API 테스트와 부하 스크립트**: Node `fetch`로 보낸다. Git Bash의 curl은 한글 JSON이 깨진다.
- **CI**: GitHub Actions의 Postgres 서비스 컨테이너를 쓴다. **로컬과 같은 주 버전**으로 맞춘다.
- **부하**: k6(winget `GrafanaLabs.k6`)를 쓴다. 앱과 DB가 한 PC에서 돌기 때문에 숫자는 같은 PC 안에서의 **전후 비교**로만 쓴다. 절대 처리량을 주장하지 않는다.
- **쿼리 분석**: `pg_stat_statements`와 `EXPLAIN (ANALYZE, BUFFERS)`를 쓴다.
- **포트**: 이 PC는 3000번 포트를 다른 프로세스가 쓰고 있다. 처음부터 `PORT` 환경 변수를 쓴다.

## 7. 폴더 구조

```
seat-booking/
  apps/
    api/        Fastify 서버, Drizzle 스키마·마이그레이션, 시드, 정리 작업, 가짜 결제
    web/        React + Vite + TypeScript, TanStack Query
  packages/
    shared/     zod 스키마(요청·응답), 공용 타입
  load/         부하 스크립트와 결과
  docs/         설계, 운영 문서(백업·복구, 마이그레이션, 권한)
```

## 8. 단계와 완료 기준

단계는 PR 개수가 아니라 DB 개념 단위로 나눈다. 각 단계가 끝나면 아래 질문에 직접 답할 수 있게 된 뒤 다음으로 간다.

| 단계 | 만드는 것 | 완료 기준 | 설명할 수 있어야 할 것 |
|---|---|---|---|
| 0 | 설치와 뼈대: PostgreSQL 18(winget `PostgreSQL.PostgreSQL.18`), npm workspaces 모노레포, Fastify + Drizzle, 첫 마이그레이션(`venues`, `seats`), CI(`postgres:18` 서비스) | 로컬과 CI에서 빈 테스트가 진짜 DB에 붙어 통과 | 마이그레이션 파일은 어떻게 적용되고 되돌리나 / 연결 풀은 왜 쓰나 |
| 1 | 스키마, 시드, 공연 목록과 좌석 지도 조회 API | 좌석 지도 API가 시드 데이터를 돌려줌, 응답을 zod로 검증 | 정규화를 어디까지 했나 / 이 조회에 어떤 인덱스가 쓰이나(EXPLAIN) |
| 2 | 좌석 선점의 동시성(6.1) | C1, C2, C6 통과. ① 방식은 실패를 증명하는 테스트로 남음 | 조건부 UPDATE가 왜 안전한가 / READ COMMITTED에서 겹친 UPDATE는 어떻게 되나 / advisory lock과 SERIALIZABLE의 차이 |
| 3 | 주문, 가짜 결제, 웹훅, 멱등성, 만료 정리(6.2) | C3, C4, C5 통과 | 멱등 키를 먼저 넣는 이유 / SKIP LOCKED는 무엇을 건너뛰나 / 웹훅 순서가 뒤바뀌면 어떻게 되나 |
| 4 | 인증과 관리자(6.3) | 로그인·로그아웃·세션 만료, 권한 테스트, CSRF 테스트 | 세션과 JWT의 장단점 / SameSite=Lax가 막는 것과 못 막는 것 |
| 5 | 화면: 공연 목록, 좌석 지도, 선점 타이머, 결제, 내 예매, 최소 관리자 | Playwright E2E 1개(선점 → 결제 → 내 예매) | 서버 상태와 화면 상태를 어떻게 나눴나 / 선점 시간이 끝나면 화면은 무엇을 하나 |
| 6 | 부하 측정과 개선 | C2를 부하로 다시 확인, C7 전후 표 | 무엇이 병목이었고 어떻게 찾았나 / 연결 풀 크기는 어떻게 정했나 |
| 7 | 운영: 백업·복구 리허설, 무중단 마이그레이션 예시(열 추가, `CREATE INDEX CONCURRENTLY`), role 분리(앱은 DML만) | C8 기록, 운영 문서 | 백업에서 무엇을 잃을 수 있나 / 왜 앱 계정에서 DDL 권한을 빼나 |
| 8 | (선택) 행동 이벤트 outbox, 분석 프로젝트로 내보내기 | 이벤트가 빠짐없이 한 번 이상 나감 | outbox 패턴을 왜 쓰나 / "정확히 한 번"이 어려운 이유 |

## 9. 위험

- **설치**: winget으로 PostgreSQL을 설치할 때 관리자 권한 창이 뜬다. 사용자가 승인해야 한다.
- **한 PC 측정**: 앱, DB, 부하 도구가 같은 CPU를 나눠 쓴다. 숫자는 전후 비교로만 쓴다(6.4).
- **범위 확장**: 대기열, 큐, 배포 같은 아이디어가 계속 나온다. 2장에 적은 것은 측정이나 사용자 결정 없이 넣지 않는다.
- **두 프로젝트**: 이 프로젝트의 7단계를 끝내기 전에는 분석 대시보드 저장소를 시작하지 않는다.
- **설명 가능성**: 코드는 Claude Code와 함께 쓴다. 8장의 질문에 답하지 못하면 다음 단계로 가지 않는다.

## 10. 정한 것 (2026-10-21, 권장안 채택)

1. 저장소 이름: `seat-booking`.
2. 선점 유지 시간: 5분. 테스트에서는 기다리지 않고 만료 시각을 SQL로 과거로 돌린다(2단계에서 바꿈. 처음에는 "설정으로 짧게 바꾼다"였다).
3. 1인 좌석 한도: 회차당 4석.
4. 배포: 하지 않는다. 로컬과 CI로 끝내고, 7단계 뒤에 다시 판단한다.
5. 대기열: v1에서 뺀다. 6단계 측정을 보고 다시 정한다.
6. 관리자 화면: 공연·회차 등록과 판매 현황만 둔다. 좌석 배치는 시드 JSON으로 넣는다.
7. 진행 방식: engine-room-assistant와 같다. 단계별 브랜치와 짧은 PR, 리뷰 서브에이전트, CI 통과 뒤 머지. push는 요청할 때만 한다.

확정하면서 초안과 바꾼 것:

8. pnpm 대신 npm workspaces를 쓴다. 따로 설치할 것이 없고(corepack 활성화는 관리자 권한이 필요), 이 규모에서는 차이가 없다.
9. TypeScript는 6.0.x로 고정한다. 7(네이티브 컴파일러)이 최신이지만, 쓰는 도구들과의 호환을 확인한 뒤 올린다. 타입 검사(`tsc --noEmit`)에만 쓰고, 실행은 tsx, 테스트는 Vitest가 한다.
10. 앱은 슈퍼유저가 아니라 DB 소유 role로 접속한다. 7단계에서 권한을 더 나눌 때 바꿀 것이 적어진다.

1단계에서 더한 것(2026-10-21):

11. 데이터 모델에 `shows`(공연 작품)와 `performance_grades`(회차별 등급 가격)를 더한다. 제목과 가격을 회차·좌석마다 되풀이하지 않기 위해서다. `performance_seats`에는 판매 상태만 둔다.
12. PostgreSQL의 bigint(int8)는 node-postgres가 기본으로 문자열로 돌려준다. id뿐 아니라 `count(*)`도 int8이다. 연결 풀을 만드는 한 곳에서 int8을 number로 바꾸고, `Number.MAX_SAFE_INTEGER`를 넘으면 오류를 낸다. Drizzle 스키마의 `mode: "number"`와 직접 쓴 SQL의 int8 결과가 같은 타입이 된다. 예외: int8 배열(`bigint[]`)과 numeric(`sum(bigint)`, `avg`)은 여전히 문자열이고, `pg_stat_statements.queryid`처럼 int8 범위 전체를 쓰는 값은 이 변환에서 오류가 난다. 그런 열은 SQL에서 `::text`로 바꿔 읽는다.
13. 요청·응답 스키마는 `packages/shared`의 zod로 정의하고, Fastify에는 fastify-type-provider-zod로 붙인다. 이 패키지는 `@fastify/swagger`를 필수 peer로 끌어온다(지금은 OpenAPI 문서를 만들지 않는다).

2단계에서 더한 것(2026-10-21):

14. `users`를 2단계에서 id·email만으로 먼저 만든다. 선점이 가리킬 사용자가 필요해서다. 비밀번호·세션·역할은 4단계에서 더한다.
15. 4단계 전까지 API는 `X-User-Id` 헤더로 사용자를 가린다. 누구나 다른 사람 행세를 할 수 있는 임시 방식이고, 4단계에서 세션 쿠키로 바꾼다. 헤더가 없거나 형식이 틀리면 400, 없는 사용자면 401이다.
16. 팔린 좌석은 선점(`hold_id`)을 남긴다. 제약은 `(status = 'available') = (hold_id is null)`과 `(hold_id is null) = (hold_expires_at is null)` 두 개다. 3단계에서 제약을 다시 바꾸지 않도록 지금 정한다.
17. 1인 좌석 한도는 사용자·회차 advisory lock으로 지킨다. 세 후보를 같은 장면에서 비교한 결과다(6.1).

3단계에서 정한 것(2026-10-23):

18. 팔린 좌석도 1인 한도에 넣는다. 회차당 "선점 중 + 산 좌석"이 4석이다. 1인 4매의 뜻(되팔기를 막는다)에 맞추었다. (사용자 결정)
19. 판매 기간은 선점 트랜잭션 안에서 DB 시계로 확인한다(409 `SALES_CLOSED`). (사용자 결정)
20. 가짜 결제의 상황(지연·중복·순서 뒤바뀜·실패)은 결제 요청 본문의 `scenario`로 정한다. 테스트가 결정적이다. 무작위로 섞는 것은 6단계(부하)에서 더한다. (사용자 결정)
21. `Idempotency-Key`는 주문 생성과 결제 요청에 받는다. 24시간 보관한다. (사용자 결정)
22. 주문 상태에서 `refunded`를 빼고 결제 상태로 옮긴다. 결제 후 취소(환불 요청)는 v1에서 하지 않는다. (제안, 6.2)
23. 멱등 키는 별도 트랜잭션으로 먼저 넣고, 응답은 업무 트랜잭션 안에서 저장한다. 1분 넘게 처리 중인 키는 넘겨받는다. (제안, 6.2)
24. 잠금 순서는 결제 → 주문 → 좌석(`seat_id` 순). 정리 작업은 SKIP LOCKED로 기다리지 않고 좌석과 주문을 따로 처리한다. (제안, 6.2)
