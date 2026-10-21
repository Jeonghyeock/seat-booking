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
- id(bigint)가 Drizzle에서는 number, `pool.query`로 직접 쓴 SQL에서는 string으로 온다. 첫 조회를 쓸 때 `pg.types.setTypeParser(20, …)`로 맞추거나, 직접 쓴 SQL은 string으로 다룬다는 규칙을 정한다.
