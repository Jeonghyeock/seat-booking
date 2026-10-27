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
| 측정으로 병목(Node가 좌석 지도 행을 객체로 바꾸고 다시 직렬화하는 일)을 찾아, 좌석 지도의 꺾이는 점을 초당 250건에서 약 1,000건으로 올렸다 | 고치기 전후 측정표(6, `load/RESULTS.md`) |
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
| C7 | 부하 중 좌석 지도 조회 | p95를 개선 전후로 잰다(숫자). 개선은 측정이 가리킨 병목이다(6.6) |
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
| pending, `payBy` 뒤 | requested 없음 | 결제 마감. 선점이 끝날 때까지 "좌석 다시 선택"만 |
| pending | refund_*(앞 결제가 늦게 성공) | 결제하기 + "앞 결제 n원 환불 중·완료" |
| pending | requested | "결제 확인 중", 취소는 숨기거나 "결제됐다면 자동 환불"을 확인받는다 |
| paid | succeeded(다른 결제가 refund_*일 수 있음) | 예매 완료와 표 / "중복 결제 n원 환불 중·완료·지연(문의)" |
| cancelled(user·expired) | 없음, 또는 failed | 취소됨 / 시간 초과 → 좌석 다시 고르기 |
| cancelled | requested | "결제 결과 확인 중. 결제됐다면 자동 환불됩니다". 끝난 상태가 아니다(확정이 잠금을 기다리던 중이면 paid가 될 수 있다, C3) |
| cancelled | refund_pending·refunded·refund_failed | 환불 진행 중 / 환불 완료(금액·시각) / 환불 지연, 문의 |

5단계 화면에서 지킬 것(지금 정해 둠): 좌석은 모아 한 번에 선점한다(묶음마다 주문·결제가 따로 생긴다). 판매 종료 뒤에는 주문을 취소하면("좌석 다시 선택") 다시 선점할 수 없으므로, 그 버튼을 숨기거나 확인받는다. 판매 종료는 좌석 지도(또는 목록)의 `performance.salesCloseAt`에서 받아 "예매 마감 MM/DD HH:mm"로 보여 주고, 판매 시작·종료에 맞춰 선점 버튼을 켜고 끌 때는 좌석 지도의 `serverTime`으로 시계를 맞춘다. 주문 화면(`OrderView`)에는 판매 종료를 넣지 않는다(멱등 키로 저장한 응답의 모양이 바뀌지 않게). 본문 없는 POST(결제 요청·취소·로그아웃·환불 다시 시도)에는 `Content-Type`을 붙이지 않는다(빈 본문에 `application/json`이면 400). 관리자 회차 등록 폼은 시각을 초와 KST 오프셋까지 붙여 보낸다(`2027-03-01T19:00:00+09:00`, `datetime-local` 값 그대로는 400, 브라우저 시간대를 따르는 `toISOString()`도 쓰지 않는다). 응답 시각은 UTC라 `Asia/Seoul`로 바꿔 보인다. 작품은 고른 id나 새 제목 중 하나만 보낸다. 화면은 API와 같은 origin(Vite 프록시)이라 `Retry-After`·`Idempotent-Replayed`를 그대로 읽는다(10장 62). "내 예매"에는 paid뿐 아니라 결제가 붙은 cancelled 주문(환불 중·완료)도 넣는다. 관리자 판매 현황에 refund_failed 목록을 둔다.

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

- 회차 등록: 본문은 작품(`{ id }` 또는 `{ title }`, 1~200자. 둘 중 하나만, 함께 오면 400), 공연장 id, 공연 시작, 판매 시작, 판매 종료(오프셋이 있는 시각, 2000~2099년), 등급별 가격이다. 판매 종료는 API에서 필수로 받고, 화면이 공연 3시간 전을 미리 채운다(10장 54). 앱이 먼저 확인해 422 `PERFORMANCE_INVALID`와 이유로 거절한다: 판매 기간(`판매 시작 < 판매 종료 <= 공연 시작`), 빠진 등급·모르는 등급(가격의 등급이 그 공연장 좌석의 등급과 정확히 같아야 한다), 없는 공연장(좌석 배치가 없는 공연장도)·작품, 이미 지난 판매 종료(DB 시계), 같은 제목의 작품(그 작품 id를 준다). 회차·작품은 지울 수 없어서 실수를 먼저 막는다. 이유는 모두 모아 `problems`로 준다(폼이 한 번에 보인다, 등급은 이름과 함께). 가격은 0 이상 1천만 원 이하 정수다. 같은 공연장·같은 공연 시작의 회차는 하나다(`unique(venue_id, starts_at)`, 409 `PERFORMANCE_EXISTS`와 그 회차 id). 같은 순간이면 오프셋만 다른 시각도 같다. 넣을 때 `ON CONFLICT DO NOTHING`으로 겹침을 알아채고 트랜잭션을 되돌린다(새 제목으로 만든 작품도 함께 되돌린다). 이것이 두 번 눌러도(동시에 와도) 회차가 둘 생기지 않게 막으므로 멱등 키는 받지 않는다. 먼저 넣은 쪽이 끝나기를 잠금 대기 제한(3초) 넘게 기다리면 다른 쓰기 경로처럼 500이다(10장 40). 회차·등급 가격·재고(`performance_seats`)를 한 트랜잭션에서 넣고, 201로 목록과 같은 모양의 회차 요약을 준다. 관리자 id와 회차 id를 로그에 남긴다. 공연장 조회의 등급은 좌석 배치 순서다. 시드와 같은 함수를 쓰도록 시드를 "공연장 넣기"와 "회차 넣기"로 나눈다. 본문의 알 수 없는 키는 버리고, 넣을 때 열을 하나씩 적는다.
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
- **부하**: k6(체크섬을 확인한 zip, 6.6)를 쓴다. 앱과 DB가 한 PC에서 돌기 때문에 숫자는 같은 PC 안에서의 **전후 비교**로만 쓴다. 절대 처리량을 주장하지 않는다.
- **쿼리 분석**: `EXPLAIN (ANALYZE, BUFFERS)`와 `pg_stat_activity`·`pg_stat_user_tables` 표본을 쓴다. `pg_stat_statements`는 서버 설정과 관리자 권한의 서비스 재시작이 필요해 쓰지 않는다(6.6).
- **포트**: 이 PC는 3000번 포트를 다른 프로세스가 쓰고 있다. 처음부터 `PORT` 환경 변수를 쓴다.

### 6.5 화면 (5단계)

**범위.** 공연 목록, 좌석 지도(고르기·선점), 주문(선점 타이머·결제·취소), 내 예매, 로그인·가입, 최소 관리자(판매 현황, 환불 실패 다시 시도, 회차 등록)다. 완료 기준은 Playwright E2E 하나다(가입 → 선점 → 결제 → 내 예매, 8장). E2E는 성공 흐름만 지나므로 유실·503·만료·두 탭·401은 순수 함수 단위 테스트가 지킨다. 꾸밈보다 상태 문구와 좌석 지도의 접근성에 힘을 쓴다.

**스택.** React 19, Vite 8, TypeScript, TanStack Query 5(서버 상태), React Router 8(`createBrowserRouter`), CSS Modules다. UI 라이브러리는 쓰지 않는다. 응답은 `packages/shared`의 zod 스키마로 파싱한다(API 검증과 같은 정의). 단위·컴포넌트 테스트는 Vitest와 Testing Library(jsdom), E2E는 Playwright(chromium)다. 버전은 나온 지 2주가 지난 것 중 최신으로 고르고 `--save-exact`로 넣는다(루트에 이미 있는 vitest는 예외). jsdom은 이 PC의 Node(24.12)를 받는 29.x다(30은 24.15 이상).

**배치와 설정.**
- 개발은 Vite(5173)가 `^/api/`를 API(3001)로 넘기며 `/api`를 뗀다(10장 62). 프록시 대상은 환경 변수로 바꾼다(E2E는 3101). Vite는 `strictPort`로 띄운다(바쁜 포트면 다음 포트로 옮겨 가 E2E 포트를 차지하지 않게).
- 프록시는 `Origin`을 바꾸지 않으므로 `APP_ORIGIN`은 브라우저 주소와 정확히 같아야 한다. 개발 `.env`에 `.env.example`의 `APP_ORIGIN`·`COOKIE_SECURE`가 없으면 모든 POST가 403이고 쿠키가 `__Host-sid`가 된다(화면 뼈대 PR에서 안내한다).
- `apps/web`의 tsconfig는 공통 설정을 이어받되 `module: ESNext`, `moduleResolution: bundler`, `lib: [ES2023, DOM, DOM.Iterable]`, `jsx: react-jsx`, `types: ["vite/client"]`로 바꾼다(TS 6은 `types` 기본값이 비어 있어 CSS 모듈·`import.meta.env`가 오류다). `vite.config.ts`·Playwright 설정은 `tsconfig.node.json`으로 따로 본다(DOM 프로그램에 node 타입이 섞이지 않게). Vitest는 `src/**/*.test.{ts,tsx}`만 잡고(e2e 파일 제외), 설정 파일에서 테스트마다 `cleanup`한다.

**경로.** `/`(공연 목록), `/performances/:id`(좌석 지도), `/orders/:id`(주문), `/my/orders`(내 예매), `/login?next=`, `/signup?next=`, `/admin`, `/admin/performances/:id/sales`, `/admin/refunds`, `/admin/performances/new`다.
- 주문 화면은 URL의 id만으로 다시 그린다(새로고침·뒤로 가기에 안전하다). 선점과 주문 생성이 끝나면 `/orders/:id`로 push한다. 로그인·가입에 성공하면 `next`로 replace한다.
- `next`는 `/`로 시작하고 `//`로 시작하지 않을 때만 받는다(열린 리다이렉트를 막는다). 로그인↔가입 링크는 `next`를 넘긴다.
- 로그인이 필요한 화면(주문, 내 예매)과 관리자 화면은 `["me"]`를 다 읽은 뒤에 판단한다.

**API 클라이언트.** 모든 요청을 fetch 한 곳에서 보낸다.
- 모든 요청에 `X-Requested-With: seat-booking`을 붙인다(같은 origin이라 쿠키는 fetch 기본값으로 간다). `Content-Type: application/json`은 본문이 있을 때만 붙인다(본문 없는 POST에 붙이면 400).
- 2xx는 그 경로의 응답 스키마로 파싱한다(어긋나면 화면 버그로 본다). 4xx·5xx는 `ApiError { status, code, body, retryAfter }`로 던지고, 화면이 그 경로의 오류 스키마(`HoldConflict` 등)로 가른다.
- 시계 표본(아래)과 `Idempotent-Replayed`는 이 자리에서 읽는다.

**인증 오류.** (경로, status, code) → 할 일을 순수 함수로 두고 단위 테스트한다.
- `GET /auth/me`의 401은 "로그인 전"이다. `["me"]`를 null로 두고 아무 데도 보내지 않는다. 공연 목록과 좌석 지도는 로그인 전에도 쓴다.
- 로그인이 필요한 조회(`["myPerformance", id]`, `["order", id]`, `["orders"]`, `["admin", …]`)는 `me`가 있을 때만 켠다.
- 그 밖의 경로에서 401 `UNAUTHENTICATED`가 오면(세션 만료) `["me"]`를 null로 하고 사용자 캐시를 지운다. 로그인 화면으로는 지금 화면이 로그인을 요구할 때(주문, 내 예매, 관리자)만 돌아올 경로와 함께 보낸다. 좌석 지도에서는 "다시 로그인해 주세요"만 보인다.
- 가입·로그인 경로의 400·401·409·429·503은 폼에 보일 문구이고 위 규칙을 타지 않는다.
- 403 `FORBIDDEN`이면 "권한 없음"을 보이고 `["me"]`를 다시 읽는다(관리자에서 내려갔을 수 있다). 403 `CSRF_REJECTED`는 화면 버그다.
- 창으로 돌아오면 `["me"]`를 다시 읽는다. 사용자가 바뀌었으면(다른 탭에서 로그아웃·다른 계정 로그인) 사용자 캐시를 지운다.

**서버 상태와 화면 상태.**
- 서버 상태는 TanStack Query 캐시에만 둔다. 키는 `["me"]`, `["performances"]`, `["seatMap", id]`, `["myPerformance", id]`, `["order", id]`, `["orders"]`, `["admin", …]`다. 선점·주문·결제의 상태는 서버만 정한다. 낙관적 갱신은 하지 않는다(좌석은 그사이 다른 사람이 가져갈 수 있다).
- 화면 상태는 고른 좌석 id, 고른 결제 상황, 멱등 키, 시계 차이뿐이다. 고른 좌석은 로그인하러 갔다 와도 남게 회차별로 `sessionStorage`에 둔다.
- 변이 뒤 무효로 할 키: 선점 → `seatMap`·`myPerformance`, 주문 생성 → `myPerformance`·`orders`, 결제 → `order`, 취소 → `order`·`seatMap`·`myPerformance`·`orders`, 환불 다시 시도 → 관리자 환불 실패 목록·판매 현황. 결제 확정과 만료는 서버(웹훅·정리 작업)가 바꾸므로, 주문 폴링으로 pending이 paid나 cancelled로 바뀌면 그 회차의 `seatMap`·`myPerformance`와 `orders`를 무효로 한다.
- 조회는 4xx면 다시 하지 않는다(5xx와 네트워크 오류만 한 번). 변이는 TanStack의 `retry`를 끈다(선점은 멱등이 아니다). 멱등 키가 있는 요청의 재시도는 아래 규칙대로 변이 함수 안에서 직접 한다.
- 로그인·가입에 성공하면 `["me"]`를 뺀 쿼리를 지우고 `["me"]`에 응답을 넣은 뒤 `next`로 간다. 로그아웃하면 공개 화면으로 간 뒤 `["me"]`를 null로 하고 나머지 쿼리, `sessionStorage`의 멱등 키와 고른 좌석을 지운다(다른 사용자의 주문이 남아 보이지 않게).

