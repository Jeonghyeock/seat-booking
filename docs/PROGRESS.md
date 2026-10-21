# 진행 기록

단계마다 만든 것, 결과, 배운 것, 못 한 것을 남긴다. 요약은 [README](../README.md), 설계는 [DESIGN.md](DESIGN.md)에 있다.

## 0단계 — 설치와 뼈대 (완료, 2026-10-21)

- 설계를 확정했다(DESIGN 10장 권장안). 초안과 바꾼 것은 npm workspaces, TypeScript 6.0.x 고정, 앱 전용 DB role 세 가지다(DESIGN 10장 8~10).
- PostgreSQL 18.6을 winget으로 설치했다. 서버와 명령줄 도구만 넣었다(pgAdmin·StackBuilder 제외). 서비스 이름은 `postgresql-x64-18`이다.
- 앱 role `seat_booking`은 슈퍼유저가 아니다. 테스트 DB를 복제하려고 `CREATEDB`만 줬다. 테이블 소유자도 이 role이다. CI도 같은 role을 만들어 그 role로 마이그레이션과 테스트를 돌린다.

| PR | 내용 |
|---|---|
| [#1](https://github.com/Jeonghyeock/seat-booking/pull/1) | npm workspaces, `apps/api`(Fastify, `GET /health`), `PORT` 환경 변수(기본 3001), 기본 CI |
| [#2](https://github.com/Jeonghyeock/seat-booking/pull/2) | Drizzle 스키마와 첫 마이그레이션(`venues`, `seats`), 마이그레이션 실행기, 템플릿 DB를 복제한 테스트 DB, CI에 `postgres:18` 서비스 |

확인한 것:
- 테스트 4개가 로컬 PostgreSQL 18.6과 CI의 `postgres:18`에서 통과한다.
- `/health`는 DB에 닿으면 200, 닿지 않으면 503 `{ status: "unavailable" }`이다. pg 오류 내용은 응답에 싣지 않는다.
- 변이 시험 두 가지:
  - 마이그레이션에서 `seats`의 unique 제약을 빼면 "같은 자리를 두 번 넣으면 23505" 테스트가 실패한다.
  - 테스트 준비 구간의 advisory lock을 빼고 테스트 3개를 동시에 3번 돌리면 9번 중 6번 실패한다(23505). lock이 있으면 0번이다.

리뷰에서 나와 고친 것(#1·#2 댓글의 표):
- 같은 서버에서 테스트를 동시에 돌리면 고정 이름의 템플릿을 서로 지웠다 → 준비 구간을 advisory lock으로 감쌌다.
- CI가 슈퍼유저로 돌아 앱 role 경로를 확인하지 않았다 → CI에서도 앱 role을 만들어 쓴다.
- 쌓은 PR 앞의 두 개가 CI 없이 머지될 뻔했다 → 첫 PR에 기본 CI를 넣었다.

이 PC와 GitHub에서 걸린 것:
- 첫 설치는 실패했다. PowerShell 5.1에 없는 `String.Split(string, int)`을 써서 비밀번호가 빈 값으로 넘어갔다. 비밀번호를 읽은 뒤 길이를 확인하고 다시 설치했다.
- DB 정렬 규칙이 Windows 로캘(`Korean_Korea.949`)이다. CI의 Linux와 문자열 정렬 순서가 다를 수 있어, 테스트는 문자열 정렬 순서에 기대지 않는다.
- 서버 오류 메시지가 한국어로 나온다. 테스트는 메시지가 아니라 SQLSTATE 코드(`23505` 등)로 확인한다.
- 쌓은 PR에서 앞 PR을 `--delete-branch`로 머지하자, base 브랜치가 지워지며 뒤 PR이 닫혔다. 앞 PR을 머지하기 전에 뒤 PR의 base를 main으로 바꿔야 한다.
- GitGuardian이 CI의 일회용 비밀번호 글자(`PGPASSWORD: postgres` 등)를 비밀 정보로 잡았다. 실제 비밀번호(`.env`)는 어떤 커밋에도 없었다. 서비스 DB는 비밀번호 없이(trust) 띄우고, 앱 role 비밀번호는 실행마다 만든다.
- `npm audit`의 moderate 4건은 개발용 drizzle-kit 안의 옛 esbuild에서 나온다. 운영 의존성은 0건이다.

1단계에서 정할 것:
- id(bigint)가 Drizzle에서는 number, `pool.query`로 직접 쓴 SQL에서는 string으로 온다. 첫 조회를 쓸 때 `pg.types.setTypeParser(20, …)`로 맞추거나, 직접 쓴 SQL은 string으로 다룬다는 규칙을 정한다. → 1단계에서 정함(DESIGN 10장 12).

### 0단계 — 설명할 수 있어야 할 것

**마이그레이션은 어떻게 적용되고, 어떻게 되돌리나**

1. `npm run db:generate`(drizzle-kit generate)는 `src/db/schema.ts`를 직전 스냅샷(`drizzle/meta/*_snapshot.json`)과 비교해 바뀐 부분만 SQL 파일(`drizzle/0000_init.sql`)로 쓴다. `drizzle/meta/_journal.json`에는 파일마다 만든 시각(`when`)이 남는다.
2. `npm run db:migrate`(`src/db/migrate.ts`)는 DB의 `drizzle.__drizzle_migrations` 표에서 마지막으로 적용한 마이그레이션의 시각(실행 시각이 아니라 그 파일을 만든 시각, journal의 `when`)을 읽는다. 그보다 나중에 만든 파일만 차례로 실행하고, 실행한 파일마다 SQL의 해시와 그 파일을 만든 시각을 그 표에 적는다.
3. 아직 적용하지 않은 파일은 **트랜잭션 하나 안에서** 모두 실행한다. PostgreSQL은 `CREATE TABLE` 같은 DDL도 트랜잭션으로 되돌릴 수 있으므로, 중간에 하나가 실패하면 그 실행의 변경은 전부 취소된다. 트랜잭션 안에서 실행할 수 없는 문장(`CREATE INDEX CONCURRENTLY` 등)은 이 마이그레이터로는 실행할 수 없다("cannot run inside a transaction block" 오류). 7단계에서 마이그레이터 밖에서 돌린다.
4. 주의할 점이 두 가지 있다.
   - 이미 적용한 파일을 고쳐도 다시 실행되지 않는다. 해시를 적어 두기만 하고 비교하지는 않는다.
   - 다른 브랜치에서 더 이른 시각에 만든 파일이 늦게 합쳐지면, 마지막 시각보다 앞서므로 건너뛴다. 그래서 마이그레이션은 main에 들어간 순서대로 만들어야 한다.
5. Drizzle에는 되돌리는(down) 마이그레이션이 없다. 운영에서 되돌리려면 반대 동작을 하는 마이그레이션을 새로 만들어 앞으로 적용한다. 개발 DB는 지우고 처음부터 다시 적용하면 된다. 테스트 DB는 실행마다 새로 만든다.

**연결 풀은 왜 쓰나**

1. PostgreSQL은 연결 하나마다 서버 프로세스를 하나 띄운다. 연결을 맺을 때마다 TCP 연결, 인증(SCRAM), 프로세스 생성이 일어나므로 요청마다 새로 연결하면 느리고, 서버 메모리도 연결 수만큼 쓴다.
2. `pg.Pool`은 연결을 필요할 때 맺고, 다 쓴 연결은 닫지 않고 남겨 두었다가 다시 쓴다. 기본값은 최대 10개, 10초 동안 쓰지 않은 연결은 닫는다. 연결이 모두 쓰이고 있으면 다음 요청은 빌 때까지 기다린다. 그래서 DB가 받는 연결 수(기본 `max_connections` 100)를 앱 쪽에서 넘지 않게 막는 역할도 한다.
3. 이 저장소에서는 `main.ts`가 풀 하나를 만들어 앱 전체가 쓰고, 서버를 닫을 때 풀도 닫는다. `pool.query()`는 쿼리 하나마다 연결을 빌렸다가 바로 돌려준다.
4. 2단계부터 중요해지는 점: 트랜잭션은 같은 연결에서 `BEGIN`부터 `COMMIT`까지 이어져야 한다. `pool.query()`를 여러 번 부르면 서로 다른 연결로 갈 수 있으므로, 트랜잭션은 `pool.connect()`로 연결 하나를 빌려 그 안에서 처리하고 끝나면 돌려준다.

## 1단계 — 스키마, 시드, 좌석 조회 (완료, 2026-10-21)

- 설계 초안에 표 두 개를 더했다. 작품 제목을 회차마다 되풀이하지 않도록 `shows`를 두었고, 가격이 좌석이 아니라 등급마다 정해지므로 `performance_grades`를 두었다(DESIGN 10장 11).
- 요청과 응답은 `packages/shared`의 zod 스키마 하나로 검증한다. Fastify 연결에는 `fastify-type-provider-zod`를 쓴다(DESIGN 10장 13).
- bigint id는 `pg`의 int8 파서를 바꿔 number로 받는다. number로 정확히 나타낼 수 없는 값이 오면 조용히 틀리지 않고 오류를 낸다(DESIGN 10장 12).
- 샘플 시드는 공연장 하나(98석), 작품 둘, 회차 셋이다. `npm run db:seed`는 개발 DB를 비우고 다시 채운다.

| PR | 내용 |
|---|---|
| [#4](https://github.com/Jeonghyeock/seat-booking/pull/4) | 0단계 설명, 1단계 설계 보완 |
| [#5](https://github.com/Jeonghyeock/seat-booking/pull/5) | `packages/shared`의 zod 스키마와 Fastify 검증 연결, int8을 number로 |
| [#6](https://github.com/Jeonghyeock/seat-booking/pull/6) | `shows`·`performances`·`performance_grades`·`performance_seats` 마이그레이션, 샘플 시드 |
| [#7](https://github.com/Jeonghyeock/seat-booking/pull/7) | `GET /performances`, `GET /performances/:id/seats`, 실행 계획 테스트, 1단계 리뷰 반영 |

확인한 것:
- 테스트 19개가 로컬 PostgreSQL 18.6과 CI의 `postgres:18`에서 통과한다.
- 좌석 지도 API가 시드한 98석을 배치 순서대로, 등급 가격과 판매 상태를 붙여 돌려준다. 응답은 zod 스키마로 직렬화한다.
- 변이 시험 네 가지:
  - 시드의 재고 생성에서 공연장 조건을 빼면, 다른 공연장 좌석까지 재고에 들어가 시드 테스트가 실패한다. 처음 테스트는 이 변이를 잡지 못했다. 다른 공연장을 하나 미리 넣어 두도록 고쳤다.
  - 시드에서 트랜잭션을 빼면 "넣는 도중에 실패하면 되돌린다" 테스트가 실패한다.
  - 오류 처리기를 빼면 "500 응답에 SQL이 없다" 테스트가 실패한다.
  - 좌석 지도의 등급 가격 조인을 LEFT JOIN에서 INNER JOIN으로 바꾸면 가격 없는 등급의 좌석이 빠져 98석 대신 56석이 나오고, 테스트가 실패한다.

리뷰에서 나와 고친 것(#7 댓글의 표):
- 500 응답에 Drizzle 오류 메시지(SQL 문장과 파라미터)가 그대로 실렸다 → 5xx는 로그에만 남기고 응답은 `{ error: "서버 오류" }`로 보낸다.
- 시드 롤백 테스트가 트랜잭션 전의 검사에서 끝나 롤백을 확인하지 않았다 → 넣는 도중 check 제약에 걸리는 데이터로 바꿨다.
- 좌석 지도가 등급 가격과 INNER JOIN이라 가격 행이 없는 좌석이 오류 없이 빠졌다 → LEFT JOIN, `price`는 null일 수 있다.
- id 경로 값이 `1e3`, `0x10`, `007`도 통과했다 → 10진수 양의 정수만 받는다.
- `db:seed`가 표를 비운 뒤 JSON을 읽어, JSON이 틀리면 빈 DB가 남았다 → JSON을 먼저 읽고, 비우기와 넣기를 한 트랜잭션에서 한다.
- 문서의 부정확한 표현(0단계 설명 세 곳, DESIGN 6.1 예시 SQL, DESIGN 10장 12의 예외)을 고쳤다.

이 PC와 GitHub에서 걸린 것:
- 회차가 셋뿐인 테스트 DB에서는 PostgreSQL이 인덱스 대신 표 전체를 읽는다. 표가 작으면 그쪽이 싸기 때문이다. 실행 계획 테스트는 회차를 300개 더 넣어(재고 29,694행) 본다.
- `fastify-type-provider-zod`가 `@fastify/swagger`를 필수 peer 의존성으로 끌어온다. 문서 화면은 만들지 않았지만 설치는 된다.

2단계에서 정할 것:
- 1인 좌석 한도(C6)를 지킬 방법. DESIGN 6.1의 세 후보를 테스트로 비교한다.

### 1단계 — 설명할 수 있어야 할 것

**정규화를 어디까지 했나**

기준은 "한 가지 사실은 한 곳에만 둔다"이다. 같은 사실이 여러 행에 있으면, 고칠 때 일부만 바뀌어 서로 어긋날 수 있다.

1. 나눈 것
   - 좌석 배치(구역·열·번호·등급)는 공연장의 사실이라 `seats`에 한 번만 둔다. 회차마다 달라지는 것은 판매 상태뿐이라 `performance_seats`에는 상태만 둔다.
   - 작품 제목은 회차가 아니라 작품의 사실이라 `shows`로 뺐다. 회차에 두면 제목이 회차 수만큼 되풀이되고, 제목을 고칠 때 일부 회차만 바뀔 수 있다.
   - 가격은 (회차, 등급)으로 정해진다. 좌석 재고 행에 두면 회차 하나에 같은 값이 수십 번 되풀이되고, VIP 가격을 바꾸려면 VIP 좌석 행을 전부 고쳐야 한다. 그래서 `performance_grades`로 뺐다.
2. 일부러 나누지 않은 것
   - 등급 표는 따로 없다. `seats.grade`와 `performance_grades.grade`는 둘 다 글자이고 둘 사이에 외래 키가 없어서, 어떤 등급의 가격 행이 빠질 수 있다. 시드는 넣기 전에 이를 확인하고, 좌석 지도는 그런 좌석도 `price: null`로 보여 준다. 관리자가 등급을 따로 다루게 되면(4단계) 표로 뺄지 다시 본다.
   - 구역과 열도 표로 빼지 않았다. 좌석 지도를 그리는 데만 쓰고, 따로 바뀌지 않는다.
   - 등급은 좌석에 고정했다. 같은 좌석의 등급이 회차마다 달라야 한다면(어떤 회차는 2층 전체를 R석으로 파는 경우) 등급을 `performance_seats`로 옮겨야 한다. 지금은 그런 요구가 없다.
3. 일부러 미리 만들어 두는 것
   - `performance_seats`는 회차를 만들 때 공연장 좌석 수만큼 행을 채운다. "행이 없으면 빈 좌석"으로 두고 선점할 때 행을 넣는 방법도 있다. 미리 채운 이유는 좌석 지도가 재고 표 하나만 읽으면 되고, 선점·만료·판매를 한 행의 상태 변화로 다룰 수 있어서다. 2단계의 조건부 UPDATE도 이 행을 대상으로 한다.
   - 3단계의 `orders.amount`는 주문할 때의 가격을 복사한다. 가격을 되풀이하는 것처럼 보이지만, "그때 낸 금액"은 지금 가격과 다른 사실이다.

**이 조회에 어떤 인덱스가 쓰이나**

임시 DB에 샘플 시드와 회차 300개(회차 303개, 재고 29,694행)를 넣고, 좌석 지도 조회의 `EXPLAIN (ANALYZE, BUFFERS)`를 두 번 돌려 두 번째 것을 봤다. 실행 시간은 세 경우 모두 0.1ms 안팎이라 시간으로는 차이를 말할 수 없다. 읽은 페이지 수(Buffers)로 본다.

1. `performance_seats`: 기본 키 `(performance_id, seat_id)`의 Index Scan(`Index Cond: performance_id = 1`). 기본 키의 맨 앞 열이 `performance_id`라 한 회차의 재고는 인덱스 안에서 한 구간에 모여 있다. 29,694행 중 98행을 3페이지만 읽고 찾는다.
2. `performance_grades`: 조인 조건(`performance_grades.performance_id = performance_seats.performance_id`)과 `WHERE performance_seats.performance_id = 1`에서 PostgreSQL이 `performance_grades.performance_id = 1`을 이끌어 낸다. 그래서 기본 키 `(performance_id, grade)`로 이 회차의 등급 3행만 읽는다(Bitmap Index Scan).
3. `seats`: 데이터에 따라 읽는 방법이 바뀐다.

   | `seats` 행 수 | 이 공연장 좌석 id의 위치 | 읽는 방법 | 읽은 페이지 |
   |---|---|---|---|
   | 98(1페이지) | — | 표 전체(Seq Scan) + Hash Join, 마지막에 좌석 id로 정렬 | 7 |
   | 20,098 | 앞(1~98) | `seats_pkey` Index Scan + Merge Join. 양쪽이 이미 좌석 id 순서라 정렬이 없다 | 9 |
   | 20,098 | 뒤 | 좌석마다 `seats_pkey`로 한 번씩 찾는다(Nested Loop, 98번) | 300 |

   표가 1페이지면 통째로 읽는 편이 싸다. 좌석 id가 앞에 있으면 두 인덱스를 나란히 읽고, 뒤에 있으면 Merge Join은 `seats_pkey`를 처음부터 읽어야 하므로 좌석마다 찾는 쪽을 고른다.
4. 실행 계획 테스트(`seat-map-plan.test.ts`)는 `performance_seats` 기본 키가 쓰이는지만 확인한다. `seats`를 읽는 방법은 데이터에 따라 바뀌므로 테스트로 고정하지 않는다.
5. 만들지 않은 인덱스: PostgreSQL은 외래 키 열에 인덱스를 자동으로 만들지 않는다. `performance_seats.seat_id`, `performances.show_id`·`venue_id`에는 인덱스가 없다. 이 열들의 인덱스는 참조되는 행(좌석·작품·공연장)을 지우거나 그 열로 찾을 때 필요하다. 지금은 둘 다 하지 않는다. `seats.venue_id`는 맨 앞 열이 `venue_id`인 unique 제약의 인덱스가 대신한다. 회차 목록은 `starts_at`으로 정렬하지만 인덱스가 없다. 회차가 많아져 목록에 페이지를 붙일 때 다시 본다.
