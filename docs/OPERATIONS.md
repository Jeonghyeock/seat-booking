# 운영

seat-booking의 PostgreSQL을 운영하는 절차입니다(7단계, 설계는 [DESIGN.md](DESIGN.md) 6.7). 숫자는 이 PC(PostgreSQL 18.6, Windows)의 리허설에서 잰 것입니다.

## role과 권한

| role | 가진 것 | 쓰는 곳 |
|---|---|---|
| `seat_booking`(소유자) | DB와 표의 소유, `CREATEDB` | 마이그레이션, 시드, 테스트·E2E·부하 준비, 논리 백업 |
| `seat_booking_app`(앱) | 표의 `SELECT·INSERT·UPDATE·DELETE`만(마이그레이션 0008이 준다) | 서버, `admin:promote`, 다시 채우기 명령 |
| `seat_booking_backup`(물리 백업, 리허설 클러스터에만) | `LOGIN REPLICATION`만 | `pg_basebackup`, `pg_receivewal` |

- **만들기**: 슈퍼유저가 한 번 합니다(README "로컬 실행"). 마지막 줄 `GRANT seat_booking_app TO seat_booking`이 있어야 소유자가 앱 연결이 남은 DB를 지울 수 있습니다(`DROP DATABASE … WITH (FORCE)`).
- **환경 변수**: `DATABASE_URL`은 앱, `DATABASE_OWNER_URL`은 소유자입니다. 소유자 주소를 읽는 파일은 CI가 정해 둔 목록과 견줍니다.
- **비밀**: `dev`·`start` 스크립트는 `.env` 전체를 서버 프로세스에 올립니다. 그래서 앱의 `.env`에는 슈퍼유저 비밀번호를 두지 않습니다. 이 PC의 `.env`에는 7단계 리허설 때문에 있습니다.

### 왜 앱 계정에서 DDL 권한을 빼나
- **피해의 크기를 행으로 묶는다.** 앱이 뚫리거나 버그가 나도 표를 지우거나(`DROP`, `TRUNCATE`) 모양을 바꾸지(`ALTER`) 못합니다. 남는 피해는 앱이 원래 하는 DML입니다.
- **스키마를 바꾸는 길이 마이그레이션 하나가 된다.** DDL은 대개 `ACCESS EXCLUSIVE`를 잡아 잠금 줄을 만듭니다(아래 리허설). 그것을 실행기의 규칙(잠금 대기 1초, 다시 하기, `CONCURRENTLY`)을 거쳐서만 하게 됩니다.
- **앱이 DML만으로 도는지 늘 확인된다.** 테스트가 앱 role로 돌기 때문입니다.
- **그래도 남는 것**
  - 앱 role도 `LOCK TABLE`(UPDATE·DELETE 권한으로 된다), 임시 표, 긴 트랜잭션으로 표를 얼릴 수 있습니다.
  - 그래서 주문·결제·웹훅·취소·정리의 쓰기 트랜잭션에는 `lock_timeout` 3초, `statement_timeout` 5초를 둡니다. 선점 경로에는 아직 없습니다(DESIGN 10장 89).
  - 권한 없는 `ANALYZE`·`VACUUM`·표 `GRANT`는 오류 없이 경고만 내고 아무것도 하지 않습니다(42501이 아닙니다).

## 마이그레이션

- 돌리기: `npm run db:migrate -w @seat-booking/api`(소유자 주소로 돕니다). 적용한 이름을 출력합니다.
- 실행기(`apps/api/src/db/migrate.ts`)가 drizzle 대신 하는 것
  - 마이그레이션마다 트랜잭션을 하나씩 둡니다. 실패하면 그것만 되돌리고 멈춥니다.
  - 세션에 `lock_timeout = '1s'`를 겁니다. 앱 쓰기의 한도(3초)보다 짧아야 그 뒤에 줄 선 요청이 자기 한도에 닿지 않습니다.
  - 55P03·40P01이면 2·4·8초 쉬고 세 번까지 다시 합니다.
  - DB 소유자가 아니거나 슈퍼유저면 거절합니다. 슈퍼유저가 돌리면 표와 기본 권한의 주인이 바뀝니다.
  - 실행기 둘이 함께 돌지 않게 advisory lock을 잡습니다.
