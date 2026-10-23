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
| `users` | email(unique), password_hash, role | role: customer / admin(기본 customer). 2단계에서 id·email만으로 먼저 만들고(선점이 가리킬 사용자), password_hash·role은 4단계에서 더한다. 이메일은 앞뒤 공백을 지우고 소문자로 저장한다(CHECK). password_hash는 비어 있을 수 있다(4단계 전에 만든 사용자는 로그인할 수 없다) |
| `sessions` | token_hash(PK), user_id, created_at, expires_at | 로그인 세션. 쿠키의 토큰이 아니라 그 SHA-256(16진수 64자)만 둔다. 만료는 손님 7일·관리자 12시간(늘리지 않는다). 인덱스 `(user_id, created_at)`(사용자당 10개 제한, 역할 변경 때 모두 지우기), 정리용 `(expires_at)` |
| `venues`, `seats` | 구역·열·번호, 등급 | 시드 JSON |
| `shows` | title | 공연 작품. 1단계에서 더함(회차에 제목을 두면 회차마다 되풀이된다) |
| `performances` | show_id, venue_id, starts_at, sales_open_at, sales_close_at | 회차. 판매 기간은 `sales_open_at <= now() < sales_close_at`이고 `sales_close_at <= starts_at`(CHECK). 판매 종료는 회차마다 정한다(10장 54) |
| `performance_grades` | (performance_id, grade) PK, price | 회차별 등급 가격. 1단계에서 더함(가격은 좌석이 아니라 등급마다 정해진다) |
| `performance_seats` | (performance_id, seat_id) PK, status, hold_id, hold_expires_at | 좌석 재고. status: available / held / sold. 빈 좌석에만 hold_id가 없다(팔린 좌석은 어느 선점에서 팔렸는지 남긴다). 만료 시각은 holds와 이 표에 함께 둔다(6.1) |
| `holds` | user_id, performance_id, expires_at | 선점 묶음. 요청 하나로 잡은 좌석들이 같은 hold를 가리킨다 |
| `orders` | user_id, hold_id(unique), status, amount, cancel_reason, created_at, updated_at | pending / paid / cancelled. 선점 하나에 주문 하나. amount는 order_items 가격의 합 |
| `order_items` | (order_id, seat_id) PK, price | 주문할 때의 좌석과 가격. 결제 확정 때 이 좌석이 모두 남았는지 본다. 취소·만료로 좌석의 hold_id가 비어도 주문이 어떤 좌석이었는지 남는다 |
| `payments` | id, order_id, provider_ref, status, amount, idempotency_key, refund_attempts, created_at, updated_at | requested / succeeded / failed / refund_pending / refunded / refund_failed. 결제 시도마다 한 행이고 결제사를 부르기 **전에** 넣는다. id가 결제사 쪽 멱등 키다. `provider_ref`는 나중에 채우므로 부분 unique `WHERE provider_ref IS NOT NULL`. `(order_id, idempotency_key)` unique(같은 키로 결제 행이 둘 생기지 않게), 부분 unique `(order_id) WHERE status = 'requested'`(진행 중인 결제는 주문당 하나)와 `(order_id) WHERE status = 'succeeded'` |
| `payment_webhooks` | event_id(unique), payment_id(외래 키 없음), type, result, body, received_at | 받은 웹훅을 처리와 같은 트랜잭션에서 넣는다(inbox). 같은 이벤트의 재전송을 event_id로 거르고, 모르는 결제의 웹훅(unmatched)도 버리지 않고 남긴다 |
| `tickets` | order_id, performance_id, seat_id, status | **부분 unique 인덱스** `(performance_id, seat_id) WHERE status = 'valid'`. 3단계에는 valid만 생긴다(결제 후 취소가 없다, 10장 22) |
| `idempotency_keys` | (user_id, route, key) PK, request_hash, status, owner_token, response_code, response_body, created_at, updated_at | processing / done. 24시간 보관(6.2) |
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

- 만료를 부분 인덱스 조건에 넣을 수 없는 이유: 인덱스 조건의 함수는 IMMUTABLE이어야 하는데 `now()`는 그렇지 않다. 그래서 만료는 ③의 `WHERE`에서 판단하고, 정리 작업이 만료된 선점을 주기적으로 풀어 좌석 지도의 숫자를 맞춘다. 정리 작업은 `FOR UPDATE SKIP LOCKED`로 최대 500행씩 처리한다(6.2).
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

  advisory lock은 좌석 잠금보다 먼저 잡는다(위의 잠금 순서). 세는 것은 좌석 재고 행 중 이 사용자의 선점에 묶인 `held`이고 아직 만료되지 않은 것이다. 3단계부터는 팔린 좌석(`sold`)도 센다(10장 18). 팔린 좌석은 선점(`hold_id`)을 남기므로(10장 16) 같은 질의로 센다. 조건은 `(status = 'held' AND hold_expires_at >= now()) OR status = 'sold'`다. 팔린 좌석도 만료 시각을 그대로 남기므로, `status in ('held', 'sold') AND hold_expires_at >= now()`로 쓰면 팔린 좌석이 5분 뒤 한도에서 빠진다. 만료된 선점을 sold로 바꾸는 결제 확정도 이 한도를 늘리므로 같은 advisory lock을 잡는다(6.2).

- **판매 기간.** 선점 트랜잭션 안에서 회차의 `sales_open_at <= now() < sales_close_at`을 확인하고, 아니면 409 `SALES_CLOSED`다(10장 19). 판매가 열리고 닫히는 순간에도 앱 서버들의 시계가 아니라 DB 시계 하나로 판단한다. 판매 종료(`sales_close_at`)는 회차마다 운영자가 정하는 시각이다(공연 전일 17시, 공연 3시간 전 등, 10장 54). 판매 종료는 **새 선점만** 막는다. 그 전에 잡은 선점은 5분을 다 받아 만료까지 주문하고 결제 마감(만료 30초 전)까지 결제할 수 있다. 그래서 판매 현황은 판매 종료 뒤 최대 5분 동안 바뀔 수 있다. 선점의 만료 시각은 `least(now() + 5분, starts_at)`이다. 공연 직전에 잡은 선점이 공연이 시작한 뒤에 확정되지 않게 한다. 판매 종료가 공연 시작 30초 전보다 늦은 회차(같은 회차 포함)에서만, 공연 시작 30초 안에 잡은 선점은 결제 마감(만료 30초 전, 6.2)이 이미 지나 결제할 수 없다.
- **확인 순서.** 선점 트랜잭션은 advisory lock을 잡은 뒤 판매 기간 → 1인 한도 → 가격(`PRICE_MISSING`, 6.2) → 좌석 순서로 본다. 앞의 셋은 좌석을 잠그기 전에 끝나서, 거절될 요청이 좌석 잠금을 잡지 않는다. 가격 확인은 이 회차에 있는 좌석만 보고, 없는 좌석은 마지막에 `SEAT_UNAVAILABLE`이 된다.

### 6.2 주문, 가짜 결제, 멱등성 (3단계)

흐름:

```
선점(held) ─주문 생성→ 주문 pending(좌석·가격을 order_items에 복사)
  ─결제 요청→ 결제 행 requested를 먼저 커밋 → 가짜 결제사 호출(결제 id가 결제사 쪽 멱등 키)
  ─웹훅 succeeded→ 결제 확정: 주문 paid, 결제 succeeded, 좌석 sold, 표 valid
   (주문이 이미 끝났거나 좌석이 만료됐으면 결제 refund_pending → 환불 작업이 refunded)
  ─웹훅 failed→ 결제 failed(주문은 pending, 선점이 유효하면 다시 결제)
주문 pending ─사용자 취소→ cancelled(user, 선점이 이미 만료됐으면 expired), 좌석 available
주문 pending ─선점 만료(정리 작업)→ cancelled(expired), 좌석 available
```

**상태 전이.** 모든 전이는 "지금 상태가 이전 상태일 때만" 바꾸는 조건부 `UPDATE`다(`WHERE status = 이전 상태`). 같은 행에 두 전이가 겹치면 하나만 1행을 받는다. 2단계의 좌석 선점과 같은 원리다.

| 표 | 상태 | 전이 |
|---|---|---|
| `orders` | pending, paid, cancelled | pending → paid(결제 확정), pending → cancelled(사용자 취소, 선점 만료). paid·cancelled는 끝 상태 |
| `payments` | requested, succeeded, failed, refund_pending, refunded, refund_failed | requested → succeeded(확정함)·failed(실패 웹훅, 대사)·refund_pending(성공 웹훅이 왔지만 주문을 확정할 수 없음), failed → refund_pending(failed 뒤에 성공 웹훅이 옴. 돈을 받았으니 돌려준다), refund_pending → refunded(환불 작업)·refund_failed(다섯 번 실패), refund_failed → refund_pending(관리자가 다시 시도) |
| `payment_webhooks` | received, processed, ignored, unmatched | 받은 웹훅을 처리와 같은 트랜잭션에서 먼저 넣고(received, 이벤트 id unique) 처리한 뒤 결과를 적는다. 처리가 되돌려지면 이 행도 사라져, 재전송 때 다시 처리한다. 커밋된 received는 결과를 적지 않은 버그다 |
| `tickets` | valid(cancelled는 결제 후 취소가 생기면) | 결제 확정 때 좌석마다 한 장. 주문에 있는 좌석만(`order_items` 외래 키) |

초안의 주문 상태 `refunded`는 결제로 옮겼다. 확정하지 못해 돌려주는 돈은 주문이 아니라 그 결제의 일이고, 결제 후 취소(환불 요청)는 v1에서 하지 않는다(10장 22).

**잠금 순서.** 주문 → 사용자·회차 advisory lock → 좌석(`seat_id` 순) → 결제. 결제 행을 바꾸는 경로는 모두 주문 행을 먼저 잡고, 결제 행은 마지막에 잡는다(환불은 결제만). 주문 행은 `FOR NO KEY UPDATE`로 잡는다(외래 키 확인 잠금 `FOR KEY SHARE`를 막지 않는다).

| 경로 | 잡는 순서 |
|---|---|
| 주문 생성 | 선점·좌석은 잠그지 않고 읽는다 → 주문 INSERT(같은 선점의 다른 주문이 있으면 `hold_id` unique에서 기다린다) → 멱등 키 행(마지막) |
| 결제 요청 A | 주문 → 결제 행 INSERT |
| 결제 요청 B(`provider_ref` 채우기) | 결제만 |
| 웹훅 받기 | 웹훅 행 INSERT(같은 이벤트가 처리 중이면 `event_id` unique에서 기다린다) → 결제 확정·실패 반영 |
| 결제 확정(웹훅, 대사) | 주문 → advisory → 좌석 → 결제(마지막 UPDATE에서). 결제 행은 잠그지 않고 읽는다 |
| 실패 반영 | 주문 → 결제 |
| 취소 | 주문 → 좌석 |
| 선점(2단계) | advisory → 좌석 |
| 정리 1·2(좌석 풀기, 주문 취소) | 한 가지만. `SKIP LOCKED`라 기다리지 않는다 |
| 환불 | 결제만. 결제사를 부르는 동안에는 트랜잭션도 잠금도 쥐지 않는다 |
| 대사 | 후보는 잠그지 않고 고르고 결제사 조회는 트랜잭션 밖. 반영은 결제 확정·실패 반영과 같다 |

