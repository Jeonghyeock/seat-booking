# 부하 측정

6단계(DESIGN 6.6)의 도구입니다. 로컬 Windows PC에서만 돌립니다(CI에는 넣지 않습니다). 숫자는 같은 PC에서의 전후 비교로만 씁니다.

## 준비

1. k6 v2.3.0. winget에는 2.2.0까지만 있어 zip으로 받습니다.
   - [릴리스](https://github.com/grafana/k6/releases/tag/v2.3.0)에서 `k6-v2.3.0-windows-amd64.zip`과 `k6-v2.3.0-checksums.txt`를 받습니다.
   - `Get-FileHash`의 SHA-256이 체크섬 파일과 같은지 봅니다.
   - `%LOCALAPPDATA%\Programs\k6-v2.3.0\`에 풉니다. 다른 곳에 두면 환경 변수 `K6`에 `k6.exe` 경로를 줍니다.
2. 템플릿 DB(약 20초): `npm run load:template -w @seat-booking/api`
   - `seat_booking_load_template`을 만듭니다: 2,000석, 회차 200개, 사용자 5,000명과 세션, 지난 주문 5만 건.
   - `load/results/`에 `load-data.json`과 `cookies.json`을 씁니다.
   - 세션이 7일 뒤 만료되므로 6일이 지나면 다시 만듭니다(실행기가 거절합니다).

## 돌리기

`npm run load:run -w @seat-booking/api -- --scenarios <s1,s2,s3> [옵션]`

회차마다 다음을 합니다.
1. 템플릿을 `seat_booking_load`로 복제합니다.
2. API를 포트 3201에 띄우고 P코어에 묶습니다(로그 warn, `LOAD_STATS` 켬).
3. 표본기를 돌리고, k6를 E코어에 묶어 돌립니다. 표본기는 `pg_stat_activity`를 0.2초마다, CPU를 1초마다 봅니다.
4. API를 닫고 `load/results/runs/<시각>-<label>/`에 씁니다.

| 옵션 | 뜻 |
|---|---|
| `--label` | 결과 폴더 이름 |
| `--pool`, `--connect-timeout` | `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`. 주지 않으면 API 기본값(풀 10, 한도 없음) |
| `--s2-rates 100,200,300 --s2-step 60` | S2 좌석 지도 도착률(초당). 여러 개면 단계로 올립니다 |
| `--s2-warmup 30` | 첫 도착률로 먼저 도는 예열(초). 요약에서 따로 나옵니다 |
| `--s3-rates`, `--s3-step`, `--s3-warmup` | S3 지속 부하(선점 → 주문 → 결제 또는 취소) |
| `--s1-mode uniform\|hot`, `--s1-users`, `--s1-warmup` | S1 오픈 러시. 판매 전 예열 뒤 T0에 몰립니다. 끝나면 조용해질 때까지 기다린 뒤 C2를 확인합니다 |
| `--cpu-prof` | API를 `--cpu-prof`로 띄웁니다 |

예:
- C7 기준: `--scenarios s2,s3 --s2-rates 140 --s2-warmup 30 --s2-step 180 --s3-rates 20 --s3-warmup 30 --s3-step 180`
- 꺾이는 점: `--scenarios s2 --s2-rates 50,100,150,200,250,300 --s2-step 60`
- C2: `--scenarios s1 --s1-mode hot`

## 잠금 리허설(7단계)

`load:run`이 S3를 도는 동안 다른 창에서 부하 DB에 잠금 이벤트를 겁니다(DESIGN 6.7 "부하 중 리허설", 결과는 [RESULTS.md](RESULTS.md)).

1. `npm run load:run -w @seat-booking/api -- --scenarios s3 --s3-rates 30 --s3-warmup 20 --s3-step 240 --label lock-rehearsal`
2. 바로 다른 창에서 `npm run load:lock-events -w @seat-booking/api -- --delay 70 --gap 30 --hold 5`
   - 보통 `CREATE INDEX`(A1), `CONCURRENTLY`(A2), 한도 없는 `ALTER`(B1), `lock_timeout` 1초의 `ALTER`(B2)를 차례로 겁니다.
   - 시작·끝 시각을 `load/results/lock-events-<시각>.jsonl`에 씁니다.
3. `npm run load:lock-report -w @seat-booking/api -- <결과 폴더> <lock-events 파일>`로 이벤트마다 요청 수, 5xx, 가장 느린 요청을 봅니다.

## 결과 폴더

| 파일 | 내용 |
|---|---|
| `summary.md`, `run.json` | 단계별 요약을 담습니다(k6 백분위, API 처리 시간·ELU·연결 대기, CPU, DB 상태별 연결 수, 표 통계 차이). S1이면 C2 판정도 있습니다 |
| `k6-summary.json`, `k6-log.jsonl` | k6 요약과 시나리오가 남긴 기록(선점 시도, paid, 포기) |
| `api/api-stats.jsonl`, `api/fake-pay.json` | API 1초 지표, 가짜 결제사가 아는 결제 |
| `db-activity.jsonl`, `cpu.jsonl` | DB 표본, CPU 표본 |

측정 중에는 빌드나 테스트처럼 무거운 일을 돌리지 않습니다. PostgreSQL 설정, 서비스 affinity, 전원 관리, Defender는 관리자 권한이 들어 바꾸지 않습니다.