- **새 마이그레이션**: `npm run db:generate -w @seat-booking/api`로 만들고 SQL을 읽어 봅니다.
  - 인덱스는 `CONCURRENTLY`로 만듭니다. drizzle-kit은 보통 `CREATE INDEX`를 내므로 손으로 고칩니다.
    - 첫 줄을 `-- 트랜잭션 밖`으로 둡니다.
    - `DROP INDEX CONCURRENTLY IF EXISTS "이름";`과 `CREATE INDEX CONCURRENTLY …`를 `--> statement-breakpoint`로 나눕니다(조각마다 문장 하나).
    - `schema.ts`에는 보통 `index()`로 둡니다.
  - 트랜잭션 밖 마이그레이션의 문장은 다시 해도 같은 결과여야 합니다. 실패하면 파일 처음부터 다시 돕니다.
  - `CREATE INDEX CONCURRENTLY IF NOT EXISTS`는 쓰지 않습니다. 실패로 남은 INVALID 인덱스를 건너뜁니다.
- **INVALID 인덱스가 남았다고 실패하면**: 출력된 `DROP INDEX CONCURRENTLY IF EXISTS …;`를 소유자로 돌리고 `db:migrate`를 다시 돌립니다. INVALID 인덱스는 계획에 쓰이지 않으면서 쓰기마다 유지됩니다.
- **55P03으로 세 번 실패하면**: 오래 쥔 트랜잭션을 찾습니다.
  - `select pid, state, xact_start, query from pg_stat_activity where datname = current_database() order by xact_start`
  - `idle in transaction`이 오래 남아 있으면 그것이 원인입니다.

### 열·제약을 바꿀 때: expand → contract
`orders.paid_at`(결제 확정 시각)을 더한 순서입니다. 단계마다 PR 하나이고, 그 PR을 낼 때 **마이그레이션을 먼저 돌리고 그다음 코드를 띄웁니다**.

1. **배포 1**: 마이그레이션 0010(nullable 열), 결제 확정 때 쓰는 코드. 옛 코드는 이 열을 모르고 그대로 돕니다.
2. **명령**: 배포 1이 모든 서버에 나간 뒤 `npm run ops:backfill-paid-at -w @seat-booking/api`
   - 옛 paid 주문을 id 순서로 1,000행씩 채웁니다. 앱 role로 돌고, 다시 해도 같은 결과입니다.
   - 옛 코드가 도는 동안 돌리면, 이미 지나간 낮은 id의 주문이 그 뒤에 paid가 되어 빈 채로 남습니다.
   - 많이 채웠으면 소유자로 `VACUUM (ANALYZE) orders`를 돌립니다. 리뷰 실험에서 70만 건에 표와 인덱스가 149MB에서 263MB가 됐습니다.
3. **배포 2**: 0011(`CHECK … NOT VALID`), 0012(`VALIDATE`), 읽기 코드
   - 0011은 빈 옛 paid 주문이 있으면 2를 안내하며 실패하고 통째로 되돌아갑니다.

규칙:
- 단계를 하나로 묶지 않습니다. 묶으면 어느 순서로 내도 깨집니다(리뷰 실험).
  - 코드를 먼저 내면 열이 없어 42703입니다.
  - 마이그레이션을 먼저 하면 0011부터 옛 코드의 결제 확정이 23514입니다.
- `NOT NULL`·`CHECK`는 `NOT VALID`로 걸고 따로 `VALIDATE`합니다.
  - `NOT VALID`는 `ACCESS EXCLUSIVE`지만 옛 행을 훑지 않아 짧습니다.
  - `VALIDATE`는 `SHARE UPDATE EXCLUSIVE`라 읽기·쓰기를 막지 않습니다.
- API 응답에 더하는 필드는 없어도 되게 둡니다.
  - 멱등 키에 저장된 배포 전 응답이 그대로 다시 나가고, 그때 응답 스키마를 거칩니다.
  - 새 화면이 옛 API를 만날 수도 있습니다.
- 되돌리기는 한 단계씩 합니다.
  - 배포 2의 코드를 배포 1로 되돌리는 것은 됩니다.
  - 배포 1 이전의 코드로 가려면 제약을 지우는 새 마이그레이션을 먼저 냅니다. 기록이나 제약을 손으로 지우면 스키마와 기록이 어긋납니다.