웹훅 행에서 결제 행으로 외래 키를 두지 않는다. 모르는 결제의 웹훅도 남겨야 하고, 외래 키 확인 잠금(`FOR KEY SHARE`)이 결제 행 갱신과 부딪히지 않게 하려는 것이다(리뷰 실험 E6). `provider_ref`는 부분 unique(`WHERE provider_ref IS NOT NULL`)라 나중에 채워도 외래 키가 가리킬 수 있는 열이 아니어서, 채우는 `UPDATE`가 `FOR NO KEY UPDATE` 강도에 머문다.

결제 요청·결제 확정·취소가 모두 주문 행에서 먼저 줄을 선다. 같은 주문의 두 번째 결제 요청이 첫 결제의 확정과 겹치면, 결제 행의 부분 unique 인덱스를 기다리는 쪽과 주문 행을 기다리는 쪽이 고리를 이뤄 교착(40P01)이 된다(리뷰 실험 E2). 주문 행을 먼저 잡으면 그 고리가 생기지 않는다.

**API.**

| 요청 | 멱등 키 | 하는 일 | 응답 |
|---|---|---|---|
| `GET /performances/:id/me` | - | 이 회차에서 내 유효한 선점(좌석·만료 시각·붙은 주문)과 한도(선점·구매·남은 수), 서버 시각. 새로고침·두 탭·응답 유실 뒤 내 선점과 주문을 다시 찾는다 | 200 |
| `POST /holds/:id/orders` | 필수 | 선점이 내 것이고 유효한지, 좌석이 모두 남았는지 확인하고 좌석과 가격을 복사해 주문(pending)을 만든다 | 201 `OrderView` / 409 `HOLD_EXPIRED`·`ORDER_EXISTS`(기존 orderId)·`PRICE_MISSING` |
| `GET /orders/:id` | - | 주문, 좌석, 결제 전부(최신순), 표. 화면이 웹훅 결과를 기다리며 본다 | 200 `OrderView` / 404 |
| `POST /orders/:id/payments` | 필수 | 결제 행을 먼저 넣고 가짜 결제사를 부른다. 결과는 웹훅으로 온다 | 202 `{ orderId, paymentId, status }` / 409 `ORDER_NOT_PAYABLE`·`PAYMENT_IN_PROGRESS` / 503 `PAYMENT_PROVIDER_UNAVAILABLE` |
| `POST /orders/:id/cancel` | 없음 | pending이면 cancelled로 바꾸고 좌석을 푼다. 이미 cancelled면 같은 결과를 돌려준다 | 200 `OrderView` / 409 `ORDER_NOT_CANCELLABLE`(paid) |
| `POST /webhooks/fake-pay` | 결제사 서명 | 결제 결과를 반영한다 | 200(서명이 맞으면 중복·늦은·모르는 웹훅도 200) / 401(서명 틀림) / 400(본문 모양이 틀림, 10장 49) |

취소에 멱등 키를 받지 않는 이유: 두 번 와도 두 번째는 이미 cancelled라 바꾸지 않고 같은 주문을 돌려준다. 주문 생성과 결제 요청은 두 번 처리되면 행이 하나 더 생긴다(10장 21).

**화면이 받는 것.** 예매하는 사람 입장의 리뷰를 반영했다(10장 31~35).

- **유효한 선점**은 "좌석이 이 선점으로 아직 `held`이고 만료 전"이다. 주문을 취소해도 `holds.expires_at`은 미래로 남으므로, 화면과 `/me`는 이 정의로 거른다.
- **주문 응답은 한 모양(`OrderView`)**을 주문 생성 201, 주문 조회, 취소 200이 함께 쓴다: `orderId`, `holdId`, `performanceId`, `status`, `cancelReason`, `amount`, `items`(좌석 위치·등급·가격), `holdExpiresAt`, `payBy`, `serverTime`, `payments`(전부, 최신순), `tickets`(paid일 때). 결제가 둘이면(첫 결제가 늦게 성공해 환불 중이고 둘째로 결제함) 둘 다 보여야 사용자가 "두 번 빠져나간 돈"이 돌아오는 것을 안다. 선점이 만료됐는데 정리 작업이 아직 돌지 않은 pending 주문은 cancelled(expired)로 보여 준다(좌석 지도가 만료된 선점을 빈 좌석으로 보여 주는 것과 같다, 6.1).
- **결제 마감**: `payBy = holdExpiresAt − 30초`. 결제 요청은 `statement_timestamp()`가 그 뒤면 409 `ORDER_NOT_PAYABLE`(reason `TOO_CLOSE_TO_EXPIRY`)이다. 결과는 보통 1~2초, 웹훅을 다시 보내면 수십 초 뒤에 온다. 그 사이 선점이 끝나 "결제됐는데 환불"이 되는 것을 줄인다. 그보다 긴 유실 경로(대사)의 환불은 받아들이고 화면에 보인다. 화면의 타이머는 5분 상수가 아니라 `payBy`·`holdExpiresAt`으로 돈다(공연 직전의 선점은 5분보다 짧다).
- **서버 시각**: 좌석 지도·선점·주문·`/me` 응답과 `SALES_CLOSED` 본문에 `serverTime`(DB의 `now()`)을 넣는다. 화면은 사용자 PC 시계와의 차이를 보정해 타이머와 판매 시작·종료 카운트다운을 돌린다. 판단은 DB 시계로 하는데 화면이 PC 시계로 세면, 판매가 열리는 순간 버튼이 일찍 켜져 `SALES_CLOSED`가 나고, 닫히는 순간 버튼이 늦게 꺼진다.
- **409 본문**은 code마다 다음 행동을 정할 값을 함께 준다(공유 zod의 discriminated union).

  | code | 함께 주는 것 | 화면이 할 일 |
  |---|---|---|
  | `SEAT_UNAVAILABLE` | `seatIds`(안 되는 좌석) | 그 좌석을 빼고 다시 고르게 |
  | `HOLD_LIMIT` | `limit`, `heldSeats`, `purchasedSeats` | "회차당 1인 4석(구매 포함). 지금 선점 n석, 구매 m석" |
  | `SALES_CLOSED` | `reason`(`NOT_OPEN`·`CLOSED`), `salesOpenAt`, `salesCloseAt`, `startsAt`, `serverTime` | 열기 전이면 카운트다운, 닫혔으면 "예매가 마감되었습니다" |
  | `PRICE_MISSING` | `seatIds` | 그 좌석을 빼고 다시 |
  | `HOLD_EXPIRED` | `expiredAt` | 좌석 다시 고르기 |
  | `ORDER_EXISTS` | `orderId` | 그 주문으로 간다 |
  | `ORDER_NOT_PAYABLE` | `orderId`, `reason`(`PAID`·`CANCELLED`·`HOLD_EXPIRED`·`TOO_CLOSE_TO_EXPIRY`) | 예매 내역 / 좌석 다시 고르기 |
  | `PAYMENT_IN_PROGRESS` | `paymentId` | 다시 보내지 말고 결과를 기다린다 |
  | `REQUEST_IN_PROGRESS` | `Retry-After` | 같은 키로 잠시 뒤 다시 보낸다 |
  | `ORDER_NOT_CANCELLABLE` | `orderId` | 예매 내역 |

  멱등 키의 "처리 중"은 `PAYMENT_IN_PROGRESS`와 헷갈려 `REQUEST_IN_PROGRESS`로 부른다. 할 일이 반대다(하나는 다시 보내고, 하나는 기다린다).
- **결제사 장애**: 결제사 호출이 실패하거나 3초 안에 답하지 않으면 503 `PAYMENT_PROVIDER_UNAVAILABLE` `{ paymentId }`와 `Retry-After`. 5xx라 멱등 키 행은 지워지지만, 같은 키로 다시 보내면 같은 결제를 다시 묻는다(결제 요청 1). 그래서 이중 결제가 없다. 화면은 이것을 실패가 아니라 "결제 확인 중"으로 보인다. 202 본문은 `{ orderId, paymentId, status }`이고, 결제사가 `VOIDED`로 거절한 경우 status가 failed다.
- **가격 없는 좌석**은 선점할 때 막는다(409 `PRICE_MISSING`). 결제할 수 없는 좌석을 5분 쥐고 한도까지 먹는 일이 없게. 주문 생성의 확인은 마지막 방어로 남긴다.
- **선점 놓기**는 따로 두지 않는다. 화면은 선점에 성공하면 곧바로 주문을 만들고, "좌석 다시 선택"은 주문 취소로 한다. 새 쓰기 경로(선점 해제와 주문 생성의 경쟁)를 만들지 않으려는 것이다.
- **멱등 키의 수명**(화면 규칙): 사용자가 버튼을 누를 때마다 새 키를 만든다. 같은 시도의 네트워크 재시도, 503, `REQUEST_IN_PROGRESS`에는 같은 키를 쓴다. 키는 탭 수명 동안 `sessionStorage`에 (주문 id, 시도 번호)로 둔다. 실패한 결제를 같은 키로 다시 보내면 그 실패한 결제가 돌아오므로, "다시 결제"는 새 키다. 422는 화면 버그라 새 키로 다시 시작한다.

**주문과 결제의 조합 → 화면.**

| 주문 | 결제 | 화면 |
|---|---|---|
| pending, `payBy` 전 | 없음, 또는 마지막이 failed | 결제하기(남은 시간) / "결제 실패, 다시 시도" |
| pending | requested | "결제 확인 중", 취소는 숨기거나 "결제됐다면 자동 환불"을 확인받는다 |
| paid | succeeded(다른 결제가 refund_*일 수 있음) | 예매 완료와 표 / "중복 결제 n원 환불 중·완료" |
| cancelled(user·expired) | 없음, 또는 failed | 취소됨 / 시간 초과 → 좌석 다시 고르기 |
| cancelled | requested | "결제 결과 확인 중. 결제됐다면 자동 환불됩니다" |
| cancelled | refund_pending·refunded·refund_failed | 환불 진행 중 / 환불 완료(금액·시각) / 환불 지연, 문의 |