**시계.** 차이는 API 클라이언트가 응답을 받는 자리에서만 고친다(캐시의 값으로는 고치지 않는다). `차이 = serverTime − (보낸 시각 + 받은 시각) / 2`다. 새 표본은 왕복 시간이 지금 표본보다 짧거나 지금 표본이 1분보다 오래됐을 때만 받는다(판매 시작 순간의 느린 응답이 시계를 늦추지 않게, 1초 폴링이 타이머를 흔들지 않게). `Idempotent-Replayed: true`인 응답은 쓰지 않는다(처음 응답의 옛 serverTime이다). 타이머와 판매 시작·종료 카운트다운은 `Date.now() + 차이`로 센다. 버튼을 켜고 끄는 판단은 서버가 다시 한다. 공연 목록에는 serverTime이 없어, 판매 예정·판매 중·마감 표시는 차이가 있으면 그것으로, 없으면 PC 시계로 대강 보인다(지난 회차는 "종료").

**다시 보낸 응답.** `Idempotent-Replayed: true`이면 본문을 캐시에 넣지 않고 그 주문을 다시 읽는다(10장 37).

**멱등 키.** 6.2 "멱등 키의 수명"을 이렇게 둔다.
- 키는 `sessionStorage`에 **보내기 전에** 쓴다. 이름은 `idem:createOrder:<holdId>`, `idem:pay:<orderId>`이고 값은 `{ key, body, attempt }`다.
- 같은 시도의 재시도(네트워크 오류, 503, `REQUEST_IN_PROGRESS`)는 저장한 본문을 그대로 보낸다(request_hash가 같아야 한다). 재시도하는 동안 결제 상황 고르기를 잠근다. 재시도는 `Retry-After` 뒤 세 번까지이고, 그 뒤로는 주문 폴링에 맡긴다.
- 저장된 키가 없으면(다른 탭) 새 키로 보낸다. 중복은 `ORDER_EXISTS`와 `PAYMENT_IN_PROGRESS`가 막는다. "다시 결제"는 attempt를 올린 새 키다.

**선점 → 주문.**
1. 좌석 지도는 `available`이고 가격이 있는 좌석만 고르게 한다. 고를 수 있는 수는 `/me`의 `remaining`이다(로그인 전에는 `SEAT_LIMIT_PER_USER`). 판매 기간 밖이면 고를 수 없고 "예매 오픈까지 남은 시간"이나 "예매 마감"을 보인다.
2. 지도를 읽을 때마다 고른 좌석 중 available이 아니거나 가격이 없는 좌석을 빼고 "n석이 이미 선점되었습니다"를 알린다. 고른 수가 `remaining`보다 많으면 선점하기를 끄고 문구를 보인다(무엇을 뺄지는 사용자가 고른다). 판매 중에는 지도를 15초마다, 창으로 돌아올 때, 409 뒤에 다시 읽는다(6단계 부하 모델에 넣는다). 카운트다운이 0이 되거나 로그인에서 돌아와도 자동으로 선점하지 않는다.
3. "선점하기"는 `POST /performances/:id/holds` 다음 곧바로 `POST /holds/:id/orders`를 보내고 주문 화면으로 간다. 로그인 전이면 로그인 화면에 갔다가 돌아온다.
4. 좌석 지도는 `/me`의 선점 좌석을 "내 선점"으로 따로 그린다(`held`와 다른 무늬와 글자). `/me`에 유효한 선점이 있으면 지도 위에 띠를 둔다: 주문이 없으면 "주문 이어서 만들기"(저장한 키로), 있으면 "결제 이어서 하기(남은 시간)". 선점과 주문 생성 사이에서 끊겼거나 뒤로 가기로 돌아온 경우다.
5. 선점이 네트워크 오류·5xx·`SEAT_UNAVAILABLE`·`HOLD_LIMIT`로 끝나면 먼저 `["myPerformance", id]`를 다시 읽는다. 선점은 멱등 키가 없어, 응답을 잃고 다시 누르거나 두 탭에서 고르면 내가 쥔 좌석으로 409를 받는다. 실패한 좌석이 모두 내 유효한 선점 안에 있으면 "이미 선점한 좌석입니다"를 보이고 그 선점으로 간다. 아니면 지도를 다시 읽고 그 좌석을 빼며 "다른 사람이 먼저 선점했습니다"를 알린다(`classifyHoldFailure`, 세 경우를 테스트한다).
6. 그 밖의 409: `PRICE_MISSING`이면 그 좌석을 빼고 알린다. `HOLD_LIMIT`(내 선점이 아니면)은 쥔 좌석·산 좌석과 남은 수를 보인다. `SALES_CLOSED`는 NOT_OPEN이면 카운트다운, CLOSED면 마감이다.

**주문 화면의 상태.** 6.2 "주문과 결제의 조합 → 화면" 표를 순수 함수 하나로 만든다. `orderScreen(order, now) → { main, refunds }`이고 `order`는 `OrderView`에서 `status`·`cancelReason`·`amount`·`payBy`·`holdExpiresAt`·`payments`만 본다(내 예매도 같은 함수를 쓴다). main은 주문 상태, requested 결제가 있는지, now와 `payBy`의 관계로 정하고, refunds는 refund_* 결제마다 한 줄(금액·상태·시각)이다. 표의 줄마다, `payBy` 경계(−1ms와 그 시각)마다 단위 테스트를 둔다. 결제·취소가 409나 재시도 상한을 넘긴 503으로 끝나면 주문을 다시 읽어 이 함수로 그리고, 409의 reason은 문구에만 쓴다(503 뒤 늦은 재시도의 `ORDER_NOT_PAYABLE`이어도 결제가 requested로 남아 돈이 빠졌을 수 있다, 10장 48).

**주문 화면.** `GET /orders/:id`를 보인다. 회차 정보와 판매 종료(`salesCloseAt`)는 `OrderView`에 일부러 없으므로(6.2) `["performances"]` 캐시에서 찾는다.
- 남은 시간은 결제 마감(`payBy`)까지다. `payBy`가 지나면 결제 버튼을 끈다. 화면이 혼자 "만료"를 정하지 않는다. 서버는 선점이 지난 pending을 정리 작업 전이라도 cancelled(expired)로 준다.
- 주문 조회의 다시 읽기 간격은 응답으로 정하는 함수(`orderRefetchInterval(order, now)`)다. requested 결제가 있으면 1초(15초가 지나면 5초), pending이고 `payBy`가 지났으면 상태가 바뀔 때까지 2초, 그 밖에는 멈춘다. 창이 가려지면 멈춘다. 새로고침·내 예매로 들어와도 같은 규칙이라 202를 본 적이 없어도 돈다. 대사가 결제사 장애로 멈춰도(10장 52) 5초 폴링에 머문다.
- 결제는 가짜 결제사의 상황을 고른다(성공·실패·중복·순서 뒤바뀜·먼저 옴·유실, 기본은 성공, "데모"라고 적는다). 202의 status가 이미 succeeded(먼저 옴)나 failed(무효)면 곧바로 다시 읽는다. 503 `PAYMENT_PROVIDER_UNAVAILABLE`과 409 `REQUEST_IN_PROGRESS`는 위 재시도 규칙을 따르고 "결제 확인 중"을 보인다. `PAYMENT_IN_PROGRESS`는 기다린다. 유실은 대사(30초)가 failed로 바꿀 때까지 "결제 확인 중(최대 30초쯤)"이다.
- "좌석 다시 선택"은 주문 취소다. 판매 종료 뒤면 다시 선점할 수 없다고 확인받고, 결제 확인 중이면 "결제됐다면 자동 환불됩니다"를 확인받는다.

**내 예매.** 새 API `GET /orders`를 쓴다(10장 41, 70).
- 응답은 `{ orders, hasMore, serverTime }`이다. 주문 하나는 `OrderView`의 `orderId`·`performanceId`·`status`·`cancelReason`·`amount`·`holdExpiresAt`·`payBy`·`payments`에 회차 요약(`performance`), 좌석 수, 만든 시각을 더한 것이다. 상태는 주문 조회처럼 보이는 상태다(선점이 지난 pending은 cancelled(expired), 그 규칙을 함수 하나로 빼 함께 쓴다).
- 넣는 주문: 보이는 상태가 pending이나 paid인 주문, 그리고 cancelled이면서 failed가 아닌 결제(requested·refund_pending·refunded·refund_failed)가 하나라도 있는 주문이다. 결제 없이 끝났거나 failed만 붙은 주문은 넣지 않는다(돈이 움직이지 않았다).
- 최근에 만든 것부터 100개를 한 스냅샷(repeatable read)에서 읽는다(따로 읽으면 pending 주문에 succeeded 결제가 붙어 보인다). `orders(user_id, created_at)` 인덱스를 더한다(사용자가 매번 여는 경로라 6단계로 미루지 않는다).

**로그인·가입.** 비밀번호 규칙(NFKC 뒤 8~128자)을 `packages/shared`로 옮겨, 가입 폼과 API가 같은 함수로 검증한다(지금은 API에만 있다). 401·409·429(`Retry-After` 초)·503을 문구로 바꾼다. 머리말에 로그인한 이메일과 로그아웃을 둔다.

**관리자.** `me`의 역할이 admin일 때만 메뉴를 보인다(권한은 서버가 지키고 화면의 숨김은 편의다).
- 판매 현황: 회차를 골라 좌석·주문·매출·결제를 보인다.
- 환불 실패: 목록과 다시 시도(`changed`로 "되돌렸다"와 "이미 환불 대기"를 나눈다).
- 회차 등록 폼: 공연장을 고르면 등급별 가격 칸이 생긴다. 작품은 고르기와 새 제목 중 하나만 보낸다(422 `SHOW_TITLE_EXISTS`면 "있는 작품으로 바꾸기"). 시각은 KST로 받아 `…:00+09:00`으로 보내고(6.2 끝의 "5단계 화면에서 지킬 것"), 판매 종료는 관리자가 그 칸을 고치기 전까지 공연 3시간 전을 따라간다. 422 `problems`는 칸에 붙이고, 409는 그 회차로 가는 링크를 보인다. `kstLocalToIso`·`formatKst`·판매 종료 기본값은 단위 테스트를 둔다.

**좌석 지도의 접근성.**
- 좌석은 `button`이다(`aria-pressed`, `aria-label`에 구역·열·번호·등급·가격·상태). 상태는 "선택 가능·선택함·내 선점·선점됨·판매됨·가격 미정" 중 하나다. 고를 수 없는 좌석은 `disabled`가 아니라 `aria-disabled="true"`다(탭이 건너뛰지 않고 위치를 읽을 수 있게).
- 좌석은 열마다 `role="group"`(aria-label "1층 A열")으로 묶는다. 지도 안의 탭 정지점은 하나이고(roving tabindex) 화살표로 옮겨 다닌다. 구역·열 순서는 좌석 지도 응답의 순서(좌석 id)를 따른다.
- 상태를 색만으로 나누지 않고 무늬·글자와 범례로도 나눈다. 고른 좌석 목록과 합계를 함께 보인다.
- 좌석이 빠지거나 409가 나면 `aria-live="polite"`에 한 줄을 넣는다. 남은 시간은 1분·30초·결제 마감 때만 알린다(매초 읽지 않게).

**단위 테스트로 지킬 순수 함수.** `orderScreen`, `orderRefetchInterval`, 시계(`updateClock`: 다시 보낸 응답·느린 표본을 버린다), `classifyHoldFailure`, 고른 좌석 맞추기, API 오류 → 할 일, 멱등 키 저장소, `kstLocalToIso`·`formatKst`·판매 종료 기본값, 시드 날짜 옮기기. 컴포넌트 테스트는 API 클라이언트를 가짜로 바꿔 409 code별 문구, "결제 확인 중", 좌석 지도의 키보드(화살표, `aria-pressed`, `aria-disabled` 좌석의 Enter 무시)를 본다. 타이머는 가짜 시계로 센다.

**개발 시드.** 샘플 시드의 날짜가 고정이라 지금(10월)은 판매 중인 회차가 없다. `shiftSeed(data, now)`는 모든 시각을 하루(86,400,000ms)의 배수만큼 옮겨 가장 이른 판매 시작이 지난 24시간 안에 오게 한다(`k = floor((가장 이른 판매 시작 − now) / 하루) + 1`일을 뺀다). KST에는 일광 절약 시간이 없어 벽시계 시각("전일 17시")이 그대로이고, 모든 시각을 같은 만큼 옮기므로 판매 기간 CHECK와 0006이 지켜진다. `db:seed`와 E2E가 이것을 쓰고, API 테스트와 `readSeedFile`은 원래 날짜를 쓴다. 재시드는 `restart identity`를 하지 않는다(주문·결제 id가 1부터 다시 시작하면 켜 둔 API의 가짜 결제사 메모리와 탭의 멱등 키가 옛 id와 겹친다). 옮긴 시드는 약 4주 뒤 판매가 끝나므로 다시 돌린다.