### 잠금이 서비스에 주는 것(리허설)
CI의 `lock-rehearsal.test.ts`가 결정적으로 확인합니다. 부하 중 숫자는 [load/RESULTS.md](../load/RESULTS.md)에 있습니다(S3 초당 30건, 한 번).

| 무엇 | 가장 느린 요청 | 5xx |
|---|---|---|
| 큰 표에 보통 `CREATE INDEX`(5초 쥠) | 5,097ms | 4 |
| `CREATE INDEX CONCURRENTLY` | 4ms | 0 |
| 열린 트랜잭션 뒤의 한도 없는 `ALTER`(5초 줄) | 5,029ms | 4 |
| 같은 `ALTER`에 `lock_timeout` 1초 | 1,008ms | 0 |

- 막힌 쓰기가 풀 연결 10개를 쥐면, 잠금과 상관없는 읽기까지 늦어집니다.
- `ACCESS EXCLUSIVE`를 기다리는 문장 뒤에는 읽기도 줄을 섭니다.

## 백업과 복구

### 논리 백업: C8
`npm run ops:backup-rehearsal -w @seat-booking/api`(소유자로 돕니다)

절차:
1. 부하 템플릿을 복제합니다. 템플릿은 측정의 기준이라 직접 덤프하지 않습니다.
2. `pg_dump -Fc`로 덤프하고, 빈 새 DB에 `pg_restore -j 4`로 복구합니다.
3. 표마다(`public`, `drizzle`) 행 수와 `sum(hashtextextended(t::text, 0))`, 시퀀스마다 `last_value`·`is_called`를 견줍니다. `timestamptz`의 글자가 세션에 따라 달라지므로 양쪽 모두 `TimeZone` UTC, `DateStyle` ISO로 잽니다.

결과(2026-10-27): **합격**

| 항목 | 값 |
|---|---|
| 대조 | 표 16개(773,515행), 시퀀스 10개, 차이 0 |
| DB 크기 / 덤프 크기 | 112MB / 5.0MB |
| 덤프 시간 / 복구 시간(`-j 4`) | 0.73초 / 0.88초 |
| 통계 | 복구본 `pg_stats` 0행, 좌석 재고 추정 1,352행(실제 2,000). `ANALYZE` 뒤 66행, 추정 1,989행 |
| 스냅샷 뒤의 쓰기 | 백업에 없음(넣은 행, 고친 행 모두) |
| 시퀀스 | 스냅샷을 따르지 않음(스냅샷 때 1, 백업에는 2) |
| role | DB 백업에 없음. 비슈퍼유저는 `pg_dumpall --globals-only --no-role-passwords`만 됨(비밀번호까지는 실패) |

복구한 뒤 할 일:
- `ANALYZE`를 돌립니다. 18의 `pg_dump`는 기본값으로 통계를 담지 않습니다(`--statistics`로 담을 수 있습니다).
- 대상 클러스터에 role이 먼저 있어야 권한(0008)까지 복구됩니다. 없으면 `pg_restore`가 권한 문장에서 실패하고, 데이터만 들어갑니다.
- 옛 백업으로 되돌렸다면 시퀀스를 넉넉히 앞으로 옮깁니다. 결제 id가 결제사 쪽 멱등 키라, 되감긴 id로 만든 새 결제에 결제사가 옛 결과를 돌려줍니다.
- 결제사 쪽 기록과 대조합니다. 대사는 DB에 남은 `requested` 결제에서 시작하므로, 복구로 사라진 결제는 보지 못합니다.

### 물리 백업과 시점 복구
`npm run ops:pitr-rehearsal -w @seat-booking/api`

이 PC의 서비스는 설정을 바꾸지 않으므로, `initdb`로 만든 리허설 클러스터(127.0.0.1의 다른 포트)에서 합니다. 끝에 모든 인스턴스와 받기를 멈추고 작업 폴더를 지웁니다.

절차:
1. role 셋을 만들고 논리 백업을 복구합니다(다른 클러스터로의 복구).
2. 영구 슬롯 없는 `pg_receivewal`로 WAL을 받기 시작합니다. 받기를 백업보다 먼저 시작해야 빈 구간이 없습니다.
3. 백업 role(`REPLICATION`만)로 `pg_basebackup -X stream`을 받고, 바로 `pg_verifybackup`으로 확인합니다.
4. 표시 행을 넣고, 커밋 뒤 따로 `clock_timestamp()`로 시각 T를 잽니다(오프셋 포함). WAL을 전환합니다.
5. T 뒤에 또 쓰고, 한 번 더 전환합니다. 그 세그먼트가 `.partial` 없이 받아질 때까지 기다립니다.
6. 백업 사본 둘을 복구합니다. 하나는 목표 없이, 하나는 `recovery_target_time = T`와 `recovery_target_action = 'pause'`입니다.