5단계 화면에서 지킬 것(지금 정해 둠): 좌석은 모아 한 번에 선점한다(묶음마다 주문·결제가 따로 생긴다). 판매 종료 뒤에는 주문을 취소하면("좌석 다시 선택") 다시 선점할 수 없으므로, 그 버튼을 숨기거나 확인받는다. 판매 종료는 좌석 지도(또는 목록)의 `performance.salesCloseAt`에서 받아 "예매 마감 MM/DD HH:mm"로 보여 주고, 판매 시작·종료에 맞춰 선점 버튼을 켜고 끌 때는 좌석 지도의 `serverTime`으로 시계를 맞춘다. 주문 화면(`OrderView`)에는 판매 종료를 넣지 않는다(멱등 키로 저장한 응답의 모양이 바뀌지 않게). 본문 없는 POST(결제 요청·취소·로그아웃·환불 다시 시도)에는 `Content-Type`을 붙이지 않는다(빈 본문에 `application/json`이면 400). 화면은 API와 같은 origin(Vite 프록시)이라 `Retry-After`·`Idempotent-Replayed`를 그대로 읽는다(10장 62). "내 예매"에는 paid뿐 아니라 결제가 붙은 cancelled 주문(환불 중·완료)도 넣는다. 관리자 판매 현황에 refund_failed 목록을 둔다.

**주문 생성.** 한 트랜잭션에서 선점이 이 사용자의 것이고 만료 전인지, 그 선점의 좌석이 모두 `held`로 남았는지 보고(좌석을 읽는 문장 안에서 `clock_timestamp()`로 만료를 본다. 문장이 기다린 사이 만료되어 다른 선점이 가져간 좌석만 빠진 주문이 생기지 않게), 좌석마다 그때의 등급 가격을 `order_items`에 복사한다. `orders.amount`는 그 합이다. 나중에 `performance_grades`의 가격이 바뀌어도 이미 낸 금액은 그대로다. 선점 하나에 주문 하나(`orders.hold_id` unique)라 다른 키로 두 번 와도 두 번째는 `ORDER_EXISTS`다.

**결제 요청.** 결제사를 부르기 전에 결제 행부터 넣는다.

1. 트랜잭션 A: 주문 행을 잡는다. 먼저 이 주문에서 **같은 멱등 키로 만든 결제를 상태와 상관없이** 찾는다(`payments(order_id, idempotency_key)` unique). 있으면 새로 만들지 않는다. requested면 결제할 수 있는 주문일 때만 그 결제 id로 2부터 다시 하고(마감이 지났거나 주문이 끝났으면 결제사를 부르지 않고 `ORDER_NOT_PAYABLE`, 결제 행은 대사가 맞춘다, 10장 48), 다른 상태면 그 결제로 처음과 같은 202를 돌려준다. 이 규칙은 다시 보낸 요청에도 넘겨받은 요청에도 같다(C4: 결제 행 1개). 없을 때만 주문이 pending이고 내 것이고 결제 마감(`payBy`) 전인지 본다(아니면 `ORDER_NOT_PAYABLE`과 reason). 다른 키로 만든 진행 중인 결제(requested)가 있으면 `PAYMENT_IN_PROGRESS`다(부분 unique 인덱스가 마지막 방어다). 결제 행(requested, 금액, 이 요청의 멱등 키)을 넣고 커밋한다. 결제 id는 DB가 만든다.
2. 가짜 결제사를 부른다. 결제 id를 결제사 쪽 멱등 키로 넘기므로, 같은 id로 다시 부르면 같은 결제를 돌려준다. 결제사는 자기 결제 번호(`provider_ref`)를 준다. 결제사 호출에는 따로 시간 제한(3초)을 둔다(`statement_timeout`은 DB 밖의 기다림을 막지 않는다).
3. 트랜잭션 B: `provider_ref`를 채운다(`WHERE provider_ref IS NULL`. 웹훅이 먼저 와서 채웠으면 0행이고 그대로 둔다). 0행이어도 202 응답과 멱등 응답은 그대로 저장한다.

결제 행을 먼저 커밋하므로, 웹훅이 결제 요청의 응답보다 먼저 와도 결제 행이 있다. 결제사를 부른 뒤 서버가 죽어 3을 못 했거나 2가 실패해도, 결제 행은 남고 아래 대사 작업이 같은 결제 id로 다시 묻는다.

**웹훅 받기.** 웹훅 본문에는 결제사 이벤트 id, 우리 결제 id, `provider_ref`, 종류(`payment.succeeded`·`payment.failed`·그 밖의 중간 상태)가 있다.

1. 서명을 확인한다(`X-Fake-Signature`, 본문의 HMAC-SHA256). 틀리면 401.
2. 웹훅 행 넣기와 처리를 **한 트랜잭션**에서 한다. `payment_webhooks`에 이벤트 id로 `INSERT … ON CONFLICT DO NOTHING`이 0행이면 이미 처리한 이벤트다. 200을 돌려주고 끝낸다. 처리가 되돌려졌다면(40P01, 시간 제한, 서버 중단) 웹훅 행도 함께 사라졌으므로 재전송 때 다시 처리된다. 같은 이벤트가 동시에 두 번 오면 두 번째는 unique 인덱스에서 첫 번째가 끝나길 기다린 뒤 0행을 받는다. 결제사는 200을 받을 때까지 다시 보내므로, 무시할 때도 200이어야 한다.
3. 결제 id로 결제 행을 찾는다.
   - 없으면 unmatched로 적고 경보 로그를 남긴다(받은 id는 본문째 남긴다).
   - failed인 결제에 succeeded가 오면(대사가 failed로 정한 뒤 결제사 쪽에서 늦게 성공함 등) 돈을 받았으므로 refund_pending으로 보내고 경보 로그를 남긴다.
   - succeeded·refund_pending·refunded인 결제에 failed가 오면 unmatched로 적고 경보 로그를 남긴다(결제사는 끝 상태를 바꾸지 않는다고 약속한다).
   - 중간 상태 같은 모르는 종류는 ignored로 적는다.
   - 모두 200이다.
4. 종류에 따라 아래 결제 확정이나 실패 반영을 하고, 웹훅 행을 processed로 적는다.

**결제 확정(payment.succeeded).** 한 트랜잭션에서 잠금 순서대로 잡는다.

1. 결제의 `order_id`는 바뀌지 않는 값이라 잠그지 않고 읽는다. 주문 행을 `FOR NO KEY UPDATE`로 잡는다.
2. 결제가 requested가 아니면(이미 반영함) 아무것도 하지 않는다.
3. 주문이 pending이 아니면(취소됐거나, 다른 결제로 이미 paid) 결제를 refund_pending으로 바꾼다. 돈은 받았지만 줄 좌석이 없다.
4. 사용자·회차 advisory lock을 잡는다(2단계와 같은 키). 팔린 좌석도 1인 한도에 들어가므로(10장 18), 만료된 선점을 sold로 바꾸는 이 단계도 선점과 같은 줄에 선다.
5. 주문의 좌석을 `seat_id` 순서로 잠그고(`FOR UPDATE`) 하나씩 본다. 모두 `status = 'held' AND hold_id = 이 선점 AND hold_expires_at >= statement_timestamp()`이면 sold로 바꾸고, 주문을 paid로, 결제를 succeeded로 바꾸고, 좌석마다 표(valid)를 넣는다. 하나라도 아니면(만료돼 정리됐거나 다른 사람이 다시 선점했다) 좌석은 그대로 두고 주문을 cancelled(expired)로, 결제를 refund_pending으로 바꾼다.

잠금과 확인은 한 문장이다. `SELECT … ORDER BY seat_id FOR UPDATE`가 좌석마다 `hold_expires_at >= statement_timestamp()`의 결과까지 돌려준다. 쓰기는 다음 문장에서 하고 만료를 다시 보지 않는다(행을 쥐고 있어 바뀌지 않는다). 두 문장에서 각각 `statement_timestamp()`로 보면, 그 사이에 만료 시각이 지나 확인은 통과하고 쓰기는 0행이 될 수 있다. 먼저 잠그고 본 뒤에 한 번만 쓰므로 SAVEPOINT로 되돌릴 일이 없다. 표의 부분 unique 인덱스는 앱 코드에 버그가 있어도 한 좌석에 유효한 표 두 장을 막는다(6.1의 ④).

만료를 `now()`가 아니라 `statement_timestamp()`로 보는 이유: `now()`는 트랜잭션을 시작한 시각이다. 만료 직전에 시작한 확정이 잠금을 기다리다 만료 뒤에 좌석을 sold로 바꾸면, 그사이 만료를 보고 새로 선점한 같은 사용자의 좌석과 합쳐 1인 한도를 넘는다(리뷰 실험 E3: 4석 한도에서 8석). advisory lock을 잡은 뒤의 문장 시각으로 보면, 늦은 확정은 만료를 보고 환불로 간다.

**실패 반영(payment.failed).** 주문 행을 잡고 결제를 requested → failed로 바꾼다. 주문은 pending으로 남고, 선점이 유효하면 다시 결제할 수 있다.

**취소.** 주문 행을 잡고 pending → cancelled(user, 선점이 이미 만료됐으면 expired, 10장 53)로 바꾼 뒤, 이 선점의 `held` 좌석을 `seat_id` 순서로 잠가 `available`로 되돌린다(`status`·`hold_id`·`hold_expires_at`을 한 `UPDATE`에서 함께 비워 CHECK 두 개와 맞춘다). 이미 cancelled면 그대로 200, paid면 409다. 좌석을 만료 전에 빈 좌석으로 되돌리는 경로는 취소뿐이다. 그 좌석을 기다리던 다른 사용자의 선점은 문장 스냅샷에서 held(만료 전)로 본 행을 다시 보지 않으므로 `SEAT_UNAVAILABLE`을 받는다. 취소보다 먼저 온 것과 같은 결과라 틀리지 않고, 다시 보내면 잡힌다.

**정리 작업.** 같은 프로세스에서 주기적으로 돈다(10초). 주기 실행은 서버를 띄우는 `main.ts`에서만 시작하고 `buildApp`에서는 시작하지 않는다. 테스트는 함수를 직접 부른다. 정리 작업은 표 전체를 훑어 바꾸므로, 그 테스트 파일은 다른 테스트 파일과 함께 쓰지 않는 DB(템플릿에서 따로 복제)에서 돈다(10장 50). 단계마다 따로 트랜잭션이고, 한 번에 최대 500행씩 처리한다. 1·2는 `SKIP LOCKED`라 잠긴 행을 기다리지 않고 건너뛴다. 3·4는 결제사를 부르는 동안 트랜잭션도 행 잠금도 쥐지 않는다(대사가 결제 행을 잠근 채 주문을 기다리면 웹훅 확정과 교착한다. 리뷰 실험 E5).