**E2E.** Playwright 한 시나리오다: 가입(시도마다 새 이메일) → 공연 → 좌석 지도에서 처음 나오는 고를 수 있는 좌석 둘 → 선점 → 주문 → 결제(성공) → 결제 완료(이 단언만 15초) → 내 예매에 있음.
- 다른 DB(`seat_booking_e2e`)와 다른 포트(API 3101, 화면 5174)를 쓴다. 브라우저 쪽 주소는 baseURL·`APP_ORIGIN`·Vite 모두 `http://127.0.0.1:5174` 하나로 맞춘다(localhost를 IPv4·IPv6 중 어디로 푸는지가 도구마다 달라 섞지 않는다).
- webServer는 API, 화면 순서다. Playwright는 webServer를 `globalSetup`보다 먼저 띄우므로 DB 준비(지우기·만들기·마이그레이션·옮긴 시드)는 API를 띄우는 명령 안에서 한다. 준비 명령은 대상 DB 이름을 스스로 정한다(`seat_booking_e2e`만 받는다. 개발 DB를 지우지 않게). 테스트 DB 지우기의 42501 재시도를 다시 쓴다.
- API 환경은 `webServer.env`로 준비와 API가 읽는 키 아홉 개를 모두 준다: `DATABASE_URL`(e2e, 앱 role), `DATABASE_OWNER_URL`(e2e, 소유자, 준비만 읽음, 7단계), `PORT=3101`, `HOST=127.0.0.1`, `APP_ORIGIN=http://127.0.0.1:5174`, `COOKIE_SECURE=false`, `AUTH_RATE_LIMIT_PER_MINUTE=10`, `TRUST_PROXY=""`, `FAKE_PAY_SECRET=""`. 명령줄 `VAR=x`는 Windows cmd에서 안 되고, `--env-file`은 넘기지 않은 키를 `.env`에서 채우므로 API는 `start` 스크립트가 아니라 `tsx src/main.ts`로 띄운다. 기본 DB 주소는 환경 변수, 없으면 `.env`에서 `DATABASE_URL` 하나만 읽는다(슈퍼유저 비밀번호를 webServer로 퍼뜨리지 않게).
- `reuseExistingServer: false`다(밀려난 개발 서버에 붙어 개발 DB에 가입·결제하지 않게). `workers: 1`, CI에서는 `retries: 1`, `forbidOnly`, 실패 trace를 남긴다.
- `npm test`에 넣지 않고 `test:e2e`로 따로 둔다. CI는 기존 job에 화면 build를 더하고(typecheck와 단위 테스트는 워크스페이스로 들어간다), E2E job을 따로 둔다(Postgres 서비스, 앱 role·DB 만들기, `playwright install --with-deps --only-shell chromium`, 실패하면 리포트를 올린다, 15분 제한). 브라우저는 캐시하지 않는다.

**PR 순서.** 설계 → `GET /orders`(인덱스 0007)·비밀번호 규칙을 shared로·시드 날짜 옮기기 → 화면 뼈대(Vite·라우터·쿼리·API 클라이언트·시계·인증 오류·CI build) → 로그인·가입·공연 목록·좌석 지도·선점 → 주문 화면(상태 함수·폴링·결제·취소)·내 예매 → 관리자 → E2E와 CI job → 기록.

### 6.6 부하 측정과 개선 (6단계)

**목표.** 8장 완료 기준은 C2를 부하로 다시 확인하는 것과 C7 전후 표다. 설명할 것은 "무엇이 병목이었고 어떻게 찾았나"와 "연결 풀 크기는 어떻게 정했나"다. 둘 다 아직 재지 않은 숫자에서 나오므로, 이 절은 결과가 아니라 **재는 방법**을 정한다. C7은 "좌석 지도 p95를 개선 전후로 잰다. 개선은 측정이 가리킨 병목이다"로 읽는다. 후보는 인덱스, 질의, 풀, 응답 직렬화·크기다. 측정이 인덱스를 가리키지 않으면 인덱스를 억지로 더하지 않는다. 1장의 이력서 주장과 3장의 C7도 이렇게 고친다(10장 82).

**리뷰가 먼저 잰 것.** 설계 리뷰가 지금 코드로 재 본 값이다. 로그 info, 계측 없이 쟀으므로 기준선에서 다시 잰다.
- 2,000석 좌석 지도 한 번에 Node CPU 약 5ms, 응답 약 200KB다. DB 실행은 약 1.5ms이고, 나머지는 pg 결과 파싱·Drizzle 매핑(약 3ms)과 응답 검증·직렬화(약 1ms)다.
- 좌석 지도만 일정 도착률로 보내면 초당 200건까지 p95가 10ms 안팎이고, 초당 300건에서 p95 1.8초로 꺾인다. 그동안 DB에서 active인 연결은 4개를 넘지 않았다.
- 그래서 좌석 지도는 DB보다 Node 한 스레드가 먼저 찬다. DB 표본만 보면 idle in transaction이나 advisory 잠금 대기로 보여, 잠금이나 풀을 병목으로 잘못 짚는다. 아래 계측이 Node 쪽을 함께 보는 이유다.

**한 PC라는 조건이 먼저다.**
- API, PostgreSQL, k6가 같은 CPU(i5-13600K, P코어 6개·E코어 8개, 20스레드)와 RAM(64GB)을 나눠 쓴다. 모든 표는 "같은 PC에서 바꾸기 전과 후"이고 절대 처리량을 주장하지 않는다.
- 반복은 두 층이다.
  - **탐색**: 조건마다 한 번 돌려 후보를 고르는 데만 쓴다.
  - **확인**: 표에 올릴 비교(C7 전후, 고른 풀 크기와 그 이웃)만 조건마다 다섯 번, A와 B를 번갈아(ABAB…) 돌린다. 회차별 값을 모두 적고(가운데 값과 범위), 범위가 겹치지 않을 때만 나아졌다고 쓴다. 세 번의 가운데 값으로는 3대 3이 완전히 갈려도 우연과 구별하기 어렵다.
  - 기계 시간은 탐색 약 1.5시간, 확인 약 1.5시간, C2 약 1시간으로 잡는다.
- C2는 정확성이라 가운데 값이 아니라 **모든 회차가 통과**해야 한다.
- 매번 같은 템플릿에서 새 DB를 복제하고, 부하 DB의 표는 autovacuum을 끈다(아래 데이터). 복제(FILE_COPY)가 checkpoint를 하고 다음 예약 checkpoint는 5분 뒤라, 5분 안에 끝나는 확인 회차(C7, 예열 포함 3분 반)에는 checkpoint가 들어오지 않는다. 들어왔으면(`pg_stat_checkpointer.num_done`의 차이, `num_timed`는 건너뛴 예약까지 센다) 그 회차는 무효다. 5분이 넘는 탐색 회차(S3 단계 올리기)에는 예약 checkpoint가 들어오므로 수를 적는다.
- Node는 P코어(논리 프로세서 0~11, 도구에서 확인)에 묶고 k6는 나머지 E코어에 묶는다. PostgreSQL은 서비스라 관리자 권한 없이 묶을 수 없어 묶지 않는다. 전원 관리, Defender 검사 제외, PostgreSQL 설정도 관리자 권한이 들어 바꾸지 않고 그대로 적는다(`shared_buffers` 128MB, `max_connections` 100).
- 측정 중에는 다른 무거운 일(빌드, 테스트)을 돌리지 않는다. 1초마다 전체 CPU와 node·postgres·k6의 CPU를 잰다. 다른 프로세스 몫이 크거나 k6가 제 코어를 다 쓰면 그 단계는 무효다(부하를 만드는 쪽이 밀리면 서버가 느린 것처럼 보인다). 이 PC는 쉴 때도 다른 프로세스가 두 코어쯤 쓰므로, k6를 띄우기 전 5초를 기준선으로 재고 그보다 한 코어 넘게 더 쓰면 무효로 본다.

**떨어뜨려 놓기.**
- 부하용 DB(`seat_booking_load`, 템플릿 `seat_booking_load_template`)와 포트(API 3201)를 따로 쓰고, 주소는 모두 `127.0.0.1`이다. 준비 명령은 E2E처럼 대상 DB 이름을 스스로 정하고 다른 이름은 거절한다.
- API는 node로 바로 띄운다. npm이나 셸을 거치면 멈출 때 셸만 끝나고 API가 남는다. `--env-file`을 쓰지 않고 API가 읽는 키만 넘긴다(10장 72와 같다). 그래야 `.env`의 다른 값이 자식에게 넘어가지 않는다.
- CI에는 넣지 않는다(함께 쓰는 러너의 숫자는 잡음이다). `load/`의 도구는 로컬에서만 돈다.

**도구.**
- k6 v2.3.0(나온 지 2주 지난 최신). Windows zip을 받아 함께 올라온 `checksums.txt`의 SHA-256과 맞춰 본 뒤 `%LOCALAPPDATA%\Programs`에 푼다. 저장소에는 넣지 않는다. winget에는 2.2.0까지만 있어 `load/README.md`도 zip으로 안내하고, 실행기가 `k6 version`을 확인한다.
- `pg_stat_statements`는 쓰지 않는다. `shared_preload_libraries`를 바꾸고 서비스를 다시 띄우려면 관리자 권한이 든다(6.4의 쿼리 분석을 이렇게 바꾼다).
- `auto_explain`도 쓰지 않는다. Drizzle은 이름 없는 문장을 보내 매번 그 값으로 계획을 세운다(custom plan). 템플릿의 통계는 측정 동안 바뀌지 않는다(부하 DB의 표는 autovacuum을 꺼 autoanalyze도 돌지 않는다). 그래서 끝난 뒤 같은 값으로 돌린 `EXPLAIN (ANALYZE, BUFFERS)`가 측정 중의 계획과 같다. 경합 중에 무엇을 기다렸는지는 표본기가 본다.
- 앱 role은 `track_io_timing`을 켤 수 없어 BUFFERS에 I/O 시간이 없다. 데이터가 모두 메모리에 들어가 I/O 효과는 나타나지 않는다.
- 프로세스 CPU는 `Get-Counter`로 잰다. 이 PC에서 영문 카운터 경로가 동작한다. `Get-Process`로는 서비스 계정으로 도는 postgres의 CPU를 읽지 못한다.

**API에 더할 손잡이.** 측정을 코드 수정 없이 바꿀 수 있게 환경 변수 넷을 더한다. 기본값은 지금과 같다.
- `DB_POOL_MAX`: 풀 크기(기본은 pg의 10).
- `DB_CONNECT_TIMEOUT_MS`: 풀에서 연결을 기다리는 시간 한도(기본 0, pg처럼 한도 없음). 포화가 오류 없는 끝없는 줄로 나타나는지 보고, 값을 정하는 손잡이다.
- `LOG_LEVEL`: 기본 info. 요청마다 한 줄씩 쓰는 로그가 측정의 병목이 되지 않게 부하에서는 warn으로 재고, 그렇게 쟀다고 적는다.
- `LOAD_STATS`: 디렉터리. 켜면 아래 "API" 지표를 1초마다 그 디렉터리의 파일에 한 줄씩 쓴다.
  - 로그가 아니라 따로 쓰므로 `LOG_LEVEL=warn`에 걸러지지 않는다.
  - Windows에서 프로세스를 끝내면(TerminateProcess) `onClose`가 돌지 않는다. 그래서 끝에 한 번 쓰는 값에 기대지 않고 1초 줄에 모두 담는다.
- 함께 바꾸는 것:
  - 풀에 `application_name`(`seat-booking-api`)을 준다. 표본기가 API의 연결을 가려낸다.
  - IPC 채널로 띄운 경우(`process.send`가 있을 때)에만, `shutdown` 메시지를 받으면 앱을 닫는다. Windows에는 SIGTERM이 없다. 이때 가짜 결제사가 아는 결제 결과를 `LOAD_STATS`에 쓴다(C2 확인 (e)). `npm run dev`는 그대로다.

**데이터.** 부하용 시드는 API가 아니라 SQL(`generate_series`)로 템플릿에 한 번 넣는다(`npm run load:template`, 약 20초). 인덱스와 계획이 실제 크기에서 정해지게 표가 커야 한다.
- 대형 공연장 하나(2,000석, 등급 넷)와 그 공연장의 회차 200개. `performance_seats`는 40만 행이다.
  - **S1 회차** 하나: 모든 좌석에 가격이 있다. 1,000석은 지난 판매처럼 선점·주문·결제·표까지 갖춰 미리 판다. 그래서 판매가 열릴 때 남은 좌석 N은 1,000석이고, 지도에 팔린 좌석과 빈 좌석이 섞인다.
  - **S3 회차** K개(기본 99): 판매 중이고 모든 좌석에 가격이 있다. 결제 뒤에는 취소가 없어(10장 22) 판 좌석이 돌아오지 않는다. 그래서 K는 재고가 계획한 반복 수 × 좌석 수보다 많게 정한다.
  - **나머지**: 지난 회차 100개와 그 주문·결제 약 5만 건(부하 사용자마다 10건으로 paid 7, 사용자 취소 1, 만료 취소 2. 내 예매에 8건이 보인다). **끝난 상태만** 넣는다. 주문은 paid와 cancelled(user, expired), 결제는 succeeded, failed, refunded, refund_failed다. requested나 refund_pending, 만료 전 held를 넣으면 정리 작업이 측정 중에 지난 데이터를 바꾼다.
- 사용자 M=5,000명과 세션.
  - 세션은 행을 바로 넣는다. 토큰과 해시는 앱의 세션 모듈 함수로 만든다. argon2와 가입 속도 제한이 첫 병목으로 잡히지 않게 하려는 것이다.
  - k6가 읽을 Cookie 헤더(`sessionCookieName`으로 정한 이름까지)를 `load/results/`(gitignore)에 쓴다.
  - 세션이 7일 뒤 만료되므로, 6일이 지난 템플릿은 준비 명령이 거절하고 다시 만들게 한다.
- 템플릿을 만든 뒤 `VACUUM (FREEZE, ANALYZE)`를 한다. 대량으로 넣은 직후에는 통계가 없어 좌석 지도 계획이 다르다(리뷰 실험: Nested Loop·버퍼 8,018에서 Bitmap·버퍼 45로). 그대로 두면 autoanalyze가 측정 중에 계획을 바꾼다.
- 그리고 모든 표의 autovacuum을 끈다(`autovacuum_enabled = false`, 복제본이 이어받는다). 복제본은 누적 통계가 0부터라 측정 중에 바꾼 행 수만으로 autoanalyze 기준(표의 10%)을 넘는다. 긴 S3는 좌석 행을 10만 번 넘게 바꾸므로 측정 중간에 autoanalyze와 autovacuum이 돈다. 회차마다 다른 때 돌면 잡음이고, 돌았다고 무효로 하면 긴 회차가 모두 무효가 된다. 대신 끝날 때 표마다 dead tuple 수를 적는다. 운영 DB에서는 켜 둔다(10장 86).
- 회차마다 복제한다: `CREATE DATABASE seat_booking_load TEMPLATE seat_booking_load_template STRATEGY FILE_COPY`(약 1.3초).
  - FILE_COPY는 스스로 checkpoint를 거니 따로 하지 않는다(앱 role은 `CHECKPOINT`를 할 수 없다).
  - 복제본은 통계와 visibility map을 이어받고, 누적 통계는 0부터다.
  - 복제한 뒤 S1 회차의 `sales_open_at`만 그 회차의 T0로 바꾼다. 다른 시각은 템플릿을 만들 때 한 달 넘게 여유를 둔다.