결과(2026-10-27): **합격**

| 항목 | 값 |
|---|---|
| 기본 백업 / 검증 | 1.7초 / 0.14초 |
| 목표 없이 복구 | 2.6초, 행 셋(백업 안, T 전, T 뒤), 받은 WAL 파일 4개 |
| T로 복구 | 2.1초, 행 둘(백업 안, T 전), 로그에 `recovery stopping before commit` |
| 백업 role | 백업은 받고, 표는 읽지 못함 |

함정(리뷰 실험에서 모두 오류 없이 행을 잃었습니다):
- `pg_ctl -w start`의 성공은 복구가 끝났다는 뜻이 아닙니다.
  - hot standby가 연결을 받는 순간 돌아옵니다. WAL이 모자라 로그에 FATAL이 있어도 그렇습니다.
  - 그래서 로그(`recovery stopping before commit`, `restored log file` 줄 수)와 `pg_get_wal_replay_pause_state()`로 판정합니다.
- 마지막 쓰기가 `.partial` 파일에만 있으면 `restore_command`가 찾지 않습니다. 쓴 뒤 WAL을 한 번 더 전환합니다.
- Windows의 `restore_command`에서 `copy`에는 백슬래시를 두 번 적은 경로를 씁니다. 슬래시는 실패하고, 목표 없는 복구는 그러면 백업 시점에서 조용히 끝납니다.
- T에 오프셋이 없으면 복구 서버의 TimeZone으로 읽습니다. 표시 행의 트랜잭션 안의 `now()`는 커밋보다 앞이라 쓰지 않습니다.
- `pg_verifybackup`은 손대지 않은 백업에서 돌립니다. 복구에 쓴 폴더는 파일이 바뀌어 실패합니다.
- 영구 슬롯은 쓰지 않습니다. 지우지 못하면 WAL이 끝없이 쌓입니다(`max_slot_wal_keep_size` 기본 -1).
- 백업 파일에는 비밀번호 해시(`pg_authid`)와 세션 토큰 해시가 있어 비밀로 다룹니다. `REPLICATION`은 클러스터의 모든 파일을 읽는 권한입니다.
- Windows에서 `pg_ctl start`를 출력 파이프에 연결해 부르면, 띄운 서버가 파이프를 물려받아 `pg_ctl`이 돌아오지 않습니다. 출력은 `-l` 로그로만 받습니다.

## 백업에서 무엇을 잃을 수 있나

- **시점**
  - 논리 백업은 스냅샷 뒤의 모든 쓰기를 잃습니다. RPO는 백업 간격입니다.
  - 물리 백업과 WAL은 받지 못한 WAL(마지막 `.partial`, 받기의 지연)만 잃습니다.
  - 같은 PC·같은 디스크의 백업은 재해에 쓸 수 없습니다.
- **되감기는 것**
  - 세션: 백업 뒤의 로그아웃과 관리자 강등이 무효가 됩니다.
  - 시퀀스: 결제 id가 되감겨 결제사의 멱등 키와 겹칩니다(위 "복구한 뒤 할 일").
  - 결제: 복구로 사라진 결제는 대사가 보지 못하므로 결제사 쪽과 대조합니다.
- **DB 백업 밖의 것**
  - role과 비밀번호
  - 서버 설정(`postgresql.conf`, `pg_hba.conf`). 물리 백업에는 들어 있습니다.
  - DB 수준 설정과 권한(`ALTER DATABASE … SET`). `pg_dump --create` 없이는 빠집니다.
  - `.env`, 화면 `sessionStorage`의 멱등 키
- **물리 상태**
  - 누적 통계(`pg_stat_*`)
  - 실행 계획 통계(기본값으로는 담지 않음)
  - visibility map, 동결 상태
  - 복구본은 원본의 `autovacuum_enabled = false` 같은 표 설정을 그대로 이어받습니다. 부하 템플릿에서 복구했다면 켭니다.