1. 좌석 풀기: `status = 'held' AND hold_expires_at < now()`인 좌석을 `FOR UPDATE SKIP LOCKED`로 골라 `available`로 되돌린다.
2. 주문 취소: 선점이 만료된 pending 주문을 `FOR NO KEY UPDATE SKIP LOCKED`로 골라 cancelled(expired)로 바꾼다.
3. 환불: refund_pending 결제를 잠그지 않고 고른다. 가짜 결제사에 환불을 요청하고(결제 id가 환불의 멱등 키라 다시 불러도 한 번만 환불된다), 성공하면 새 트랜잭션에서 `WHERE status = 'refund_pending'`으로 refunded로 바꾼다. 결제사를 부른 뒤 바꾸기 전에 죽어도 다음 번에 다시 부르면 된다. 결제사가 그 결제를 모르면(가짜 결제사를 다시 띄움) 시도 횟수(`refund_attempts`)를 늘리고(고를 때 읽은 값일 때만), 다섯 번째면 refund_failed로 바꾸고 경보 로그를 남긴다. 사용자에게는 "환불 지연, 문의"가 보이고, 관리자는 목록에서 찾아 다시 시도한다(refund_pending으로, 시도 횟수는 0으로). 결제사에 잇달아 세 번 닿지 않으면 환불·대사 단계는 그 바퀴를 멈춘다(10장 52).
4. 대사: 30초 넘게 requested인 결제를 잠그지 않고 고른다. 웹훅을 잃은 결제를 사용자가 오래 기다리지 않게 짧게 둔다(값은 6단계 측정 뒤 다시 정한다). 트랜잭션 밖에서 가짜 결제사에 묻고, 결과가 있으면 새 트랜잭션에서 웹훅과 같은 함수로 반영한다(주문 → 결제, `status = 'requested'`일 때만). 결제사가 모르는 결제(결제사를 부르기 전에 죽음)면, 먼저 결제사에 그 결제 id를 무효(void)로 해 두고 failed로 바꾼다. 무효로 해 두지 않으면 넘겨받은 요청이 그 뒤에 같은 id로 결제를 만들어, 돈만 받고 결제는 failed로 남을 수 있다.
5. 24시간 지난 멱등 키를 지운다.

SKIP LOCKED는 다른 트랜잭션이 잠근 행을 기다리지 않고 건너뛴다. 결제 확정이 잡고 있는 좌석은 이번에 건너뛰고, 확정이 sold로 바꾸면 다음 번에도 대상이 아니다. 확정이 만료를 보고 환불로 갔다면 좌석은 held로 남아 다음 번에 풀린다.

**C3: 만료와 결제 확정이 겹칠 때.** 둘 다 같은 좌석 행을 다루고, 먼저 잡은 쪽의 결과를 뒤의 쪽이 본다.

- 정리가 먼저: 좌석이 `available`이 된다. 확정의 5에서 조건이 맞지 않아 주문 cancelled(expired), 결제 refund_pending.
- 확정이 먼저: 좌석이 `sold`가 된다. 정리는 잠긴 행을 건너뛰고, 다음 번에는 `held`가 아니라 대상이 아니다.
- 정리가 돌기 전에 만료가 지났다: 확정은 `statement_timestamp()`로 만료를 보고 환불로 간다. 단, 확정이 좌석 잠금을 기다리는 사이 만료가 지나면 판다. 그 잠금을 쥔 트랜잭션도 만료 전에 시작했으므로 다른 사용자가 좌석을 가져가지 못하고, 같은 사용자의 선점은 advisory lock 뒤에 서 있어 한도를 넘지 않는다.

좌석이 두 번 팔리지 않는다. 받은 돈은 좌석으로 바뀌거나(succeeded) 환불로 간다(refund_pending → refunded). failed로 정한 결제에 성공이 늦게 와도 환불로 간다(웹훅 받기 3).

**C5: 취소와 결제 확정이 겹칠 때.** 둘 다 주문 행을 먼저 잡는다. 취소가 이기면 확정의 3에서 pending이 아니라 결제 refund_pending. 확정이 이기면, paid로 바꿨으면 취소는 409 `ORDER_NOT_CANCELLABLE`이고, 선점이 만료돼 cancelled(expired)·refund_pending으로 바꿨으면 취소는 그 주문으로 200이다.

**멱등성(`Idempotency-Key`).** 주문 생성과 결제 요청에 받는다. 키는 사용자와 경로마다 따로다(`(user_id, route, key)` PK). 같은 키를 다른 경로에 써도 서로의 응답을 받지 않는다.

1. 업무를 시작하기 전에 **별도 트랜잭션으로** `INSERT … ON CONFLICT DO NOTHING`(processing, 새 `owner_token`)을 하고 커밋한다. 커밋해 두어야 같은 키로 동시에 온 요청이 이 행을 본다(READ COMMITTED는 커밋된 행만 본다).
2. 이미 있으면:
   - request_hash가 다르면 422 `IDEMPOTENCY_KEY_REUSED`(같은 키를 다른 요청에 썼다).
   - done이면 저장한 응답을 그대로 돌려주고 `Idempotent-Replayed: true`를 붙인다(C4: 차례로 다시 보낸 요청). 본문의 serverTime·status도 처음 것이라, 화면은 이 헤더를 보면 조회로 최신 상태를 읽는다(10장 37).
   - processing이면 409 `REQUEST_IN_PROGRESS`와 `Retry-After`(C4: 동시에 보낸 두 번째 요청).
   - processing인데 `updated_at`이 1분 넘게 지났으면(처리 중에 서버가 죽음) 따로 커밋하는 트랜잭션에서 `owner_token`을 새것으로, `updated_at`을 지금으로 바꿔 넘겨받는다(`WHERE owner_token = 옛것`이라 둘이 동시에 넘겨받지 못하고, `updated_at`을 바꾸므로 세 번째 요청이 곧바로 다시 넘겨받지 못한다).
3. 업무 트랜잭션의 끝에서 같은 트랜잭션으로 응답을 저장하고 done으로 바꾼다. `WHERE owner_token = 내 것 AND status = 'processing'`이 0행이면(누가 넘겨받았다) 예외를 던져 업무까지 되돌리고, 저장된 응답이 있으면 그것을 돌려준다.
4. 업무가 되돌려지며 4xx로 끝나면(2단계처럼 예외로 되돌린다) 업무 트랜잭션 밖에서 응답을 저장한다. 다시 보내도 결과가 같은 4xx(`HOLD_EXPIRED`, `ORDER_EXISTS`, `PRICE_MISSING`, `ORDER_NOT_PAYABLE`)만 저장한다. 시간이 지나면 풀리는 것(`PAYMENT_IN_PROGRESS`)과 5xx는 키 행을 지워 다시 보낼 수 있게 한다. 저장·삭제도 `owner_token`이 내 것이고 status가 processing일 때만 한다. 커밋한 뒤 응답을 만들다 5xx가 나도 done 행을 지우지 않게 하려는 것이다.
5. 결제 요청은 결제사를 트랜잭션 밖에서 부른다. 같은 키의 결제를 먼저 찾는 규칙(결제 요청 1)이 모든 요청에 걸리므로, 다시 보낸 요청이든 넘겨받은 요청이든 결제 행을 하나 더 만들지 않는다.
6. 3단계의 쓰기 경로(주문 생성, 결제 요청, 웹훅, 취소, 정리)에는 문장·잠금 대기 시간 제한을 둔다(`statement_timeout` 5초, `lock_timeout` 3초). 결제 확정은 advisory lock을 기다리는 동안 주문 행을 쥐고 있을 수 있어서다. 넘겨받기 기준(1분)은 이 제한과 결제사 호출 제한(3초)보다 길다. 살아 있는 요청을 넘겨받더라도 `owner_token`과 결제 id 멱등 덕분에 결과는 틀리지 않고 일만 늘어난다(2단계에서 미룬 시간 제한 중 이 부분을 3단계에서 정한다).
7. request_hash는 경로의 id와 본문을 키 순서를 맞춘 JSON으로 만들어 SHA-256으로 잰다. 공백·키 순서만 다른 같은 요청을 다른 요청으로 보지 않는다.

키를 업무와 같은 트랜잭션에 넣는 방법도 있다. 같은 키의 두 번째 요청은 unique 인덱스에서 첫 요청이 끝날 때까지 기다리고, 처리 중 행이 남지 않는다. 대신 중복 요청마다 연결을 쥐고 기다리고, 결제사 호출 같은 바깥 일을 트랜잭션 안에서 해야 한다. 그래서 별도 트랜잭션으로 먼저 넣는다(10장 23).

**가짜 결제사.** 같은 서버 안의 모듈이고, 바깥 결제사처럼 다룬다.

- 결제 만들기, 결제 조회, 무효(void), 환불 네 가지를 준다. 만들기·무효·환불은 결제 id가 멱등 키이고, 작업마다 키를 따로 본다.
- 무효로 한 결제 id로 결제 만들기를 부르면 결제를 만들지 않고 거절한다(`VOIDED`). 무효와 만들기가 겹쳐도 결제사 안에서 둘 중 먼저 온 것만 효과가 있다. 결제 요청이 이 거절을 받으면 결제 행은 바꾸지 않고(대사가 이미 failed로 바꿨다) 그 결제로 202를 돌려준다. 화면은 주문 상태에서 failed를 보고 새 키로 다시 결제한다.
- 결제 요청 본문의 `scenario`로 상황을 고른다(10장 20). `delayMs`(기본 1000)는 웹훅까지의 지연이다.
  - `success`: succeeded 한 번.
  - `fail`: failed 한 번.
  - `duplicate`: 같은 이벤트를 거의 동시에 두 번.
  - `out_of_order`: succeeded를 먼저 보내고, 그보다 앞서 생긴 중간 상태 이벤트를 나중에 보낸다(ignored).
  - `early`: 웹훅을 결제 요청의 응답보다 먼저 보낸다(결제 행을 먼저 커밋하는 이유).
  - `lost`: 웹훅을 보내지 않는다(대사 작업이 30초 뒤 찾는다).
- 웹훅은 앱의 HTTP 경로로 보낸다(개발과 테스트 모두 `app.inject`, 10장 42). 함수를 바로 부르지 않아 서명 확인·검증·응답까지 경로째 시험한다. 2xx를 받지 못하면 1·2·4·8·16초 뒤 다시 보낸다(다섯 번).
- 웹훅 본문은 `X-Fake-Signature` 헤더(본문의 HMAC-SHA256)로 서명한다. 비밀은 환경 변수 `FAKE_PAY_SECRET`이고, 없으면 서버를 띄울 때마다 무작위로 만든다(10장 47).
- 테스트에서는 타이머를 쓰지 않는다. 쌓인 웹훅을 원하는 순서로 직접 보내고, 핸들러를 일부러 실패시켜 재전송도 본다.
- 상태는 메모리에만 둔다. 서버를 다시 띄우면 가짜 결제사의 기록과 보내지 못한 웹훅이 사라진다(실제 결제사는 자기 쪽에 남긴다). 우리 쪽은 대사 작업이 requested 결제를 다시 물어 맞춘다.