**시나리오.** k6 스크립트로 둔다. 공통으로 다음을 지킨다.
- 요청에 경로 이름과 시나리오로 태그를 붙인다. 409(`SEAT_UNAVAILABLE`·`HOLD_LIMIT`)는 예상한 결과로 두고(`http.setResponseCallback`), 오류 코드별로 센다. 요청마다 시간 한도를 준다.
- 주문과 결제는 화면 규칙을 따른다: 같은 `Idempotency-Key`, `Retry-After` 뒤 세 번까지(10장 76). 본문이 없는 POST에도 `{}`를 보낸다.
- 빈 좌석은 응답 JSON 전체를 풀지 않고 selector로 고른다(k6도 같은 CPU를 쓴다).

시나리오는 셋이다.
- **S2 좌석 지도(C7).** 판매 중인 화면이 15초마다 지도를 다시 읽는다(6.5). 일정 도착률로 보내고 응답 본문은 버린다.
  - 먼저 S2만 도착률을 단계로 올려 **꺾이는 점**을 찾는다. 꺾이는 점은 p95 100ms 미만과 `dropped_iterations` 0을 지키는 가장 큰 도착률이다. 이것도 개선 전후로 적는 결과다. 리뷰의 초당 200~300건은 로그 info에서 잰 값이라 다시 잰다.
  - C7의 기준 숫자는 S2와 S3 흐름을 함께 보내며 잰다(쓰기 부하 속의 지도). 둘이 Node 한 스레드를 나눠 쓰므로 도착률은 합쳐서 기준선의 이벤트 루프 사용률이 0.7쯤 되게 정한다: S2 초당 100건(꺾이는 점 250의 40%) + S3 초당 50반복(최대 200의 25%). 처음 정한 "S2 70% + S3 절반"은 기준선에서 합이 1을 넘어 회차가 무효가 된다(기준선 측정에서 S2 175건만으로 0.7, S3 100반복만으로 0.55). 30초 예열은 빼고 3분을 잰다. `dropped_iterations`가 0이 아니면 그 회차는 무효다.
  - S1과 함께 돌리지 않는다. S1은 끝이 있는 몰림이다. 개선으로 S1이 일찍 끝나면, 지도가 빨라지지 않았어도 S2 창에서 몰림 구간의 비율이 줄어 p95가 내려간다.
- **S3 지속 부하(풀 크기·시간 제한).** 선점 → 주문 → 결제 → paid가 될 때까지 1초마다 읽기가 기본 흐름이다. 일부는 결제하지 않고 주문을 취소하고, 내 예매와 `/me`를 정한 비율로 섞는다.
  - 좌석 경합을 넣지 않는다(경합은 S1의 일이다). 반복 번호로 회차·좌석 묶음·사용자를 정한다. 회차는 번호 mod K이고, 사용자는 회차를 한 바퀴 돌 때마다 바뀐다. 그래서 같은 좌석을 두 번 고르지 않고 1인 한도에도 걸리지 않는다.
  - 풀 크기 5·10·20·40마다 도착률을 단계로 올린다(단계마다 2분). 다음을 지키는 가장 큰 도착률을 찾는다: 쓰기 경로별 p95 300ms 미만, 예상하지 않은 오류 0.1% 미만, `dropped_iterations` 0.
  - 풀 크기는 그 도착률이 가장 좋은 값의 95% 안에 드는 가장 작은 값으로 정한다. 그때의 연결 대기 p95, 잠금 대기 비율, 이벤트 루프 사용률을 함께 적는다. Node가 먼저 차서 풀 크기와 상관없이 곡선이 평평하면 그것이 답이고, 이벤트 루프 사용률을 근거로 적는다.
  - 잠금을 기다리는 연결은 CPU를 쓰지 않고 풀 자리만 차지한다. 그래서 경합이 있는 부하(S1 hot set)에서도 풀 10과 20을 견준다.
  - 측정이 선점 5분보다 길어 만료와 정리 작업이 함께 돈다.
- **S1 오픈 러시(C2).** 판매가 열리는 순간 M명이 몰린다.
  - 두 단계로 나눈다.
    - 판매 전 60초 동안 각자 무작위 시각에 지도를 한 번 읽어 연결을 연다(판매 전 화면을 열어 둔 사용자). 5,000명이 한꺼번에 첫 연결을 열면 이 PC에서 연결 대부분이 거절된다(리뷰 실험: 84%).
    - T0(`sales_open_at`)에 각자 0~1초 안의 무작위 시각에 첫 선점을 보낸다. 클릭은 밀리초까지 같지 않지만, 1초 안이면 몰림이다. 각자 한 번씩 보내므로 첫 선점 응답 시간은 앞 응답을 기다리지 않는다.
  - 빈 좌석 1~4개를 고른다. 고르는 방법은 둘이다: 균일 무작위, 그리고 hot set(70%가 좋은 좌석 10%를 노린다). 409면 지도를 다시 읽고 다른 좌석으로 세 번까지 다시 한다.
  - 사용자 5%는 같은 좌석·다른 좌석으로 선점을 동시에 서너 번 보낸다(두 탭, 응답을 기다리지 않고 다시 누름). 선점 경로의 advisory lock이 풀 연결을 쥔 채 기다리는지 보려는 것이다.
  - 선점에 성공하면 주문을 만들고 결제한다. 결제는 success가 기본이고 fail·duplicate·out_of_order·early·lost를 몇 %씩 섞는다(10장 20). 사용자 10%는 선점이나 주문 뒤 결제하지 않고 떠난다(만료와 정리가 좌석을 돌려준다).
  - p95가 아니라 다음을 보고한다: 첫 선점 응답 시간 분포, 첫 선점 응답이 모두 온 시각, 마지막 선점 성공 시각, 표가 나온 시각의 p50·p90, 시도 횟수별 선점 성공, 오류 코드별 수, 연결을 여는 데 걸린 시간, 그리고 T0부터 10초(몰림 구간)의 API·DB·CPU 지표. 마지막 표가 나온 시각은 결제 시나리오 lost를 대사(30초)가 맞추는 것이 정해 성능과 상관없이 30초대라 쓰지 않는다.
  - 끝나면 조용해질 때까지 기다린 뒤 C2를 확인한다(아래). 균일과 hot set을 각각 무작위 씨앗 셋으로 돌린다.

**지표와 표본.**
- k6:
  - 경로·시나리오별 p50·p95·p99, 상태 코드와 오류 코드별 수, 처리량, `dropped_iterations`, `http_req_connecting`(연결 재사용 확인).
  - 요약에는 threshold를 선언한 하위 지표만 나온다. 그래서 경로와 상태마다 threshold를 선언하고, 요약 형식을 고정한다.
  - 예열을 뺀 구간의 백분위를 계산할 수 있게 요청별 값은 CSV로 받는다. `--out json`은 크고 같은 CPU를 쓴다.
  - 표본이 1,000개보다 적은 경로는 p99를 쓰지 않고, 경로마다 표본 수를 함께 적는다.
  - 원본은 `load/results/`에 두고(gitignore) 요약 표만 커밋한다.
- API(`LOAD_STATS` 1초 줄):
  - 풀: 전체·쉬는·기다리는 연결 수, 연결을 받기까지 기다린 시간(p50·p95·최대). 기다리는 수는 그 순간의 줄 길이일 뿐이라 기다린 시간을 따로 잰다. pg-pool의 `query`도 안에서 `connect`를 부르므로, 풀의 `connect` 하나를 감싸면 트랜잭션과 단일 질의를 모두 잡는다.
  - Node: 이벤트 루프 지연(`monitorEventLoopDelay`의 p50·p99·최대), 이벤트 루프 사용률(`eventLoopUtilization`), `process.cpuUsage()`, GC 멈춤 합, 힙.
  - 경로별: 그 1초의 요청 수, 상태 코드별 수, 서버 처리 시간(`reply.elapsedTime`)의 p50·p95·최대, 5xx의 SQLSTATE별 수(57014·55P03·40P01·23505).
  - 웹훅도 `app.inject`로 같은 훅을 지나므로 웹훅 응답 코드가 경로별에 잡힌다. 가짜 결제사가 다시 보낸 수도 센다.
  - 정리 작업: 한 바퀴 걸린 시간과 단계별 처리 행 수.
  - 기준선 한 번은 `--cpu-prof`로 돌려 Node 시간이 어디에 쓰이는지 본다.
- DB:
  - 0.2초마다 `pg_stat_activity`를 읽어 상태, `wait_event_type`, `wait_event`(advisory, transactionid, tuple 등), 질의 앞부분별로 연결 수를 센다. 조건은 `backend_type = 'client backend'`, 이 DB, 자기 연결 제외다. 표본기 비용은 리뷰 실험에서 한 번에 p50 0.8ms였다.
  - 앱 role은 다른 role과 백그라운드 프로세스를 볼 수 없다. autovacuum은 꺼 두었고, 꺼져 있었는지는 표 통계의 횟수로 본다.
  - 측정 앞뒤로 다음을 찍는다: `pg_stat_user_tables`(순차·인덱스 탐색, dead tuple, autovacuum·autoanalyze 횟수), `pg_stat_user_indexes`, `pg_stat_database`(deadlocks, xact_rollback, temp_files, blks_hit/read), `pg_stat_checkpointer`.
  - 결제 확정까지의 시간은 k6의 1초 폴링이 아니라, DB에서 succeeded 결제의 `updated_at − created_at` 분포로 본다.
  - 끝에 주요 질의(좌석 지도, 선점, 주문 생성, 결제 확정, 내 예매, `/me`, 판매 현황)를 `EXPLAIN (ANALYZE, BUFFERS)`로 본다. JIT 줄이 있는지도 본다.
- 프로세스: 1초마다 전체 CPU와 node, postgres(모든 백엔드 합), k6의 CPU.

**합격 확인(C2).** S1이 끝나고 조용해진 뒤 `load/`의 SQL 파일로 본다. 조용해진 뒤란 다음이 모두 지난 뒤다: 마지막 선점의 만료(5분), 정리 한 바퀴(10초), 대사 기준(30초), 웹훅 재전송(31초). 모든 회차가 다음을 통과해야 한다.
- (a) DB 불변식:
  - 좌석마다 유효한 표가 하나 이하다.
  - sold 좌석과 유효한 표가 하나씩 맞는다. 표 없는 sold도, sold가 아닌 좌석의 유효한 표도 없다.
  - paid 주문마다 succeeded 결제가 하나이고 그 좌석의 표가 있다.
  - 사용자마다 회차당 4석 이하다.
  - paid 주문인데 held로 남은 좌석이 없다.
  - 성공한 결제의 주문은 paid이고, 주문 금액은 담은 좌석 가격의 합·성공한 결제의 금액과 같다.
  - 좌석의 선점 만료는 선점 행의 만료와 같고, 그 선점은 좌석의 회차 것이다.
  - 3단계 부하에서 쓴 불변식 일곱 가지(PROGRESS 3단계)를 SQL로 옮겨 함께 본다(만료된 pending과 requested 결제는 (d)에서 본다).
- (b) 클라이언트와 대조한다. k6가 사용자마다 paid로 받은 주문과 좌석을 남긴다. 두 사용자가 같은 좌석을 가졌다고 믿는 경우가 0이고, 클라이언트가 본 paid와 DB의 paid가 같다.
- (c) 마지막 방어가 작동하지 않았다: 표의 23505가 0, 웹훅 5xx가 0이다. 중복 판매가 없더라도 DB 제약이 막았다면 앱의 버그다.
- (d) 남은 일이 없다: held 좌석, requested 결제, refund_pending 결제, 결과가 없는 웹훅 행, processing 멱등 키가 모두 0이다. deadlocks도 늘지 않았다.
- (e) 결제사와 DB가 맞다. 가짜 결제사가 돈을 받고 돌려주지 않은 결제는 DB에서 succeeded다(refund_failed도 실패다). 결제사가 실패로 아는 결제는 DB에서도 failed이고, 환불했는지가 서로 같다. 그 회차에서 돈이 오간 결제를 결제사가 모르는 경우도 0이다. 가짜 결제사는 측정 중에 다시 뜨지 않으므로 어긋남은 버그로만 생긴다.
- (f) 살아 있다. 사용자가 좌석보다 훨씬 많으므로 빈 좌석이 남으면 이유가 있어야 한다. 빈 좌석마다 k6 기록으로 누가 언제 골랐는지 보고, 결제 없이 풀린 뒤 아무도 다시 고르지 않은 것만 받는다. 한 번도 고르지 않은 빈 좌석이 남았는데 좌석이 없다며 포기한 사용자가 있으면 실패다(지도가 빈 좌석을 보여 주지 않았다).

- (g) 측정이 제대로 돌았다: 측정 중에 팔린 좌석이 있고, 사용자마다 결과가 하나씩 남았고, 선점 응답은 201과 경합의 409(SEAT_UNAVAILABLE·HOLD_LIMIT)뿐이고(응답이 없던 것은 "알 수 없음"으로 따로 센다), 웹훅이 아닌 경로에도 5xx가 없고, k6와 API가 정상으로 끝났다. 설정이 잘못돼 모든 선점이 401이 되어도 (a)~(f)는 0이라 통과해 버리기 때문이다(실행기 리뷰에서 재현).

"판 좌석 ≤ N"과 "좌석마다 유효한 표 하나 이하"는 제약이 보장한다. 이것만으로는 아무것도 팔지 않아도 통과하므로 (b)~(g)를 더한다.

