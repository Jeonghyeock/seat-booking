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
2. `npm run db:migrate`(`src/db/migrate.ts`)는 DB의 `drizzle.__drizzle_migrations` 표에서 마지막으로 적용한 마이그레이션의 시각을 읽는다. 그보다 나중에 만든 파일만 차례로 실행하고, 실행한 파일마다 SQL의 해시와 시각을 그 표에 적는다.
3. 아직 적용하지 않은 파일은 **트랜잭션 하나 안에서** 모두 실행한다. PostgreSQL은 `CREATE TABLE` 같은 DDL도 트랜잭션으로 되돌릴 수 있으므로, 중간에 하나가 실패하면 그 실행의 변경은 전부 취소된다. 예외는 트랜잭션 안에서 실행할 수 없는 문장(`CREATE INDEX CONCURRENTLY` 등)이다. 7단계에서 다룬다.
4. 주의할 점이 두 가지 있다.
   - 이미 적용한 파일을 고쳐도 다시 실행되지 않는다. 해시를 적어 두기만 하고 비교하지는 않는다.
   - 다른 브랜치에서 더 이른 시각에 만든 파일이 늦게 합쳐지면, 마지막 시각보다 앞서므로 건너뛴다. 그래서 마이그레이션은 main에 들어간 순서대로 만들어야 한다.
5. Drizzle에는 되돌리는(down) 마이그레이션이 없다. 운영에서 되돌리려면 반대 동작을 하는 마이그레이션을 새로 만들어 앞으로 적용한다. 개발 DB는 지우고 처음부터 다시 적용하면 된다. 테스트 DB는 실행마다 새로 만든다.

**연결 풀은 왜 쓰나**

1. PostgreSQL은 연결 하나마다 서버 프로세스를 하나 띄운다. 연결을 맺을 때마다 TCP 연결, 인증(SCRAM), 프로세스 생성이 일어나므로 요청마다 새로 연결하면 느리고, 서버 메모리도 연결 수만큼 쓴다.
2. `pg.Pool`은 연결을 미리 맺어 두고 돌려 쓴다. 기본값은 최대 10개, 10초 동안 쓰지 않은 연결은 닫는다. 연결이 모두 쓰이고 있으면 다음 요청은 빌 때까지 기다린다. 그래서 DB가 받는 연결 수(기본 `max_connections` 100)를 앱 쪽에서 넘지 않게 막는 역할도 한다.
3. 이 저장소에서는 `main.ts`가 풀 하나를 만들어 앱 전체가 쓰고, 서버를 닫을 때 풀도 닫는다. `pool.query()`는 쿼리 하나마다 연결을 빌렸다가 바로 돌려준다.
4. 2단계부터 중요해지는 점: 트랜잭션은 같은 연결에서 `BEGIN`부터 `COMMIT`까지 이어져야 한다. `pool.query()`를 여러 번 부르면 서로 다른 연결로 갈 수 있으므로, 트랜잭션은 `pool.connect()`로 연결 하나를 빌려 그 안에서 처리하고 끝나면 돌려준다.