**인덱스.** 정리 1 `performance_seats(hold_expires_at) WHERE status = 'held'`, 정리 2 `orders(hold_id) WHERE status = 'pending'`, 마지막 결제 찾기 `payments(order_id, created_at)`, 같은 키의 결제 찾기 `payments(order_id, idempotency_key)` unique, 대사 `payments(created_at) WHERE status = 'requested'`, 환불 `payments(created_at) WHERE status = 'refund_pending'`, 관리자 목록 `payments(updated_at) WHERE status = 'refund_failed'`, 내 선점 찾기는 기존 `holds_user_performance_idx`, 표 `tickets(order_id)`, 멱등 키 지우기 `idempotency_keys(created_at)`.

**PR 순서.** 스키마(표와 제약·인덱스, 공유 zod 스키마) → 판매 기간·팔린 좌석 한도(2단계에서 미룬 것) → 주문 생성과 멱등 키 → 내 선점 조회(`/me`) → 가짜 결제사·결제 요청·웹훅·결제 확정(C4) → 정리 작업(C3, 환불, 대사) → 취소(C5) → 기록.

### 6.3 인증과 관리자 (4단계)

bus-review에서는 Supabase가 대신 해 줬던 부분을 직접 만든다. 3단계까지 쓰던 `X-User-Id` 헤더(10장 15)는 세션 쿠키로 바꾸고 없앤다. 설계 리뷰 둘(보안, API·운영)을 반영했다.

**배치(origin).** CSRF 방어가 "CORS를 열지 않는다"에 기대므로 화면과 API를 브라우저 기준 같은 origin에 둔다.
- 개발: 화면은 Vite(`http://localhost:5173`)이고, `/api` 요청은 Vite `server.proxy`가 API(`http://127.0.0.1:3001`)로 넘긴다. 브라우저는 5173만 본다. 프록시의 `changeOrigin`은 Host만 바꾸고 `Origin` 헤더는 그대로라, `APP_ORIGIN=http://localhost:5173`이다.
- 운영: 리버스 프록시 뒤 같은 origin이다(배포는 하지 않는다, 10장 4).
- CORS는 켜지 않는다. 꼭 켜야 하면 `APP_ORIGIN` 목록과 정확히 같은 값만 허용한다. 요청의 Origin을 그대로 돌려주는 설정(`origin: true`)과 와일드카드는 쓰지 않는다. 켜는 순간 사용자 지정 헤더 방어가 사라지기 때문이다.

**계정.**

| 요청 | 하는 일 | 응답 |
|---|---|---|
| `POST /auth/signup` | 이메일·비밀번호로 손님(customer)을 만들고 바로 로그인한다 | 201 `AuthUser` + 쿠키 / 409 `EMAIL_TAKEN` / 400 |
| `POST /auth/login` | 맞으면 새 세션을 만들고 쿠키를 굽는다 | 200 `AuthUser` + 쿠키 / 401 `INVALID_CREDENTIALS` |
| `POST /auth/logout` | 세션 행을 지우고 쿠키를 지운다. 로그인하지 않았어도 200 | 200 |
| `GET /auth/me` | 지금 로그인한 사용자 | 200 `AuthUser` / 401 |

`AuthUser`는 `{ userId, email, role }`이다. CSRF 범위(인증·사용자·관리자 경로)의 응답에는 오류 응답까지 `Cache-Control: no-store`를 붙인다(쿠키로 사용자를 고르는 응답이 캐시에 남지 않게).

- 이메일은 앞뒤 공백을 지우고 소문자로 바꿔 저장한다. 가입·로그인·관리자 명령이 같은 함수를 쓰고, DB가 `CHECK (email = lower(btrim(email)))`로 지킨다.
- 비밀번호는 NFKC로 정규화한 뒤 8~128자인지 보고 해시한다(앞뒤 공백은 지우지 않는다). 나중에 정규화를 바꾸면 옛 해시가 맞지 않으므로 지금 정한다. argon2id(m=19 MiB, t=2, p=1, OWASP 권장 최소값)로 해시해 PHC 문자열(`$argon2id$v=19$m=…,t=…,p=…$소금$값`)로 저장한다. 로그인에 성공했는데 저장된 해시의 값이 지금 값과 다르면 다시 해시해 바꾼다. 라이브러리는 `@node-rs/argon2`(미리 빌드된 바이너리라 node-gyp가 없다). Node 24의 `crypto.argon2`는 실험 단계라 쓰지 않는다.
- 로그인이 틀리면 이메일이 없는지, 비밀번호가 틀렸는지, 비밀번호가 없는 계정(4단계 전에 만든 사용자)인지 나누지 않고 401이다. 셋 다 같은 시간이 걸리게, 해시가 없으면 가짜 해시로 검증을 한 번 돌린다. 가짜 해시는 처음 쓸 때 지금 값으로 한 번 만든다. 저장된 해시가 깨져 검증이 던져도 500이 아니라 같은 401이고 로그에 남긴다(500이면 그 계정이 있다는 것이 드러난다).
- 가입은 이미 있는 행을 넘겨받지 않는다. 비밀번호가 없는 행이어도 409다("해시가 비었으면 채우기"로 만들면 선점·주문을 가진 계정을 빼앗을 수 있다). 409는 계정이 있다는 것을 드러내지만 가입 화면은 어차피 알려 줘야 해서 받아들인다.
- 무차별 대입과 argon2 부하: 로그인·가입에만 속도 제한을 건다(`@fastify/rate-limit`, 메모리 저장소). 가입은 IP당, 로그인은 IP+이메일당 분당 10회이고, 로그인은 IP 하나로도 분당 100회까지다. IP+이메일만 세면 한 IP가 이메일을 바꿔 가며 보내 카운터(메모리 LRU 5,000개)를 밀어내거나 해시 자리를 차지할 수 있어서다. 같은 NAT 뒤 사용자를 생각해 넉넉히 둔다. 넘으면 429 `TOO_MANY_REQUESTS`와 `Retry-After`(초)다. 여러 IP에서 나눠 오는 시도는 앞단(WAF 등)이 맡는다. argon2는 libuv 스레드 풀(기본 4개)에서 돌아 몰리면 DB 연결의 DNS 조회·파일 작업까지 밀리므로, 동시에 도는 해시를 2개로 제한하고 넘으면 503 `Retry-After`다. 계정 잠금은 하지 않는다(남의 계정을 잠그는 공격이 된다). 프록시 뒤에서는 `TRUST_PROXY`로 앞단 프록시를 알려 줘야 IP가 맞다(설정).