**병목을 찾는 순서.** 기준선을 잰다 → 표본에서 가장 느린 경로와 가장 많이 기다리는 곳을 찾는다 → 한 번에 하나만 바꿔 다시 잰다 → 바꾼 것마다 전후 표와 회귀 테스트를 남긴다. 숫자가 나아지지 않으면 되돌린다. 어디서 기다리는지는 다음으로 판정한다.
- k6 p95가 서버 처리 시간 p95보다 훨씬 크면, 요청이 Fastify에 닿기 전에 기다린 것이다(이벤트 루프나 k6).
- 이벤트 루프 사용률이 0.9 이상이거나 node CPU가 한 코어에 가까우면 Node다.
- 연결 대기 시간이 크면 풀이다.
- Lock 대기가 크면 잠금이다.
- DB 연결이 idle in transaction이거나 ClientRead이면 DB가 Node를 기다리는 것이다(트랜잭션을 연 채 이벤트 루프가 밀렸다).

**측정 뒤에 정할 것.** 앞 단계에서 미룬 것이다. 바꾸지 않는 것도 결과다(숫자와 함께 적는다).
- 시간 제한(57014·55P03)에 걸린 요청을 500으로 둘지, 503과 `Retry-After`로 나눌지(10장 40). Retry-After 1초(10장 45).
- 풀 크기와 `connectionTimeoutMillis`.
- 선점 경로의 `lock_timeout`(2단계에서 미룸). 지금 선점 경로는 `writeTransaction`을 거치지 않아 문장·잠금 시간 한도가 없다.
- 인덱스가 없는 외래 키 열 셋, 겹치는 인덱스 둘(3단계에서 미룸), `holds(performance_id)`(10장 65), 내 예매 질의 계획(결제 표가 클 때).
- 대사 기준 30초(6.2 정리 4).
- 좌석 지도 15초 다시 읽기의 부하와 응답 크기(고정 배치와 상태를 나눠 보내기, ETag/304, 짧은 캐시). 대기열이 필요한지(2장, v1에서 뺐다).

**PR 순서.** 설계 → 부하 도구(API 손잡이와 `LOAD_STATS`, 템플릿 준비·대량 시드·세션·복제, k6 시나리오, DB·CPU 표본기, 실행기, C2 확인 SQL, `load/README.md`) → 기준선 측정과 요약 → 개선마다 PR(전후 표와 회귀 테스트) → 기록.

### 6.7 운영 (7단계)

**목표.** 8장 완료 기준은 C8(다른 DB로 복구하고 행 수를 대조한 기록)과 운영 문서다. 설명할 것은 "백업에서 무엇을 잃을 수 있나"와 "왜 앱 계정에서 DDL 권한을 빼나"다. 1장의 주장은 "PostgreSQL을 운영했다: 마이그레이션, 권한 분리, 백업·복구"다.

**이 PC라는 조건.**
- 사용자 PC의 PostgreSQL 서비스는 다시 띄우지 않고 설정도 바꾸지 않는다. 관리자 권한이 들고, `ALTER SYSTEM`도 쓰지 않는다. 그래서 그 서버에는 WAL 보관(`archive_mode`, 다시 띄워야 켜짐)을 켤 수 없다.
- 논리 백업은 그 서버에서 한다. 다른 DB로 복구하고 대조한다(C8).
- 물리 백업과 시점 복구는 리허설 클러스터에서 한다.
  - 리허설 클러스터: `initdb`로 저장소 밖 작업 디렉터리에 만들고, 다른 포트에서 127.0.0.1만 듣게 띄운다. 끝에 멈추고 지운다.
  - 데이터는 논리 백업을 복구해 같은 것을 싣는다.
  - 이유: 물리 백업에는 `REPLICATION` 권한이 필요하다. 그 권한은 클러스터의 모든 파일(다른 DB, `pg_authid`의 비밀번호 해시, 설정 파일)을 읽는다(리뷰 실험). 사용자 서버에 그런 role을 두지 않는다. 슈퍼유저 비밀번호도 물리 백업에는 쓰지 않게 된다.
  - WAL은 `pg_receivewal`(복제 연결로 WAL을 받아 두는 도구)로 받는다. 서버를 다시 띄우지 않아도 되는 방법이라 사용자 서버에도 그대로 쓸 수 있다. 리허설 클러스터에서도 `archive_mode`는 켜지 않는다.

**role 나누기.**

| role | 가진 것 | 쓰는 곳 |
|---|---|---|
| `seat_booking`(소유자, 지금 role 그대로) | DB와 표의 소유, `CREATEDB` | 마이그레이션, 시드, 테스트·E2E·부하 DB 만들기, 논리 백업 |
| `seat_booking_app`(새로) | `LOGIN`. 스키마 `public`의 `USAGE`, 표의 `SELECT·INSERT·UPDATE·DELETE`만 | 서버(`main.ts`), 관리자 승격 명령(`admin:promote`), 테스트가 부르는 앱 코드, 부하 표본기 |
| `seat_booking_backup`(리허설 클러스터에만) | `LOGIN REPLICATION`만 | 물리 백업, WAL 받기. 표는 읽지 못한다(리뷰 실험) |

- **role 만들기**: 슈퍼유저가 한 번 한다(클러스터에 하나). 방법은 README와 CI 두 job에 둔다.
  - `CREATE ROLE seat_booking_app LOGIN PASSWORD …`
  - `GRANT seat_booking_app TO seat_booking`: 소유자가 앱 연결을 보고 끊을 수 있게 한다.
    - 없으면 앱 연결이 남은 DB의 `DROP DATABASE … WITH (FORCE)`가 42501이다(리뷰 실험). 테스트·E2E·부하 DB를 지울 때 걸린다.
    - 소유자의 `pg_stat_activity`도 앱 세션의 `state`·`query`를 못 본다.
- **환경 변수**: `DATABASE_URL`은 앱 role, `DATABASE_OWNER_URL`은 소유자다. 다른 DB(테스트, E2E, 부하)도 같은 쌍을 `withDatabase`로 만든다.
  - 앱 role로 접속하는 것: 서버, `admin:promote`, E2E의 API, 부하 실행기의 API와 표본기(`pg_stat_activity`는 같은 role의 세션만 자세히 보인다).
  - 소유자로 접속하는 것: 마이그레이션, 시드(`TRUNCATE`), E2E 준비, 테스트 준비, 부하 템플릿·복제.
  - CI가 `DATABASE_OWNER_URL`을 읽는 파일이 이 목록뿐인지 본다(지금의 `X-User-Id` 검사처럼).
- **권한은 마이그레이션 0008이 준다**: 스키마 `public`의 `USAGE`, 지금 있는 모든 표의 DML, 그리고 소유자가 앞으로 `public`에 만드는 표에도 같은 권한이 붙게 하는 `ALTER DEFAULT PRIVILEGES IN SCHEMA public`.
  - 시퀀스 권한은 주지 않는다. 모든 id가 identity 열이고, identity 열 `INSERT`는 시퀀스 권한을 보지 않는다(리뷰 실험). `serial`이나 `nextval`을 쓰게 되면 그때 준다.
  - 기본 권한은 DB마다 있고, 그것을 실행한 role이 만드는 것에 걸린다. 템플릿 복제(`CREATE DATABASE … TEMPLATE`)가 함께 옮긴다(리뷰 실험: `WAL_LOG`, `FILE_COPY` 둘 다).
  - 그래서 실행기는 DB 소유자(슈퍼유저가 아닌)로만 돈다. 슈퍼유저가 돌리면 표의 주인과 기본 권한이 슈퍼유저에게 가서, 소유자가 뒤에 만든 표에 앱 권한이 없고 소유자는 표를 고치지 못한다.
  - 마이그레이션에 앱 role 이름이 들어가므로, 마이그레이션을 돌리는 모든 곳(로컬, 테스트, E2E, 부하 템플릿, CI)에 앱 role이 먼저 있어야 한다. 없으면 0008이 42704로 실패하고 되돌아간다.
  - 그룹 role(NOLOGIN)을 두지 않고 앱 role에 바로 준다. 클러스터 하나에 앱 로그인이 하나뿐이다. 같은 권한이 필요한 로그인이 둘이 되거나 환경마다 이름이 달라지면 마이그레이션 하나로 옮긴다.
- **앱 role이 못 하는 것과 하는 것**(리뷰 실험)
  - 42501로 실패한다: `CREATE`(표, 인덱스, 스키마, 함수), `ALTER`, `DROP`, `TRUNCATE`, role GRANT, `SET ROLE seat_booking`, `drizzle` 스키마(적용 기록) 읽기.
  - 오류 없이 아무것도 바꾸지 못한다
    - 표의 `GRANT`·`REVOKE`: 경고(01007·01006)만 내고, 권한(`relacl`)이 그대로다.
    - `ANALYZE`·`VACUUM`: 표마다 경고(01000)만 내고 건너뛴다. 테스트는 `pg_stat_user_tables.analyze_count`가 그대로인지 본다.
  - 된다
    - DML, identity 열 `INSERT`
    - 임시 표(`PUBLIC`의 `TEMPORARY`, 부하 데이터 테스트가 쓴다)
    - `LOCK TABLE`(UPDATE·DELETE 권한으로 된다. 앱 role도 표를 얼릴 수 있다. 테스트 둘이 쓴다)
  - 테스트는 메시지 글자가 아니라 `code`와 notice의 `code`·`severity`로 본다. 로컬 서버는 한국어, CI는 영어로 낸다.
- **테스트는 앱 role로 돈다**: global-setup이 소유자로 DB를 만들고 마이그레이션한 뒤, 테스트에는 같은 DB의 앱 role 주소를 준다. 그래서 앱 코드가 DML만으로 도는지 테스트마다 확인한다.
  - 소유자 주소를 따로 받는 것: 실행 계획 테스트(`ANALYZE`), 권한 테스트.
  - 잠금을 기다리는지 보는 `pg_stat_activity` 조회(테스트 10곳)는 앱 role 그대로 둔다.
- **비밀번호**: 사용자 서버의 슈퍼유저 비밀번호는 앱 role 만들기에만 쓴다. 도구에는 명령줄 인자가 아니라 `PGPASSWORD`로 넘기고, 출력하지 않는다.

**마이그레이션 실행기.** drizzle의 migrator는 남은 마이그레이션 전부를 한 트랜잭션에서 돌린다. 그래서 세 가지가 안 된다. `CREATE INDEX CONCURRENTLY`를 쓸 수 없다(트랜잭션 안에서 25001로 거부된다). 하나가 실패하면 앞의 마이그레이션까지 모두 되돌아간다. 마이그레이션 하나만 다시 할 수 없다. 그래서 실행기를 직접 둔다(`drizzle-kit migrate`·`push`는 쓰지 않는다).
- **drizzle과 같게 하는 것**(drizzle-orm 0.45 소스)
  - 파일과 journal(`drizzle-kit generate`가 만든 것)을 그대로 쓴다. journal 순서대로 읽고, `--> statement-breakpoint`로 나눈다.
  - 적용 기록 표: `drizzle` 스키마와 `__drizzle_migrations(id serial, hash text, created_at bigint)`를 같은 DDL로 만든다. 기록에는 파일의 sha256과 journal의 `when`을 넣는다(적용 시각이 아니다).
  - 남은 것을 고르는 규칙: created_at이 가장 큰 기록 한 행을 읽고, `when`이 그보다 큰(엄격히) 항목을 journal 순서대로 돌린다.
  - 그래서 drizzle로 마이그레이션한 개발·E2E·부하 DB를 그대로 이어서 쓴다(테스트).
- **drizzle에 더하는 검사**
  - 이 규칙은 마지막 한 행만 본다. 브랜치를 합치다 마지막 기록보다 작은 `when`이 생기면 그 마이그레이션을 조용히 영원히 건너뛴다.
  - 그래서 `when`이 마지막 기록 이하인 항목마다 같은 `when`의 기록이 있어야 하고, journal의 `when`은 늘어나기만 해야 한다. 아니면 DB에 손대기 전에 실패한다.
  - hash로는 아무것도 정하지 않는다. 파일 줄바꿈(Windows 체크아웃은 CRLF)에 따라 값이 달라진다. drizzle도 쓰기만 한다.
- **연결 하나**: `pg.Client` 하나로 하고, 끝에 닫은 뒤 돌아온다.
  - 템플릿 DB에 연결이 남으면 바로 뒤의 복제가 55006이다.
  - 시작할 때 접속한 role이 DB 소유자이고 슈퍼유저가 아닌지 본다(권한 절). 아니면 거절한다.
  - 세션 수준 advisory lock을 잡아 실행기 둘이 같은 DB에 끼어들지 않게 한다. `pg_try_advisory_lock`을 잡힐 때까지 잠깐씩 다시 묻는다.
    - `pg_advisory_lock`으로 막혀 기다리면, 그 문장이 쥔 스냅샷을 잠금을 쥔 쪽의 `CONCURRENTLY`가 기다린다. 그러면 둘이 서로를 기다려 교착이 된다(리뷰 실험: 기다리던 쪽이 40P01).
    - 같은 세션이 쥔 advisory lock은 `CONCURRENTLY`가 기다리지 않는다.
- **마이그레이션마다 트랜잭션 하나**: 전체를 하나로 묶지 않는다. 실패하면 그 마이그레이션만 되돌리고 멈춘다. 기록 INSERT도 같은 트랜잭션에 넣는다.
- **잠금 대기 한도**: advisory lock을 잡은 뒤 세션에 `SET lock_timeout = '1s'`를 한 번 건다. 그러면 트랜잭션 안과 밖 모두에 걸린다. 트랜잭션 밖에서는 `SET LOCAL`이 경고만 내고 걸리지 않는다(리뷰 실험).
  - 예외: `CONCURRENTLY` 문장은 한도 없이(`lock_timeout = 0`) 기다리고, 끝나면 1초로 되돌린다.
    - `CONCURRENTLY`가 쥐는 `SHARE UPDATE EXCLUSIVE`는 읽기·쓰기와 부딪히지 않아, 기다려도 잠금 줄을 만들지 않는다. 리뷰 실험에서 `CONCURRENTLY`가 기다리는 동안 같은 표의 앱 쓰기가 7ms에 끝났다.
    - 1초 한도면 같은 DB의 1초 넘는 트랜잭션·스냅샷(백업 등) 앞에서 매번 실패하고 INVALID 인덱스만 남긴다.
  - 이유: 오래 쥔 트랜잭션 뒤에서 `ACCESS EXCLUSIVE`를 기다리면, 뒤에 오는 모든 질의가 그 마이그레이션 뒤에 줄을 선다(잠금 줄). 리뷰 실험에서 기다리는 `ALTER` 뒤의 `SELECT`도 막혔다. 잠깐의 DDL이 서비스 전체를 멈춘다.
  - 1초인 이유: 앱의 쓰기 트랜잭션은 `lock_timeout` 3초다(10장 40). 마이그레이션의 한도가 같으면 그 뒤에 줄 선 앱 쓰기도 자기 한도에 닿아 500이 된다(리뷰 실험: 3초면 줄 선 쓰기가 2,910ms 만에 지나가 90ms 남았고, 1초면 모두 1초 안에 지나갔다).
  - 55P03(잠금 대기 초과)이나 40P01(교착)이면 다시 한다. 다시 할 때마다 줄이 다시 생기므로, 다시 하기 전에 2초, 4초, 8초를 쉬고 세 번까지 한다. 트랜잭션 마이그레이션은 트랜잭션 전체를, 트랜잭션 밖 마이그레이션은 파일 처음부터 다시 한다. 그 밖의 오류는 멈춘다.
  - 테스트: 다른 연결이 표를 쥔 동안 마이그레이션이 매달리지 않고 빨리 실패하고, 놓아 주면 다시 해서 된다.
- **트랜잭션 밖 마이그레이션**: 파일 첫 줄이 `-- 트랜잭션 밖`이면 트랜잭션 없이 문장을 하나씩 보낸다. 첫 줄은 BOM과 `\r`를 지우고 본다. 여러 문장을 한 번에 보내면 그것도 암묵적인 트랜잭션이라 `CONCURRENTLY`가 거부된다.
  - 규칙 1: 모든 문장은 다시 해도 같은 결과여야 한다. 중간에 실패하면 앞 문장은 커밋되고 기록은 남지 않아, 다음에 처음부터 다시 돈다.
  - 규칙 2: `CREATE INDEX CONCURRENTLY`는 `DROP INDEX CONCURRENTLY IF EXISTS` 다음에 쓴다. `CREATE INDEX CONCURRENTLY IF NOT EXISTS`는 쓰지 않는다. 실패로 남은 INVALID 인덱스를 있는 것으로 보고 건너뛴다(리뷰 실험).
  - 실패한 `CONCURRENTLY`는 INVALID 인덱스를 남긴다. 그 인덱스는 계획에는 쓰이지 않으면서 쓰기마다 유지될 수 있고, 유일 인덱스면 새 중복을 막는다(리뷰 실험).
    - 그래서 실행기는 트랜잭션 밖 마이그레이션마다(성공해도 실패해도) `public`의 INVALID 인덱스를 본다. 있으면 기록하지 않고, 그 이름과 지울 문장을 내고 실패한다.
    - 남이 지금 만드는 중인 인덱스(`pg_stat_progress_create_index`에 있는 것)는 뺀다. 그 도중에는 INVALID로 보인다.
  - 미리 훑기: DB에 손대기 전에 파일 전부를 본다. 그대로 두면 앞 마이그레이션이 이미 커밋된 뒤에 25001로 멈추기 때문이다.
    - 표시가 없는 파일의 주석 아닌 줄에 `CONCURRENTLY`가 있으면 거절한다. 블록 주석·문자열 안의 것도 걸리지만 거절하는 쪽이라 둔다.
    - 표시가 있는 파일의 한 조각에 문장이 둘이면 거절한다. `--> statement-breakpoint`를 빠뜨린 경우다.
  - 만드는 법: `drizzle-kit generate`는 `.concurrently()` 인덱스에 표시 없이 `CREATE INDEX CONCURRENTLY "…" ON …;`만 낸다. 그래서 `schema.ts`에는 보통 `index()`로 두고, 생성된 SQL에 표시, `DROP INDEX CONCURRENTLY IF EXISTS`, `CONCURRENTLY`를 손으로 넣는다. `schema.ts`에 `.concurrently()`를 두면, 나중에 그것을 빼기만 해도 drizzle-kit이 인덱스를 지우고 보통 `CREATE INDEX`로 다시 만드는 SQL을 낸다(리뷰 실험).
  - 같은 DB의 `REPEATABLE READ` 스냅샷(예: `pg_dump`)과 도는 중인 문장이 있으면 `CONCURRENTLY`는 그것이 끝나길 기다린다. 앱은 막지 않지만 마이그레이션이 그만큼 늦어지므로 긴 백업과 겹치지 않게 한다.
  - 연결이 끊기면 진행 중인 질의가 그 오류로 실패하고, 실행기는 그 오류를 낸다. `pg.Client`에 `error` 리스너가 없으면 프로세스가 통째로 죽는다(리뷰 실험).

**무중단 마이그레이션 예시.**
1. **인덱스 `holds(performance_id)`**: 관리자 판매 현황이 회차의 선점을 찾을 때 쓴다(10장 65). `CREATE INDEX CONCURRENTLY`로 쓰기를 막지 않고 만든다.
2. **열 `orders.paid_at`(결제 확정 시각) 더하기, expand → contract.**
   - 왜: 지금은 paid가 끝 상태라 paid 주문의 `updated_at`이 결제 확정 시각과 같다. 하지만 그것은 우연한 일치다. 이름이 뜻을 말하지 않고, 결제 뒤에 주문 행을 바꾸는 기능이 생기면 조용히 틀린다.
     - 운영 예시로 고른 것이고, 지금 기능에 꼭 필요해서가 아니다.
     - 주문 조회(OrderView)와 내 예매에 `paidAt`으로 내보낸다(API만, 화면은 그대로).
   - 순서(단계마다 따로 배포할 수 있게)
     1. nullable 열을 더한다. `ACCESS EXCLUSIVE`지만 표를 다시 쓰거나 훑지 않아 짧다. 그래도 잠금 줄을 만들 수 있어 `lock_timeout`이 필요하다.
     2. 앱이 결제 확정 때 쓴다.
     3. 옛 paid 주문을 1,000행씩 채운다. 값은 그 주문의 `updated_at`이다(paid가 끝 상태라 확정 시각과 같다). 취소된 주문은 null이다.
     4. `CHECK (status <> 'paid' OR paid_at IS NOT NULL) NOT VALID`를 건다. 이것도 `ACCESS EXCLUSIVE`지만 옛 행을 훑지 않아 짧다(리뷰 실험).
     5. `VALIDATE CONSTRAINT`로 옛 행을 검사한다. 쓰기를 막지 않는 잠금(`SHARE UPDATE EXCLUSIVE`)이다.
     6. 앱이 읽는다.
   - 3은 마이그레이션이 아니라 명령(`ops:backfill-paid-at`)이다. 한 트랜잭션에 전부 넣으면 오래 잠그고, 실패하면 되돌릴 것이 크다. 다시 해도 같은 결과다(`paid_at IS NULL`인 행만 채운다).
3. **잠금 리허설**: 막는 것과 막지 않는 것의 근거는 결정적인 잠금 시험으로 남긴다. 결과는 대기 시간과 오류 코드다.
   - 리뷰 실험에서 큰 표(`performance_seats` 40만 행)의 인덱스는 0.1초대에 만들어졌다. 이렇게 짧으면 부하 중 1초 지표로는 보통 `CREATE INDEX`와 `CONCURRENTLY`가 구별되지 않는다.
   - 시험 A, 인덱스: 보통 `CREATE INDEX`를 열린 트랜잭션 안에 두고(큰 표의 긴 빌드를 흉내 냄) 그 동안 `UPDATE performance_seats`(선점·취소·결제가 쓴다)가 기다리는지 본다. `CONCURRENTLY`가 기다리는 동안에는 같은 `UPDATE`가 바로 되는지 본다.
   - 시험 B, 잠금 줄: idle in transaction 보유자 뒤에 `ALTER TABLE orders ADD COLUMN`을 둔다. 그 뒤의 앱 쓰기와 읽기가 얼마나 기다리는지, 마이그레이션 `lock_timeout` 없음·1초에서 본다. `orders`는 S3가 반복마다 읽고 쓴다.
4. **부하 중 리허설(참고 숫자, 탐색 한 번)**: 6단계 도구로 부하 DB에 S3를 일정 도착률로 보내면서 시험 A와 B를 한 번씩 한다. 둘은 동시에 하지 않는다(`CONCURRENTLY`는 같은 DB의 다른 트랜잭션도 기다린다). API 1초 지표와 k6 요청별 기록으로 그 구간의 최댓값과 5xx를 본다.
   - 부하 템플릿은 role을 나눈 뒤 다시 만든다(권한이 DB 안에 있다).

**백업·복구 리허설.**
1. **논리 백업(C8 판정)**: 부하 템플릿(112MB)을 복제한 조용한 DB를 소유자로 `pg_dump -Fc` 하고, 빈 새 DB에 `pg_restore -j 4`로 복구한다.
   - 템플릿에서 바로 덤프하지 않는다. 템플릿은 부하 측정의 기준이고(통계·visibility map·토큰 파일이 짝), 연결이 하나라도 있으면 다른 복제가 막힌다. 그래서 순서는 이렇다: 템플릿 연결 0 확인 → 복제 → 복제본 checksum → 덤프 → 복구 → 복구본 checksum과 비교 → 지우기.
   - 합격: 표마다(`public`과 `drizzle`) 행 수와 내용 checksum이 같고, 시퀀스마다 `last_value`·`is_called`가 같다.
     - checksum은 `sum(hashtextextended(t::text, 0))`이라 행 순서와 상관없다.
     - `timestamptz`의 텍스트는 세션의 `TimeZone`·`DateStyle`에 따라 달라진다(리뷰 실험). 그래서 양쪽 모두 `SET timezone = 'UTC'; SET datestyle = 'ISO, YMD'`로 잰다.
   - 잃는 것을 확인한다
     - 백업 시작(스냅샷) 뒤의 쓰기는 없다. 우연한 시점에 기대지 않게 하려고, 열어 둔 `REPEATABLE READ` 트랜잭션에서 `pg_export_snapshot()`을 한다. 다른 연결에서 행 하나를 넣고 하나를 고친 뒤 `pg_dump --snapshot`으로 덤프한다. 복구본에 둘 다 없어야 한다.
     - 시퀀스는 스냅샷을 따르지 않고 덤프하는 순간의 값이다(리뷰 실험). 그래서 시퀀스 비교는 조용한 DB에서만 하고, 위 시험에서는 뺀다.
     - 통계(`pg_statistic`)는 기본값으로는 덤프에 담기지 않는다. 18부터 `--statistics`로 담을 수 있다. 복구본의 `pg_stats` 행 수(0)와 좌석 지도의 추정 행 수 대 실제를 보고, `ANALYZE` 뒤 돌아오는지 본다. 계획 모양은 같을 수 있다(리뷰 실험).
     - 복구본은 템플릿의 `autovacuum_enabled = false`를 이어받는다. 운영 DB 복구라면 켜야 한다.
     - role과 비밀번호는 DB 백업에 없다. 0008 뒤에는 대상 클러스터에 앱 role이 먼저 있어야 한다. 없으면 `pg_restore`가 권한 문장에서 실패한다(데이터는 들어간다). 비밀번호까지 받으려면 슈퍼유저의 `pg_dumpall --globals-only`가 필요하다.
   - 숫자: 덤프 크기, 덤프 시간, 복구 시간(RTO의 한 부분).
2. **물리 백업과 시점 복구(리허설 클러스터, 참고, 시간 제한)**
   - 준비
     - 리허설 클러스터를 만들고, 소유자·앱 role을 만든 뒤 논리 백업을 복구한다.
     - 백업 role(`LOGIN REPLICATION`)을 만든다.
     - 표시 행 쓰기와 `pg_switch_wal()`은 그 클러스터의 슈퍼유저가 한다.
   - 순서
     1. `pg_receivewal`(영구 슬롯 없이)로 WAL을 받기 시작한다. 받기를 백업보다 먼저 시작해야 빈 구간이 없다.
     2. 백업 role로 `pg_basebackup -X stream`을 받는다. 바로 `pg_verifybackup`으로 백업 목록(manifest)을 확인한다. 복구에 쓴 디렉터리는 파일이 바뀌어 검증에 실패하므로, 손대지 않은 백업에서 하고 복구는 사본으로 한다.
     3. 표시 행을 넣고 커밋한 뒤, 따로 `select clock_timestamp()`로 시각 T를 적는다.
        - 숫자 오프셋(`+09`)을 붙인 그대로 쓴다. 오프셋이 없으면 복구 서버의 TimeZone으로 읽는다.
        - 표시 행의 트랜잭션 안의 `now()`는 쓰지 않는다. 시작 시각이라 커밋보다 앞이다.
     4. 1초 넘게 기다려 `pg_switch_wal()`을 하고, T 뒤에 또 쓴 다음 `pg_switch_wal()`을 한 번 더 한다. 마지막 쓰기가 든 WAL 파일이 `.partial` 없이 받아졌는지 본다. `restore_command`는 `.partial`을 찾지 않는다.
     5. 백업 사본 둘을 복구한다. 하나는 목표 없이(모든 행), 하나는 `recovery_target_time = T`(T 앞의 행만)다. 짝으로 보여야 판정이 된다.
        - 설정: `recovery_target_action = 'pause'`로 두고 읽기로 조회한 뒤 멈춘다.
        - 포트와 `listen_addresses`를 늘 덮어쓴다. 백업에 원본의 설정 파일이 들어 있다.
   - 판정은 `pg_ctl`의 성공이 아니라 로그로 한다. 리뷰 실험에서 아래 두 경우 모두 행을 잃었는데 겉으로는 성공이었다.
     - WAL이 모자라 로그에 FATAL이 있어도 `pg_ctl -w start`는 성공으로 돌아왔다(hot standby가 연결을 받는 순간).
     - Windows의 `restore_command`가 틀리면 목표 없는 복구는 백업 시점에서 조용히 끝났다. `copy`에는 백슬래시를 두 번 적은 경로를 써야 하고, 슬래시는 실패한다.
     - 그래서 이렇게 본다.
       - 로그에 `recovery stopping before commit`이 있고, `restored log file` 줄 수가 맞는지 본다.
       - `pg_is_in_recovery()`, `pg_get_wal_replay_pause_state()`를 본다.
       - 목표가 있는 복구는 WAL이 모자라면 FATAL을 낸다.
   - 영구 슬롯은 쓰지 않는다. 지우지 못하면 WAL이 끝없이 쌓인다(`max_slot_wal_keep_size` 기본 -1). `pg_basebackup -X stream`의 임시 슬롯은 연결이 끝나면 사라진다.
   - 슬롯 없이 받을 때 빈 구간은 받기가 끊긴 동안 서버가 WAL을 지울 때만 생긴다. 다시 붙으면 "already been removed"로 드러난다.
   - 리허설 클러스터와 `pg_receivewal`은 끝에 반드시 멈추고 지운다. 백업 파일에는 비밀번호 해시와 세션 토큰 해시가 있다.
   - 잘 되지 않으면 논리 백업과 RPO 설명만 남긴다.