**세션.**
- 로그인·가입할 때마다 무작위 32바이트 토큰을 새로 만들어 쿠키로 준다(base64url 43자). DB에는 토큰의 SHA-256(16진수 64자)만 둔다. DB가 새도 그 값으로 쿠키를 만들 수 없다. 로그인 전 세션이 없으므로 세션 고정 공격(미리 알려 준 세션 id로 로그인시키기)이 통하지 않는다. 요청에 이미 세션 쿠키가 있으면 그 행을 지운다.
- 쿠키: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`는 세션 만료와 같다. `Secure`는 설정(`COOKIE_SECURE`)으로 켠다. 켜면 이름이 `__Host-sid`(Secure, Path=/, Domain 없음이 강제되어 서브도메인·http 구간이 쿠키를 심을 수 없다), 끄면 `sid`다. 운영은 켜고 http 개발 서버는 끈다.
- 만료는 손님 7일, 관리자 12시간이다(만들 때 역할로 정한다). 요청마다 늘리지 않는다(요청마다 쓰기가 생기지 않게). 만료된 세션은 401이고 정리 작업 6이 지운다. 여러 기기에서 로그인할 수 있게 다른 세션을 지우지 않되, 사용자당 최근 10개까지만 남긴다. 전체 로그아웃·비밀번호 변경은 이번 범위가 아니다(생기면 그 사용자의 다른 세션을 모두 지운다).
- 역할을 바꾸면(`admin:promote`) 그 사용자의 세션을 모두 지운다. 역할은 요청마다 `users`에서 읽으므로 내리는 것도 바로 적용된다. 세션을 만드는 트랜잭션은 사용자 행을 `FOR SHARE`로 읽어 만료를 정하고, 그 역할을 로그인 응답에도 쓴다. 승격은 역할을 먼저 바꾸고 세션을 지운다. 그래서 승격과 겹친 로그인은 승격이 먼저면 끝나기를 기다려 관리자 12시간으로 만들고, 로그인이 먼저면 승격이 그 세션까지 지운다. 잠그지 않으면 문장 시작 때의 역할(손님)로 7일짜리 세션을 만들어 승격 뒤에 남긴다.
- 요청마다 쿠키의 토큰을 해시해 `sessions`와 `users`를 기본 키로 조인한다(만료 전만). 형식이 틀린 쿠키는 DB를 보지 않고 401이다. 만료·없는 세션으로 401을 줄 때와 로그아웃 때는 같은 이름·속성으로 `Max-Age=0`을 보내 쿠키를 지운다.

**CSRF.** 쿠키는 다른 사이트에서 보낸 요청에도 붙을 수 있다. 상태를 바꾸는 요청(POST·PUT·PATCH·DELETE, 웹훅 제외)은 셋을 모두 지켜야 한다. 어기면 403 `CSRF_REJECTED`다. 로그인·가입·로그아웃에도 건다(공격자 계정으로 로그인시키는 로그인 CSRF).
1. `Sec-Fetch-Site`가 `cross-site`면 거절한다. 없으면(브라우저가 아닌 도구, 테스트) 넘어간다. `same-site`는 거절하지 않는다.
2. `Origin` 헤더가 있으면 허용 목록(`APP_ORIGIN`, 쉼표로 여럿)과 정확히 같아야 한다. `Origin: null`도 "있는" 값이라 거절한다. 없으면(브라우저가 아닌 도구) 3으로만 판단한다. 다른 origin에서 사용자 지정 헤더를 붙인 요청에는 브라우저가 늘 Origin을 붙이고, Origin이 없는 요청에는 피해자의 쿠키가 없다.
3. 사용자 지정 헤더 `X-Requested-With: seat-booking`이 있어야 한다. 다른 사이트의 폼은 헤더를 붙일 수 없고, 다른 사이트의 `fetch`가 헤더를 붙이면 preflight(OPTIONS)가 먼저 나가는데 CORS가 없으니 브라우저가 본 요청을 보내지 않는다.

`SameSite=Lax`만으로 충분하지 않은 이유와 Lax가 막는 것·못 막는 것은 8장 질문의 답으로 기록에 적는다.

**훅의 위치와 응답 순서.** CSRF·세션 확인은 루트가 아니라 보호 경로를 가진 플러그인 범위에 `onRequest` 훅으로 건다. 루트에 걸면 없는 경로가 404가 아니라 403이 된다. 웹훅은 그 범위 밖에 둬서 자연히 빠진다(가짜 결제사가 보내는 웹훅에는 Origin도 헤더도 없다). `onRequest`라 인증되지 않은 요청의 본문을 풀지 않고, 401이 400보다 먼저 난다. 응답 순서는 없는 경로 404 → CSRF 403(DB를 보지 않는다) → 세션 401 → 관리자 아님 403 → 본문 검증 400 → 속도 제한 429(가입·로그인. 이메일을 봐야 해서 본문 검증 뒤에 세므로 형식이 틀린 요청은 세지 않는다) → 리소스 404 → 409다. 사용자 신원은 이 훅 한 곳에서만 `request.user`로 채우고, 경로는 그것만 읽는다. 훅이 보낸 401·403은 그 경로의 응답 스키마로 직렬화되므로, 보호 경로는 모두 401·403에 공통 스키마 `AuthError`(`{ error, code }`, code는 `UNAUTHENTICATED`·`CSRF_REJECTED`·`FORBIDDEN`)를 선언한다(선언이 다르면 code가 지워지거나 500이 된다).

**역할.** customer와 admin이다. 사용자 경로(선점, `/me`, 주문 생성·조회·취소, 결제)는 로그인하지 않았으면 401 `UNAUTHENTICATED`다. 관리자 경로(`/admin/*`)는 `/admin` 접두사를 가진 플러그인 하나로 등록해 그 안의 훅을 모든 경로가 이어받는다. 로그인하지 않았으면 401, 관리자가 아니면 403 `FORBIDDEN`이고, 테스트가 등록된 `/admin/*` 경로를 모두 모아 둘 다 확인한다(앱 전체 경로 중 `/admin`으로 시작하는 것이 관리자 범위의 경로와 같은지도 본다. 범위 밖에 잘못 등록하면 권한 확인 없이 열린다). 가입으로는 관리자가 될 수 없다. 첫 관리자는 가입한 계정을 명령으로 올린다(`npm run admin:promote -w @seat-booking/api -- <email>`, 서버 밖에서 DB에 직접 붙는 운영 작업). 비밀번호가 없는 계정은 거절한다. 이메일 확인이 없으므로 명령은 그 계정의 가입 시각을 보여 준다(남이 먼저 가입한 주소인지 운영자가 본다). 공개 경로는 공연 목록, 좌석 지도, health, 웹훅(서명)이다.

**관리자 기능.**

| 요청 | 하는 일 |
|---|---|
| `GET /admin/venues` | 공연장과 등급별 좌석 수(회차 등록 폼이 가격을 받을 등급) |
| `GET /admin/shows` | 작품 목록 |
| `POST /admin/performances` | 회차를 등록한다(아래) |
| `GET /admin/performances/:id/sales` | 판매 현황: 회차 정보(작품·공연장·시각, 목록과 같은 모양), 좌석 수(빈·선점·판매, 만료된 선점은 빈 좌석), 주문 수(상태별, 선점이 만료된 pending은 cancelled로 본다, 주문 조회와 같다), 매출(paid 주문 금액 합), 결제 수(상태별, 0인 상태도 채운다), 서버 시각. 한 스냅샷(repeatable read)에서 읽는다 |
| `GET /admin/payments?status=refund_failed` | 환불이 다섯 번 실패한 결제(결제·결제사 번호·주문·주문 상태·회차·사용자·이메일·금액·시도 횟수·시각), 최근 것부터 100개와 `hasMore` |
| `POST /admin/payments/:id/retry-refund` | `WHERE status = 'refund_failed'` 조건부 UPDATE로 refund_pending, 시도 횟수 0(10장 35·52). 이미 refund_pending이면 바꾸지 않고 200(응답의 `changed`로 나뉜다), 다른 상태면 409 `PAYMENT_NOT_RETRYABLE`과 지금 상태, 없으면 404. 다음 정리 작업이 다시 환불한다. 관리자 id·결제 id·결과를 로그에 남긴다 |

- 회차 등록: 본문은 작품(`{ id }` 또는 `{ title }`, 1~200자), 공연장 id, 공연 시작, 판매 시작, 판매 종료, 등급별 가격이다. 판매 종료는 API에서 필수로 받고, 화면이 공연 3시간 전을 미리 채운다(10장 54). 앱이 먼저 확인해 422 `PERFORMANCE_INVALID`와 이유로 거절한다: 판매 기간(`판매 시작 < 판매 종료 <= 공연 시작`), 빠진 등급·모르는 등급(가격의 등급이 그 공연장 좌석의 등급과 정확히 같아야 한다), 없는 공연장·작품. 이유는 모두 모아 `problems`로 준다(폼이 한 번에 보인다, 등급은 이름과 함께). 가격은 0 이상 1천만 원 이하 정수다. 같은 공연장·같은 공연 시작의 회차는 하나다(`unique(venue_id, starts_at)`, 409 `PERFORMANCE_EXISTS`와 그 회차 id). 같은 순간이면 오프셋만 다른 시각도 같다. 넣을 때 `ON CONFLICT DO NOTHING`으로 겹침을 알아채고 트랜잭션을 되돌린다(새 제목으로 만든 작품도 함께 되돌린다). 이것이 두 번 눌러도(동시에 와도) 회차가 둘 생기지 않게 막으므로 멱등 키는 받지 않는다. 회차·등급 가격·재고(`performance_seats`)를 한 트랜잭션에서 넣고, 201로 목록과 같은 모양의 회차 요약을 준다. 관리자 id와 회차 id를 로그에 남긴다. 공연장 조회의 등급은 좌석 배치 순서다. 시드와 같은 함수를 쓰도록 시드를 "공연장 넣기"와 "회차 넣기"로 나눈다. 본문의 알 수 없는 키는 버리고, 넣을 때 열을 하나씩 적는다.
- 회차 시각 수정·삭제와 공연장(좌석 배치) 등록은 하지 않는다. 시각을 바꾸면 진행 중인 선점과의 관계(6.1, 10장 54)를 다시 정해야 하고, 공연장은 시드로 넣는다. 사용자·회차 삭제가 없으므로, 2단계에서 미룬 "사용자·회차 확인이 선점 트랜잭션 밖" 문제도 계속 미룬다.
- 관리자 요청도 CSRF 규칙을 따른다.

**설정.** `APP_ORIGIN`(쉼표로 여럿, 항목마다 `new URL(s).origin === s`인지 본다. 끝에 `/`가 붙으면 모든 요청이 403이 되므로), `COOKIE_SECURE`(`true`/`false` 글자만 받는다. `z.coerce.boolean()`은 `"false"`를 참으로 본다), `AUTH_RATE_LIMIT_PER_MINUTE`(숫자 글자만 받는다. `z.coerce.number()`는 `"0x10"`·`"1e9"`도 숫자로 본다), `TRUST_PROXY`(리버스 프록시 뒤에서만. 믿을 프록시의 주소·CIDR을 쉼표로 적으면 그 프록시가 보낸 `X-Forwarded-For`에서 IP를 읽는다. `true`는 받지 않는다. 누구나 `X-Forwarded-For`를 지어 보내 속도 제한을 피할 수 있다. 앞단 프록시 수(숫자)도 받지 않는다. Fastify 5는 숫자를 주면 아무 프록시도 믿지 않는다). `buildApp`의 기본값은 허용 목록 없음, Secure 켬이라 운영에도 안전하다. 테스트는 Origin을 보내지 않으므로 기존 테스트가 바뀌지 않고, CSRF 테스트만 목록을 넘겨 앱을 만든다. 서버를 띄울 때 적용된 값을 한 줄 로그로 남기고, 목록이 비면 경고한다.

**테스트 인증.** 테스트는 가입 경로를 부르지 않고, 세션 행을 직접 넣는 fixture로 로그인한다(`newSignedInUsers(pool, n, { role })` → `{ id, headers: { cookie, "x-requested-with" } }`). 토큰과 해시는 앱의 세션 모듈이 만든다(해시 방식이 한 곳에만 있게). 1,000명도 문장 두 개다. argon2를 1,000번 돌리지 않는다. 사용자 경로마다 "X-User-Id만 있고 쿠키가 없으면 401" 테스트를 두고, CI는 `apps/api/src`(테스트 파일 제외)에 `x-user-id`가 없는지 본다.

**정리 작업 6.** 만료된 세션을 지운다(500행씩). 순서는 좌석 풀기 → 주문 취소 → 멱등 키 → 세션 → 환불 → 대사다(DB만 쓰는 단계 먼저, 10장 52).

**PR 순서.** 설계 → 스키마(`users` 열·CHECK, `sessions`)·비밀번호·세션 모듈·테스트 fixture·정리 6 → 세션으로 사용자 찾는 훅, `X-User-Id` 걷어내기, 테스트 옮기기, `AuthError` → 인증 경로(가입·로그인·로그아웃·내 정보), CSRF 훅, 설정, 속도 제한 → 역할 훅, `admin:promote`, 판매 현황, 환불 실패 목록·다시 시도 → 시드 나누기, 회차 등록, 공연장·작품 조회 → 기록.

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
| 4 | 인증과 관리자(6.3) | 로그인·로그아웃·세션 만료, 권한 테스트(관리자 경로 전부 401·403), CSRF 테스트, 관리자 기능 테스트(회차 등록 검증, 환불 다시 시도) | 세션과 JWT의 장단점 / SameSite=Lax가 막는 것과 못 막는 것 |
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
15. 4단계 전까지 API는 `X-User-Id` 헤더로 사용자를 가린다. 누구나 다른 사람 행세를 할 수 있는 임시 방식이고, 4단계에서 세션 쿠키로 바꾼다. 헤더가 없거나 형식이 틀리면 400, 없는 사용자면 401이다. → 4단계에서 없앰. 이제 세션이 없거나 만료되면 훅에서 401이고, 사용자가 있다는 것은 세션 조인이 보장한다(6.3).
16. 팔린 좌석은 선점(`hold_id`)을 남긴다. 제약은 `(status = 'available') = (hold_id is null)`과 `(hold_id is null) = (hold_expires_at is null)` 두 개다. 3단계에서 제약을 다시 바꾸지 않도록 지금 정한다.
17. 1인 좌석 한도는 사용자·회차 advisory lock으로 지킨다. 세 후보를 같은 장면에서 비교한 결과다(6.1).

3단계에서 정한 것(2026-10-23):

18. 팔린 좌석도 1인 한도에 넣는다. 회차당 "선점 중 + 산 좌석"이 4석이다. 1인 4매의 뜻(되팔기를 막는다)에 맞추었다. (사용자 결정)
19. 판매 기간은 선점 트랜잭션 안에서 DB 시계로 확인한다(409 `SALES_CLOSED`). (사용자 결정)
20. 가짜 결제의 상황(지연·중복·순서 뒤바뀜·실패)은 결제 요청 본문의 `scenario`로 정한다. 테스트가 결정적이다. 무작위로 섞는 것은 6단계(부하)에서 더한다. (사용자 결정)
21. `Idempotency-Key`는 주문 생성과 결제 요청에 받는다. 24시간 보관한다. (사용자 결정) 관리자 회차 등록은 unique 제약으로 막고 키를 받지 않는다(60).
22. 주문 상태에서 `refunded`를 빼고 결제 상태(refund_pending → refunded)로 옮긴다. 결제 후 취소(환불 요청)는 v1에서 하지 않는다. C5는 결제 전 취소와 확정의 경쟁이라 이것으로 충분하다. (AI 판단, 6.2)
23. 멱등 키는 별도 트랜잭션으로 먼저 넣고, 응답은 업무 트랜잭션 안에서 저장한다. 키 행에 `owner_token`을 두어 저장·삭제·넘겨받기를 그 요청만 하게 하고, 1분 넘게 처리 중인 키는 넘겨받는다. 키는 사용자와 경로마다 따로다. (AI 판단, 6.2. 설계 리뷰 M2·L3 반영)
24. 잠금 순서는 주문 → 사용자·회차 advisory lock → 좌석(`seat_id` 순) → 결제(결제 PR에서 코드에 맞춰 고침, 6.2 잠금 순서). 정리 1·2는 SKIP LOCKED로 기다리지 않고, 환불·대사는 결제사를 부르는 동안 아무것도 쥐지 않는다. (AI 판단, 6.2. 처음 안은 결제 → 주문이었으나, 같은 주문의 두 번째 결제 요청과 교착(40P01)이 나는 것을 설계 리뷰가 실험으로 보였다. 대사가 결제 행을 잠근 채 주문을 기다리는 교착도 실험으로 보였다)
25. 결제 행은 결제사를 부르기 전에 넣고 커밋한다. 결제 id가 결제사 쪽 멱등 키다. 웹훅이 결제 요청의 응답보다 먼저 와도 결제 행이 있다. (AI 판단, 설계 리뷰 H1)
26. 받은 웹훅은 처리와 같은 트랜잭션에서 `payment_webhooks`(이벤트 id unique)에 넣는다. 재전송은 이벤트 id로 거르고, 처리가 되돌려지면 웹훅 행도 사라져 재전송 때 다시 처리한다. 모르는 결제의 웹훅도 남겨 경보를 내고(결제 행으로 외래 키를 두지 않는다), 서명이 맞으면 늘 200이다. (AI 판단, 설계 리뷰 H1·L9·R4·R6)
27. 결제 확정은 좌석을 sold로 바꾸기 전에 사용자·회차 advisory lock을 잡고, 만료를 `statement_timestamp()`로 본다. 늦게 실행된 확정이 1인 한도를 넘기지 않게 한다. (AI 판단, 설계 리뷰 M1, 실험 E3·E3′)
28. 환불과 대사는 DB에 남긴 상태(refund_pending, 30초 넘은 requested)를 정리 작업이 결제사에 다시 물어 맞춘다. 대사(30초 넘은 requested)는 결제사가 모르는 결제를 먼저 무효(void)로 해 둔 뒤 failed로 바꾸고, failed 결제에 성공 웹훅이 오면 환불로 보낸다. 환불은 다섯 번 실패하면 refund_failed로 바꾸고 경보를 남긴다. 가짜 결제사는 메모리에만 상태를 두고, 웹훅을 2xx를 받을 때까지 다섯 번 다시 보낸다. 받은 돈이 기록 없이 남는 경우를 막는 장치라 3단계에 넣는다(구현은 정리 작업 PR). (AI 판단, 설계 리뷰 M3·R2·R8)
29. 결제 요청은 이 주문에서 같은 멱등 키로 만든 결제를 상태와 상관없이 먼저 찾는다(`payments(order_id, idempotency_key)` unique). 결제사 호출이 실패한 뒤 같은 키로 다시 보내도, 넘겨받은 요청이어도 결제 행을 하나 더 만들지 않는다. (AI 판단, 설계 리뷰 R3)
30. 3단계의 쓰기 경로에는 `statement_timeout` 5초, `lock_timeout` 3초, 결제사 호출에는 3초 제한을 둔다. 멱등 키 넘겨받기 기준(1분)은 이보다 길다. 처음 값이고, 6단계 부하 측정에서 대기 시간을 보고 다시 정한다. (AI 판단, 설계 리뷰 M2·R7, 2단계에서 미룬 시간 제한의 일부)

예매하는 사람 입장의 리뷰에서 더한 것(2026-10-23):

31. 결제 마감은 선점 만료 30초 전(`payBy`)이다. 그 뒤의 결제 요청은 409 `ORDER_NOT_PAYABLE`(reason `TOO_CLOSE_TO_EXPIRY`). 선점 끝무렵의 결제가 정상 흐름에서도 환불로 가는 것을 줄인다. 대사 기준도 1분에서 30초로 당긴다. 결제 요청 때 선점을 연장하는 방법은 선점 만료 시각을 한 번만 쓴다는 6.1의 규칙과 C3 논증을 다시 열어야 해서 하지 않는다. (AI 판단, 사용자 입장 리뷰 H2)
32. 사용자별 조회 `GET /performances/:id/me`(내 유효한 선점·붙은 주문·한도·서버 시각)를 둔다. `ORDER_EXISTS`에는 기존 `orderId`를 준다. 선점만 놓는 경로는 두지 않고, 화면이 선점 직후 주문을 만들어 "좌석 다시 선택"을 주문 취소로 한다. (AI 판단, 사용자 입장 리뷰 H1)
33. 응답 모양을 공유 zod로 정한다: 주문은 `OrderView`(좌석·결제 전부·표·`payBy`·`serverTime`), 409는 code마다 다음 행동에 필요한 값을 주는 discriminated union, 결제사 장애는 503 `PAYMENT_PROVIDER_UNAVAILABLE`. 멱등 키의 처리 중은 `REQUEST_IN_PROGRESS`로 부른다. (AI 판단, 사용자 입장 리뷰 H3·M1·M2·M4)
34. 가격 없는 좌석은 선점할 때 막는다(409 `PRICE_MISSING`). (AI 판단, 사용자 입장 리뷰 M3)
35. 환불이 다섯 번 실패하면 결제 상태를 refund_failed로 바꾼다. 사용자에게는 "환불 지연, 문의"가, 관리자에게는 목록이 보인다. (AI 판단, 사용자 입장 리뷰 M6)

구현 리뷰에서 더한 것(2026-10-23):

36. 판매 종료는 지금 공연 시작(`starts_at`)이다. 결제 마감이 선점 만료 30초 전이라, 공연 시작 30초 안에 잡은 선점은 결제할 수 없다. 판매 종료를 공연 시작보다 앞당기는 여유(`starts_at − n`)는 운영 규칙이 필요할 때 정한다. (AI 판단, 선점 PR 리뷰 L2) → 54에서 바꿈.
37. 멱등 키로 다시 보낸 요청에는 처음 응답을 그대로 주고 `Idempotent-Replayed: true`를 붙인다. C4("응답은 처음과 같다")를 지키려고 본문의 serverTime·status를 고치지 않는다. 화면은 이 헤더를 보면 `GET /orders/:id`로 최신 상태를 읽는다. (AI 판단, 주문 PR)
38. 없는 사용자(401, 4단계부터는 세션 훅)와 없거나 남의 선점(404)은 멱등 키를 잡기 전에 거른다. 키 행이 사용자를 외래 키로 가리키고, 이 확인은 아무것도 바꾸지 않는다. 남의 선점·주문은 없는 것과 같이 404다. (AI 판단, 주문 PR)
39. request_hash에는 검증을 마친 값을 넣는다. 주문 생성은 본문이 없어 선점 id만 넣는다. 본문 `{}`를 보냈는지에 따라 422가 나지 않게 한다. (AI 판단, 주문 PR)
40. 쓰기 경로의 시간 제한(문장 5초, 잠금 대기 3초)은 `writeTransaction`이 `set_config(…, true)`로 건다. 걸리면(57014·55P03) 500이고 멱등 키를 지운다. 503과 `Retry-After`로 나누는 것은 6단계 측정 뒤에 본다. (AI 판단, 주문 PR)
41. `GET /performances/:id/me`는 유효한 선점과 붙은 주문만 보여 준다. 선점이 끝난 주문(결제 완료, 환불 중, 시간 초과)은 여기서 찾을 수 없고, 화면은 주문 id(멱등 키와 함께 `sessionStorage`에 둔다)로 `GET /orders/:id`를 본다. 탭을 닫은 뒤에도 찾는 예매 내역 API(`GET /orders`, 내 주문 목록)는 5단계 "내 예매" 화면과 함께 만든다. 409 `ORDER_NOT_PAYABLE`·`ORDER_NOT_CANCELLABLE`의 "예매 내역"도 그때 생긴다. (AI 판단, /me PR 리뷰 L3)
42. 가짜 결제사는 웹훅을 개발 서버에서도 `fetch`가 아니라 `app.inject`로 앱의 웹훅 경로에 보낸다. 같은 프로세스라 네트워크가 필요 없고, 서명 확인·본문 검증·응답까지 경로를 그대로 지난다. 포트를 몰라도 되고, 개발과 테스트가 같은 길을 쓴다. (AI 판단, 가짜 결제사 PR)
43. 결제 요청 202의 status는 그 결제의 지금 상태다. 보통 requested이고, 웹훅이 먼저 왔으면 succeeded다. 결제사가 무효로 거절했으면 대사가 failed로 바꾼 뒤면 failed, 그 전이면 requested다. (AI 판단, 결제 PR)
44. 웹훅 응답의 result에는 웹훅 행에 적는 processed·ignored·unmatched 말고 duplicate(이미 처리한 이벤트)가 있다. duplicate는 행을 새로 넣지 않으므로 응답에만 있다. 중간 상태(payment.processing 등) 이벤트는 주문을 잠그지 않고 ignored다. (AI 판단, 결제 PR)
45. 503 `PAYMENT_PROVIDER_UNAVAILABLE`과 409 `REQUEST_IN_PROGRESS`의 Retry-After는 1초다. 값은 6단계 측정 뒤 다시 본다. (AI 판단, 결제 PR)
46. 결제 요청은 주문 행을 잠그는 문장과 결제할 수 있는지 보는 문장(결제 마감)을 나눈다. 잠그는 문장의 statement_timestamp()는 잠금을 기다리기 전 시각일 수 있어서다. 확정도 advisory lock을 앞 문장에서 따로 잡는다. (AI 판단, 결제 PR)
47. 가짜 결제사의 서명 비밀은 FAKE_PAY_SECRET이 없으면 서버를 띄울 때마다 무작위로 만든다. 서명하는 쪽과 확인하는 쪽이 같은 프로세스라 밖에서 받을 필요가 없다. 테스트도 무작위 또는 테스트 파일의 값을 쓴다. (AI 판단, 결제 PR)
48. 같은 키의 결제가 requested인 채 다시 온 요청도 결제할 수 있는 주문인지 본다. 마감이 지났거나 주문이 끝났으면 결제사를 부르지 않고 409 `ORDER_NOT_PAYABLE`이다(다시 보내도 같아 저장한다). 503 뒤 오래 늦은 재시도가 마감 뒤에 돈을 빼 갔다가 환불하는 일을 막는다. 그 결제 행은 대사가 결제사에 물어 맞춘다(모르면 무효로 하고 failed, 성공했으면 확정 또는 환불). (AI 판단, 결제 PR 리뷰 M1)
49. 서명이 맞는데 본문 모양이 틀린 웹훅은 400이고 남기지 않는다. 이벤트 id 없이는 웹훅 행(event_id 기본 키)을 넣을 수 없다. 결제사가 형식을 바꾸면 다섯 번 다시 보낸 뒤 버려지고, 결제는 대사가 맞춘다. (AI 판단, 결제 PR 리뷰 L2)
50. 정리 작업 테스트는 global-setup이 템플릿에서 따로 복제한 DB(`isolatedDatabaseUrl`)에서 돈다. 정리 작업은 표 전체의 만료 행을 바꾸므로, 다른 테스트 파일과 같은 DB면 그 파일이 만든 만료 선점·주문을 풀거나 취소해 결과가 흔들린다. 정리 함수에 테스트용 범위 인자를 두지 않는다. (AI 판단, 정리 PR)
51. 환불·대사는 결제사에 닿지 않으면(장애, 3초 초과) 그 결제를 건너뛰고 다음 번에 다시 한다. 환불 시도 횟수는 결제사가 "모른다"고 답했을 때만 늘린다. 장애가 길어도 refund_failed로 가지 않는다. 대사의 결과 반영은 웹훅과 같은 함수(applyPaymentResult)이고, 무효로 해 둔 결제는 주문 → 결제 순서로 잡고 requested일 때만 failed로 바꾼다. (AI 판단, 정리 PR)
52. 환불·대사는 결제사에 잇달아 세 번 닿지 않으면 그 바퀴에서 그 단계를 멈추고 경보 한 줄을 남긴다. 장애 중에 결제마다 3초를 기다리고 로그를 남기면 한 바퀴가 수십 분이 되고 로그가 쏟아진다. 첫 실패에 멈추지 않는 것은, 늘 실패하는 결제 하나가 맨 앞에 있을 때 뒤의 결제가 끝내 처리되지 않기 때문이다. DB만 쓰는 단계(좌석 풀기, 주문 취소, 멱등 키 지우기)를 먼저 돈다. 정리 루프를 멈출 때는 진행 중인 바퀴가 끝날 때까지 기다린 뒤 풀을 닫는다. (AI 판단, 정리 PR 리뷰 M1·L1)
53. 선점이 이미 만료된 pending 주문을 사용자가 취소하면 이유는 expired다. 주문 조회가 이미 cancelled(expired)로 보여 준 것과 같게 하고, 정리 작업이 했을 결과와도 같다. 결제 확인 중(requested)인 주문도 취소할 수 있고, 그 결제가 뒤에 성공하면 확정이 환불로 보낸다. 화면은 취소 전에 "결제됐다면 자동 환불"을 알린다(6.2 주문과 결제의 조합 표). (AI 판단, 취소 PR)

3단계 검토에서 정한 것(2026-10-23):

54. 판매 종료는 회차마다 정하는 시각(`performances.sales_close_at`, NOT NULL)이다. 실제 예매처는 예매 마감을 공연(회차)마다 기획사가 정한다(공연 전일 17시, 관람 3·4시간 전 등). "전일 17시"가 사이트 공통 규칙인 것은 취소 마감 쪽이다. 시계 시각 규칙("전일 17시")이 있어 간격이 아니라 시각으로 둔다. 판매 종료는 새 선점만 막고, 그 전에 잡은 선점은 5분을 다 받아 만료까지 주문하고 결제 마감(만료 30초 전)까지 결제할 수 있다(선점 만료는 지금처럼 공연 시작에서만 자른다). 판매 종료에서 자르면 "판매 종료 30초 안의 선점은 결제 불가"가 모든 회차로 옮겨 오고, 마감 직전이 결제 실패·환불이 몰리는 새 경계가 된다. 샘플 시드는 뮤지컬을 공연 전일 17시, 음악회를 공연 3시간 전에 닫는다. 이미 있는 회차는 마이그레이션이 공연 3시간 전으로 채운다(판매 시작이 그보다 늦으면 공연 시작). 이미 판매 중이고 3시간 안에 시작하는 회차는 곧바로 닫힌다(샘플 시드에는 없다). 4단계 관리자 화면의 기본값은 공연 3시간 전을 권한다. 취소 마감은 결제 후 취소가 생길 때 따로 둔다. 좌석 지도에 `serverTime`을 더해 화면이 판매 시작·종료까지 센다. (사용자 결정: 판매 종료를 공연 시작보다 앞당김. 나머지는 AI 판단, 조사·설계 비교 에이전트 셋)

4단계에서 정한 것(2026-10-23, 사용자는 8장 질문 관문 없이 진행하기로 함):

55. 세션은 DB 행(서버 세션)이다. JWT는 쓰지 않는다. 로그아웃·만료·역할 변경을 서버에서 바로 끊을 수 있고, 요청마다 DB를 한 번 더 읽는 값은 이 규모에서 작다(기존 사용자 확인 SELECT를 대신하므로 왕복 수는 같다). 쿠키의 토큰은 SHA-256만 저장한다. (AI 판단)
56. 세션 만료는 손님 7일, 관리자 12시간이고 늘리지 않는다. 요청마다 늘리면 요청마다 쓰기가 생긴다. 사용자당 최근 10개만 남기고, 역할을 바꾸면 그 사용자의 세션을 모두 지운다. 쿠키는 Secure면 `__Host-sid`다. (AI 판단, 보안 리뷰 M1·L2·L3)
57. 비밀번호는 NFKC 정규화 뒤 8~128자, argon2id(m=19 MiB, t=2, p=1), `@node-rs/argon2`. 값이 바뀌면 로그인할 때 다시 해시한다. 로그인 실패는 이유를 나누지 않고, 없는 이메일·비밀번호 없는 계정도 가짜 해시로 검증해 시간을 맞춘다. 가입은 비밀번호 없는 행도 넘겨받지 않는다(409). (AI 판단, 보안 리뷰 M3·L4·L5)
58. CSRF는 `Sec-Fetch-Site: cross-site` 거절 + Origin 허용 목록(정확히 같은 값, `null` 거절) + 사용자 지정 헤더 `X-Requested-With: seat-booking`을 함께 본다. SameSite=Lax 위에 한 겹 더 둔다(같은 사이트의 다른 서브도메인·포트, 오래된 브라우저, GET을 쓰는 실수). 로그인·가입·로그아웃에도 건다. 웹훅은 서명으로 따로 지킨다. 동기화 토큰은 쓰지 않는다(헤더 방식은 상태가 없고 화면이 한 곳에서 붙이면 된다). (AI 판단, 보안 리뷰)
59. 첫 관리자는 가입한 계정을 명령(`admin:promote`)으로 올린다. 관리자 가입 경로를 열지 않는다. 비밀번호 없는 계정은 거절한다. (AI 판단)
60. 관리자는 공연장·작품 조회, 회차 등록, 판매 현황, 환불 실패 목록·다시 시도만 한다. 회차 시각 수정·삭제, 공연장 등록은 하지 않는다. 회차 등록은 판매 종료를 필수로 받고(화면이 3시간 전을 채운다), `unique(venue_id, starts_at)`로 두 번 등록을 막아 멱등 키를 받지 않는다. (AI 판단, API 리뷰)
61. 로그인·가입에는 메모리 저장소 속도 제한(가입은 IP당, 로그인은 IP+이메일당 분당 10회, 로그인은 IP 하나로도 분당 100회)과 argon2 동시 실행 2개 제한(넘으면 503)을 지금 넣는다. 로그인의 IP 하나 제한은 인증 경로 보안 리뷰 H1(이메일을 바꿔 가며 카운터를 밀어내는 우회)로 더했다. 계정 잠금은 하지 않는다. 여러 서버가 같이 세는 속도 제한(Redis 등)과 프록시 앞단 제한은 배포할 때 정한다. (AI 판단, 보안 리뷰 M2. 처음에는 미루기로 했다)
62. 화면과 API는 브라우저 기준 같은 origin에 둔다. 개발은 Vite 프록시, 운영은 리버스 프록시다. CORS를 켜지 않으므로 `Access-Control-Expose-Headers`도 필요 없다. (AI 판단, 보안 리뷰 H1·API 리뷰)
63. 인증·CSRF 확인은 보호 경로를 가진 플러그인 범위의 `onRequest` 훅 한 곳이다. 사용자 신원은 그 훅만 채운다. 보호 경로는 401·403에 공통 `AuthError`를 선언한다. 테스트는 세션 행을 직접 넣는 fixture로 로그인하고, 사용자 경로마다 "X-User-Id만 있으면 401"을, CI는 코드에 `x-user-id`가 남지 않았는지 본다. (AI 판단, 보안 리뷰 H2·M4, API 리뷰)
64. 세션을 만드는 트랜잭션은 사용자 행을 `FOR SHARE`로 읽어 만료를 정하고 그 역할을 로그인 응답에도 쓴다(승격과 겹친 로그인이 손님 7일짜리 세션을 남기거나, 응답의 역할이 세션과 어긋나지 않게). 승격은 역할을 먼저 바꾸고 세션을 지운다(순서를 바꾸면 지운 뒤 손님 세션이 들어갈 수 있다). 로그인마다 사용자 행에 공유 잠금이 생기지만 같은 행을 바꾸는 일은 승격·다시 해시뿐이다. (AI 판단, 관리자 PR과 리뷰 L1·L4)
65. 판매 현황은 회차의 주문·결제를 `holds.performance_id`로 찾는데, `holds`의 인덱스는 `(user_id, performance_id)`라 회차만으로는 순차 탐색이다. 관리자가 가끔 보는 화면이라 지금은 인덱스를 더하지 않고 6단계 측정 때 본다. 환불 실패 목록은 최근 바뀐 것부터 100개와 `hasMore`만 주고 넘기기(커서)는 없다. 관리자가 다시 시도하면 목록에서 빠진다. (AI 판단, 관리자 PR)
66. 회차 등록은 판매 종료가 이미 지난 회차도 거절하지 않는다(설계의 거절 이유에 없고, 판매 기간 확인이 오타 대부분을 잡는다). 잘못 만든 회차는 삭제가 없으므로 시드·DB로 고친다. 마이그레이션 0006(`unique(venue_id, starts_at)`)은 같은 공연장·같은 시각의 회차가 이미 둘 이상 있으면 실패한다(샘플 시드에는 없다). (AI 판단, 회차 등록 PR)