3. **잃을 수 있는 것 정리(운영 문서)**
   - 시점: 논리 백업은 스냅샷 뒤의 모든 쓰기를 잃는다(RPO = 백업 간격). 물리 백업과 WAL은 받지 못한 WAL(마지막 `.partial`, 받기의 지연)만 잃는다. 같은 PC·같은 디스크의 백업은 재해용이 아니다.
   - 되감기는 것
     - 세션 표: 백업 뒤의 로그아웃과 관리자 강등이 무효가 된다.
     - 시퀀스: 결제 id가 결제사 쪽 멱등 키다(10장 25). 옛 백업으로 복구하면 새 결제가 결제사가 이미 아는 id를 다시 받아, 결제사가 옛 결제 결과를 돌려준다. 복구 뒤 시퀀스를 넉넉히 앞으로 옮긴다.
     - 결제: 대사는 DB의 `requested` 결제에서 시작하므로, 복구로 사라진 결제는 대사가 보지 못한다. 결제사 쪽 기록과 대조해야 한다.
   - DB 백업 밖의 것
     - role·비밀번호
     - 서버 설정(`postgresql.conf`, `pg_hba.conf`). 물리 백업에는 들어 있다.
     - DB 수준 설정과 권한(`ALTER DATABASE … SET`, `pg_dump --create` 없이는 빠진다)
     - `.env`, 화면 `sessionStorage`의 멱등 키
     - 누적 통계(`pg_stat_*`), 실행 계획 통계(기본값), visibility map·동결 상태

**운영 문서.** `docs/OPERATIONS.md`에 둔다.
- role 만들기와 권한
- 마이그레이션 규칙: 트랜잭션 밖, `lock_timeout`, expand → contract
- 백업·복구 절차와 리허설 숫자
- 잃을 수 있는 것

**PR 순서.** 설계 → 마이그레이션 실행기 → role 나누기 → 무중단 마이그레이션 예시와 잠금·부하 중 리허설 → 백업·복구 리허설(논리 먼저, 물리·시점 복구는 시간 제한) → 기록.

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
66. 회차·작품은 지울 수 없으므로 회차 등록이 실수를 먼저 막는다. 판매 종료가 이미 지난 회차(DB 시계)와 같은 제목의 새 작품을 422로 거절하고(같은 제목이면 그 작품 id를 준다), 작품은 id나 새 제목 중 하나만 받는다(둘 다 오면 400, 폼의 select 값이 문자열이라 섞여 오면 새 작품이 생길 수 있었다). 같은 제목 확인은 잠그지 않아 동시 등록에서는 같은 제목이 둘 생길 수 있다(드물어 받아들인다). 처음에는 지난 판매 종료를 거절하지 않기로 했다가 리뷰(L3)로 바꿨다. 마이그레이션 0006(`unique(venue_id, starts_at)`)은 같은 공연장·같은 시각의 회차가 이미 둘 이상 있으면 실패한다(샘플 시드에는 없다). (AI 판단, 회차 등록 PR)

5단계에서 정한 것(2026-10-23, 사용자가 4단계 검토 뒤 같은 방식으로 진행하기로 함):

67. 화면 스택은 React 19, Vite 8, TanStack Query 5, React Router 8, CSS Modules다. UI 라이브러리를 쓰지 않고 좌석 지도와 상태 문구를 직접 만든다. 버전은 나온 지 2주가 지난 것 중 최신이다(새로 나온 판의 공급망 위험을 피한다. 루트에 이미 있던 vitest는 예외). jsdom은 이 PC의 Node 24.12를 받는 29.x다. (AI 판단, 실현성 리뷰 L1)
68. 서버 상태는 TanStack Query 캐시에만 두고 낙관적 갱신을 하지 않는다. 변이마다 무효로 할 키를 정하고, 서버가 바꾸는 것(결제 확정, 만료)은 주문 폴링이 상태 변화를 보면 무효로 한다. 조회는 4xx를 다시 하지 않고 변이는 TanStack의 재시도를 끈다. 화면 상태는 고른 좌석·결제 상황·멱등 키·시계 차이뿐이다. (AI 판단, 화면 리뷰 M3·L1)
69. 만료는 화면이 정하지 않는다. 결제 마감이 지나면 결제 버튼을 끄고, 주문의 다시 읽기 간격을 응답으로 정해(결제 확인 중 1초→5초, 마감 뒤 2초, 그 밖에는 멈춤) 서버가 주는 상태를 보인다. 6.2의 표는 `orderScreen(order, now)` 하나로 만들고 표에 빠진 조합(마감 뒤 pending, pending + 환불, paid + 환불 지연, 끝나지 않은 cancelled + requested)을 더했다. (AI 판단, 화면 리뷰 M2·M3)
70. `GET /orders`는 보이는 상태가 pending·paid인 주문과, failed가 아닌 결제가 붙은 cancelled 주문을 최근 것부터 100개(`hasMore`) 한 스냅샷에서 준다. 주문 하나는 `OrderView`에서 상태 함수가 보는 필드와 회차 요약·좌석 수·만든 시각이다(주문 화면과 같은 함수를 쓴다). failed만 붙은 취소는 돈이 움직이지 않아 넣지 않는다. `orders(user_id, created_at)` 인덱스를 더한다. (AI 판단, 10장 41, 화면 리뷰 M4·실현성 리뷰 M1·M2)
71. 개발 시드(`db:seed`)는 모든 시각을 하루의 배수만큼 옮겨 가장 이른 판매 시작이 지난 24시간 안에 오게 한다. 고정 날짜면 판매 중인 회차가 없어 화면을 쓸 수 없다. 재시드는 `restart identity`를 하지 않는다(켜 둔 API의 가짜 결제사 메모리·탭의 멱등 키와 id가 겹친다). (AI 판단, 실현성 리뷰 L2·M3)
72. E2E는 하나다(가입 → 선점 → 결제 → 내 예매). 다른 DB(이름은 준비 명령이 정하고 그 밖은 거절)와 포트를 쓰고, 주소는 모두 `127.0.0.1`이다. API에는 `webServer.env`로 읽는 키 여덟 개를 모두 준다(명령줄 `VAR=x`는 Windows cmd에서 안 되고, `--env-file`은 넘기지 않은 키를 `.env`에서 채운다). `npm test`와 CI의 기존 job에 넣지 않고 따로 돈다. (AI 판단, 실현성 리뷰 H1·M4)
73. 로그인 전에도 공연 목록과 좌석 지도를 쓴다. `GET /auth/me`의 401은 로그인 전이고, 다른 경로의 401은 세션 만료로 보아 캐시를 지우되 로그인을 요구하는 화면에서만 로그인 화면으로 보낸다. 가입·로그인 폼의 오류는 폼에 보인다. 403 `FORBIDDEN`이면 권한 없음을 보이고 내 정보를 다시 읽는다. 열린 리다이렉트를 막게 `next`는 `/`로 시작하고 `//`가 아닐 때만 받는다. (AI 판단, 화면 리뷰 H1·L2)
74. 선점은 멱등 키가 없으므로, 선점이 실패하면(네트워크·5xx·`SEAT_UNAVAILABLE`·`HOLD_LIMIT`) 먼저 `/me`를 다시 읽어 실패한 좌석이 내 선점인지 본다. 내 것이면 그 선점으로 가고, 아니면 다른 사람이 가져갔다고 알린다. 좌석 지도는 내 선점을 따로 그리고 이어서 할 일(주문 만들기·결제)을 띠로 보인다. (AI 판단, 화면 리뷰 H2)
75. 시계 차이는 API 클라이언트가 응답을 받을 때만, 왕복의 가운데로 잰다. 왕복이 더 짧거나 1분이 지난 표본만 받고, `Idempotent-Replayed` 응답은 버린다(처음 응답의 옛 시각이다). (AI 판단, 화면 리뷰 M1)
76. 멱등 키는 보내기 전에 `sessionStorage`에 `{ key, body, attempt }`로 쓴다. 같은 시도의 재시도는 저장한 본문을 그대로, `Retry-After` 뒤 세 번까지 보내고 그 뒤로는 주문 폴링에 맡긴다. 키가 없으면(다른 탭) 새 키로 보내고 중복은 서버가 막는다. (AI 판단, 화면 리뷰 M5)
77. 비밀번호 규칙(NFKC 뒤 8~128자)을 `packages/shared`로 옮겨 가입 폼과 API가 같은 함수로 검증한다. (AI 판단, 화면 리뷰 L5)

6단계에서 정한 것(2026-10-26, 사용자가 같은 방식으로 진행하기로 함):

78. 6단계는 결과가 아니라 재는 방법을 먼저 정한다. 한 PC라 같은 PC의 전후 비교만 쓴다. 반복은 두 층이다. 탐색은 조건마다 한 번 돌리고, 표에 올릴 비교(C7 전후, 고른 풀 크기와 이웃)만 다섯 번씩 번갈아(ABAB) 돌려 회차 값을 모두 적는다. 범위가 겹치지 않을 때만 나아졌다고 쓴다. 모든 조건을 다섯 번씩 돌리면 기계 시간이 하루를 넘는다. C2는 모든 회차가 통과해야 한다. (AI 판단, 방법론 리뷰 M7·M5)
79. 부하 도구는 k6 v2.3.0이다. 체크섬을 확인한 zip을 저장소 밖에 둔다(winget은 2.2.0까지라 쓰지 않는다). 부하용 DB는 템플릿 `seat_booking_load_template`에 한 번 시드하고 `VACUUM (FREEZE, ANALYZE)`한 뒤, 회차마다 `STRATEGY FILE_COPY`로 복제한다. 포트는 3201, 주소는 `127.0.0.1`이고 CI에는 넣지 않는다. `pg_stat_statements`와 `auto_explain` 대신 `pg_stat_activity` 0.2초 표본, 앞뒤 통계, `EXPLAIN (ANALYZE, BUFFERS)`를 쓴다. Node는 P코어, k6는 E코어에 묶는다. 관리자 권한이 드는 것(PostgreSQL 설정, 서비스 affinity, 전원, Defender)은 바꾸지 않고 적는다. (AI 판단, 방법론 리뷰 M7·L, 실현성 리뷰 M3·M5·L3·L5)
80. API에 측정용 손잡이 `DB_POOL_MAX`·`DB_CONNECT_TIMEOUT_MS`·`LOG_LEVEL`·`LOAD_STATS`를 더한다. 기본값은 지금과 같고, 부하는 `LOG_LEVEL=warn`으로 잰다. `LOAD_STATS`는 로그가 아닌 파일에 1초마다 풀(연결 대기 시간 포함), Node(이벤트 루프 지연·사용률, CPU, GC), 경로별(처리 시간, 상태, SQLSTATE), 정리 작업 지표를 쓴다. Windows에서 강제로 끝내도 남게, 끝에 한 번 쓰는 값에 기대지 않는다. 풀에 `application_name`을 주고, IPC로 띄운 경우에만 `shutdown` 메시지로 앱을 닫는다. (AI 판단, 방법론 리뷰 H1·M4·L, 실현성 리뷰 H2·M1·L1·L2)
81. 부하 데이터는 SQL로 템플릿에 한 번 넣는다. 2,000석 공연장 하나와 회차 200개(`performance_seats` 40만 행)다. S1 회차는 1,000석을 선점·주문·결제·표까지 갖춰 미리 판다(N=1,000). S3 회차 99개는 재고다. 나머지 지난 회차 100개에는 끝난 상태만 넣은 지난 주문·결제 약 5만 건이 있다. 사용자 5,000명과 세션을 넣는다(argon2를 거치지 않는다). 복제한 뒤 S1 회차의 `sales_open_at`만 T0로 바꾼다. (AI 판단, 실현성 리뷰 M2·L6)
82. C7과 1장의 이력서 주장을 "측정이 가리킨 병목을 고친다"로 고친다. 리뷰가 잰 좌석 지도는 DB보다 Node CPU에서 먼저 막혔다(요청당 약 5ms, 그 가운데 pg 결과 파싱·매핑이 약 3ms). "인덱스 개선 전후"로 정해 두면 측정과 상관없이 인덱스를 더하게 된다. 3장 C7은 "p95를 개선 전후로 잰다(숫자). 개선은 측정이 가리킨 병목"으로, 1장은 "측정으로 병목을 찾아 고쳐 응답 시간을 줄였다"로 바꾼다. 측정 뒤 숫자로 다시 고쳤다("좌석 지도의 꺾이는 점을 초당 250건에서 약 1,000건으로", 10장 88). (AI 판단, 방법론 리뷰 H1, 실현성 리뷰 H2)
83. C7의 기준 숫자는 이렇게 잰다. 먼저 S2만으로 꺾이는 점(p95 100ms 미만과 `dropped_iterations` 0을 지키는 가장 큰 도착률)을 찾는다. S2와 S3 흐름을 합쳐 기준선의 이벤트 루프 사용률이 0.7쯤 되는 도착률(S2 초당 100건 + S3 초당 50반복)로 함께 보내며, 예열 30초를 빼고 3분을 잰다. 처음에는 "S2 꺾이는 점의 70% + S3 최대의 절반"이었으나, 둘이 Node 한 스레드를 나눠 써 기준선에서 합이 1을 넘었다(기준선 측정 뒤 고침). S1과 함께 재지 않는다. 몰림이 끝나는 시점이 개선에 따라 달라져 p95가 움직인다. 꺾이는 점도 개선 전후로 적는다. (AI 판단, 방법론 리뷰 H2, 실현성 리뷰 H2)
84. 풀 크기는 S3(좌석 경합 없음)로 정한다. 풀 크기 5·10·20·40에서 도착률을 단계로 올려, 쓰기 경로별 p95 300ms 미만·예상하지 않은 오류 0.1% 미만·`dropped_iterations` 0을 지키는 가장 큰 도착률로 견준다. 가장 좋은 값의 95% 안에 드는 가장 작은 풀을 고른다. 경합이 있는 S1 hot set에서도 10과 20을 견준다. (AI 판단, 방법론 리뷰 H3)
85. S1은 판매 전 60초 동안 각자 지도를 읽어 연결을 연 뒤, T0에 0~1초 안에 첫 선점을 보낸다(5,000개의 첫 연결이 한꺼번에 열리면 이 PC에서 84%가 거절된다). 좌석은 균일·hot set 두 가지로 고르고, 결제 시나리오를 섞고, 10%는 결제하지 않고 떠난다. p95 대신 매진까지의 시간, 첫 선점 응답 분포, 시도별 성공, 코드별 오류를 보고한다. C2는 (a)~(f)를 모든 회차에서 확인한다. (AI 판단, 방법론 리뷰 M5·M6, 실현성 리뷰 H1·L7)
86. 부하 DB의 표는 autovacuum을 끈다(템플릿에서 `autovacuum_enabled = false`, 복제본이 이어받는다). 복제본은 누적 통계가 0부터라, 긴 S3가 좌석 행을 10만 번 넘게 바꾸면 측정 중간에 autoanalyze가 돈다. "돌면 무효"로 두면 긴 회차가 모두 무효가 되고, 그대로 두면 회차마다 다른 때 돌아 잡음이다. 끝날 때 표마다 dead tuple 수를 적는다. 운영 DB에서는 켜 둔다. (AI 판단, 템플릿을 만들어 본 뒤)
87. 기본 풀 크기는 10을 유지한다. 기준선 S3에서 풀 5~40은 모두 같은 곳(초당 200반복)에서 Node 때문에 멈췄고, 규칙은 5를 골랐다. 확인 회차에서 풀 5가 다섯 쌍 모두 빨랐지만 범위가 맞닿아 주장하지 않는다. 좌석 지도 개선 뒤 S2 1,000건에서 DB에 동시에 4개 넘게 들어가 풀 5는 줄이 생긴다(p95 11.5 → 24.5ms). 84에서 정한 "경합이 있는 S1 hot set에서 풀 10과 20 견주기"는 하지 않았다. S3에서 풀 크기가 한계가 아님을 먼저 보았고, S1 hot set은 풀 10(3회)과 풀 5(1회)로만 돌렸다. 둘 다 C2를 통과했고 몰림 구간에서는 모두 Node가 포화였다. (AI 판단, 측정 뒤)
88. 좌석 지도 JSON은 PostgreSQL이 만든다(`json_agg`, Node는 글자를 그대로 보낸다). 측정이 가리킨 병목은 Node 한 스레드가 2,000행을 객체로 받아 다시 JSON으로 만드는 일이었다(일한 시간의 약 70%). 요청 하나에 Node 3.9 → 1.1ms, postgres 2.0 → 3.5ms(합 5.9 → 4.6ms)로 일이 DB로 옮겨 간다. API 하나·DB 하나에서는 맞는 거래다(꺾이는 점 250 → 약 1,000). API를 여러 대로 늘리면 Node에서 매핑·검증·직렬화를 덜어 내는 방법(행을 배열로 받아 직접 글자를 만들기)으로 바꾼다. (AI 판단, 측정 뒤)
89. 앞 단계에서 미룬 것은 측정 뒤 이렇게 정한다.
    - 바꾸지 않는다: 시간 제한 500(10장 40, 모든 회차에서 57014·55P03 0건), Retry-After 1초(10장 45), `connectionTimeoutMillis` 한도 없음(포화 때 기다림의 원인이 Node), 선점 경로 `lock_timeout` 없음(잠금을 기다리는 연결 평균 0.2개 미만), 외래 키·겹치는 인덱스·`holds(performance_id)`(큰 표 순차 탐색 없음, 판매 현황은 재지 않음), 대사 30초, 지도 15초 다시 읽기.
    - 대기열은 v1 밖에 둔다. S1에서 T0 뒤 약 15초 Node가 포화하는 것을 적어 둔다.
    (AI 판단, 측정 뒤)
90. C2 판정에서 설계한 503(`Retry-After`, 결제사 호출 시간 초과·비밀번호 해시가 밀림)은 실패로 세지 않고 따로 센다. S1 몰림에서는 k6도 포화하므로 S1의 지연은 전후 비교에 쓰지 않고 정확성만 판정한다. (AI 판단, 기준선 측정 뒤)

7단계에서 정한 것(2026-10-27, 사용자가 같은 방식으로 진행하기로 함):

91. 사용자 서버의 role은 둘이다. 소유자 `seat_booking`(지금 role 그대로, `CREATEDB`)과 앱 `seat_booking_app`(DML만)이다. 슈퍼유저가 앱 role을 만들고 `GRANT seat_booking_app TO seat_booking`을 한다. 이것이 없으면 소유자가 앱 연결이 남은 DB를 `DROP DATABASE … WITH (FORCE)`로 지우지 못하고(42501), `pg_stat_activity`로 앱 세션을 보지 못한다. 환경 변수는 `DATABASE_URL`(앱)과 `DATABASE_OWNER_URL`(소유자)의 쌍이다. 서버·관리자 승격·E2E와 부하의 API·부하 표본기는 앱 role, 마이그레이션·시드·DB 만들기·논리 백업은 소유자다. 슈퍼유저 비밀번호는 앱 role 만들기에만 쓰고 `PGPASSWORD`로 넘긴다. (AI 판단, 리뷰 반영)
92. 권한은 마이그레이션 0008이 앱 role에 바로 준다: `public`의 `USAGE`, 모든 표의 DML, 소유자가 앞으로 `public`에 만드는 표에 같은 권한(`ALTER DEFAULT PRIVILEGES IN SCHEMA public`). 시퀀스 권한은 주지 않는다(모든 id가 identity 열이고, identity `INSERT`는 시퀀스 권한을 보지 않는다). 마이그레이션을 돌리는 모든 환경에 앱 role이 먼저 있어야 한다. 그룹 role은 두지 않는다(앱 로그인이 하나뿐). 앱 role에게 DDL·`TRUNCATE`·role GRANT는 42501이고, 표의 GRANT·`ANALYZE`·`VACUUM`은 경고만 내고 아무것도 바꾸지 못한다. 임시 표와 `LOCK TABLE`은 된다. (AI 판단, 리뷰 반영)
93. 테스트는 앱 role로 돈다. global-setup이 소유자로 DB를 만들고 마이그레이션한 뒤 앱 role 주소를 준다. 소유자 주소는 실행 계획 테스트(`ANALYZE`)와 권한 테스트만 받는다. 테스트는 오류 메시지가 아니라 코드로 본다(로컬은 한국어, CI는 영어). (AI 판단)
94. 마이그레이션 실행기를 직접 둔다. drizzle migrator는 전부를 한 트랜잭션에서 돌려 `CONCURRENTLY`를 쓸 수 없고, 하나가 실패하면 앞의 것까지 되돌아가며, 하나만 다시 할 수 없다. drizzle의 파일·journal·적용 기록 표·남은 것을 고르는 규칙은 그대로 따른다. 거기에 journal과 기록이 어긋나면(마지막 기록보다 작은 `when`이 기록 없이 있으면) 실패하는 검사를 더한다. hash로는 아무것도 정하지 않는다(줄바꿈에 따라 달라진다). 연결 하나로 하고, 그 연결의 role이 DB 소유자이며 슈퍼유저가 아닌지 먼저 본다. 세션 advisory lock은 `pg_try_advisory_lock`을 다시 물어 잡는다(막혀 기다리면 그 스냅샷 때문에 `CONCURRENTLY`와 교착). 마이그레이션마다 트랜잭션을 하나씩 두고, 세션에 `lock_timeout = '1s'`를 건다. 앱 쓰기의 잠금 한도(3초)보다 짧아야 그 뒤에 줄 선 앱 쓰기가 자기 한도에 닿지 않는다. `CONCURRENTLY` 문장만 한도 없이 기다린다(쓰기와 부딪히지 않아 잠금 줄을 만들지 않는다). 55P03·40P01이면 2·4·8초를 쉬고 세 번까지 다시 한다. 연결이 끊겨도 프로세스를 죽이지 않고 그 오류를 낸다. (AI 판단, 리뷰 반영)
95. 파일 첫 줄이 `-- 트랜잭션 밖`인 마이그레이션은 트랜잭션 없이 문장을 하나씩 보내고, 다시 할 때는 파일 처음부터 한다. 모든 문장은 다시 해도 같은 결과여야 한다. `CREATE INDEX CONCURRENTLY`는 `DROP INDEX CONCURRENTLY IF EXISTS` 다음에 쓰고, `IF NOT EXISTS`는 쓰지 않는다(실패로 남은 INVALID 인덱스를 건너뛴다). 실행기는 트랜잭션 밖 마이그레이션마다 INVALID 인덱스(남이 만드는 중인 것은 뺌)를 보고, 있으면 기록하지 않고 지울 문장을 내고 실패한다. DB에 손대기 전에, 표시 없는 파일에 `CONCURRENTLY`가 있거나 표시 있는 파일의 한 조각에 문장이 둘이면 거절한다. `schema.ts`에는 보통 `index()`로 두고 생성된 SQL을 손으로 고친다. (AI 판단, 리뷰 반영)
96. 무중단 마이그레이션 예시는 둘이다. 하나는 `holds(performance_id)`를 `CONCURRENTLY`로 만드는 것이다(관리자 판매 현황, 10장 65). 다른 하나는 `orders.paid_at`(결제 확정 시각)을 expand → contract로 더하는 것이다: nullable 열 → 앱이 씀 → 옛 paid 주문을 1,000행씩 채우는 명령 → `CHECK … NOT VALID` → `VALIDATE` → 읽기(`OrderView`·내 예매의 `paidAt`). 지금은 paid가 끝 상태라 `updated_at`과 같은데, 그것은 우연한 일치다. 운영 예시로 고른 것이다. 막는 것과 막지 않는 것의 근거는 결정적인 잠금 시험(대기 시간과 오류 코드)으로 남긴다. 큰 표의 인덱스도 0.1초대라 부하 중 1초 지표로는 구별되지 않기 때문이다. 부하 중 리허설은 탐색 한 번의 참고 숫자다. (AI 판단, 리뷰 반영)
97. C8 합격은 논리 백업으로 판정한다. 부하 템플릿을 복제한 조용한 DB를 소유자로 `pg_dump -Fc` 하고, 새 DB에 `pg_restore -j 4`로 복구한다. 표마다(`public`, `drizzle`) 행 수와 checksum(`sum(hashtextextended(t::text, 0))`, `TimeZone` UTC·`DateStyle` ISO로 잼)이 같고, 시퀀스마다 `last_value`·`is_called`가 같아야 한다. 템플릿에서 바로 덤프하지 않는다. "스냅샷 뒤의 쓰기가 없다"는 `pg_export_snapshot()`과 `pg_dump --snapshot`으로 결정적으로 보인다(시퀀스는 스냅샷을 따르지 않아 뺀다). 통계는 18의 기본값으로는 담기지 않는다(`--statistics`로 담을 수 있다). 숫자는 덤프 크기·덤프 시간·복구 시간이다. (AI 판단, 리뷰 반영)
98. 물리 백업과 시점 복구는 리허설 클러스터에서 하는 참고이고, 시간을 정해 둔다. 리허설 클러스터는 `initdb`로 만들고, 다른 포트에서 127.0.0.1만 듣게 띄운다. 사용자 서버에는 `REPLICATION` role을 두지 않는다. 그 권한은 클러스터의 모든 파일(비밀번호 해시 포함)을 읽는다. 서비스 설정을 바꾸지 않는다는 조건은 그대로 두고, WAL은 영구 슬롯 없는 `pg_receivewal`로 받는다. 판정은 `pg_ctl`의 성공이 아니라 로그(`recovery stopping before commit`)로 한다. 목표 없는 복구와 목표 T 복구를 짝으로 본다. T는 오프셋을 붙인 `clock_timestamp()`이고, 마지막 쓰기 뒤에도 `pg_switch_wal()`을 한다. 리뷰 실험에서 WAL이 모자라거나 Windows `restore_command`가 틀린 경우 모두 오류 없이 행을 잃었다. 끝에 클러스터와 받기를 반드시 멈추고 지운다. (AI 판단, 리뷰 반영)
