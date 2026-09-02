# Pragmatic Play MTB(멀티테이블) 프로토콜 — 라이브 캡처 2026-09-03

수동 캡처 모드(`BCR_PRAGMATIC_PASSIVE=1` + `BCR_BET_TRACE=1`)로 확보. Rust 직접 소켓 없이 브라우저
트래픽만 CDP로 관찰. 로그: `scratchpad/diag/bcr-runtime-2026-09-03-prag-capture3.log`.

## 소켓 구조 (에볼루션 멀티위젯과 동형)
- **단일 DGA 소켓**: `wss://dga-lc.<rotating>.net/ws` (캡처값 `dga-lc.fcxlljmmbqtczjya.net`).
  한 소켓이 **모든 테이블**을 실어 나른다. 테이블마다 소켓을 여는 구조가 아니다.
- 게임은 릴레이 iframe 안에서 돈다: 최상위 `el011.com` → 로더 iframe `8c9cxsd2jk.ytlvvulh.biz/gs2c/game/load?ssid=…&cid=…` → 그 안에서 DGA 소켓 open. CDP 세션은 이 iframe(type=iframe)에 붙는다.
- WS 블로커는 프라그마틱 소켓을 막지 않는다(에볼루션 멀티위젯/로비만 차단). 즉 브라우저가 유일 클라이언트로 열고, 브릿지(탭+주입) 설계가 그대로 적용 가능하다.

## 접속 핸드셰이크 (브라우저 → 서버, 송신)
순서대로 1회:
1. `{"type":"statistics"}`
2. `{"type":"available","casinoId":"ppcdd00000003110"}`  ← casinoId는 오퍼레이터 상수
3. `{"type":"subscribe","isDeltaEnabled":true,"casinoId":"ppcdd00000003110","key":["007","402",...54개...],"currency":"KRW"}`
   - `key` = 구독할 테이블 id 배열. **이게 멀티테이블 접속의 핵심.** 전체 목록은 서버가 `{"tableKey":[...]}`로 내려준다.
4. 주기적 `{"type":"ping","pingTime":<ms>}` → 서버 `{"pongTime":<ms>,"pingTime":<ms>}`

## 인바운드 프레임 (서버 → 브라우저, 수신) — 전부 JSON, XML 아님
- 좌석: `{"tableId":"460","totalSeatedPlayers":177}`
- 로드맵 통계: `{"tableId":"405","statistics":"[[\"BN0\",...],[...]]"}` (6열 문자열)
- **게임 결과**: `{"tableId":"404","gameResult":[{"time":"Sep 02, 2026 09:15:41 PM","player":5,"banker":2,"winner":"PLAYER_WIN|BANKER_WIN|TIE","gameId":"16448355810","playerCards":["5C","7C","3H"],"bankerCards":["0C","2D","QD"]}],"goodRoadsMap":{...},"goodRoadsDepthMap":{...}}`
- 슈 히스토리: `{"shuffle":false,"gameResult":[ ...최근 다수... ],"statistics":...,"baccaratShoeSummary":{totalGames,bankerWinCounter,playerWinCounter,tieCounter,bankerPairCounter,playerPairCounter}}`
- 테이블 설정: `{"tableId":"007","tableName":"BACCARAT_MULTIPLAY","tableType":"MTB","tableSubtype":...,"tableLimits":{"ranges":[...],"minBet":300.0,"maxBet":7500000.0},"currency":"KRW","tableOpen":true,...}`
- 좌석 상세(유저 식별): `{"seat1":...,"seat7":...,"availableSeats":...,"currentUserId":"<userId>","sidebets":...,"multiseat":...}` ← **currentUserId = 베팅에 필요한 uId**
- 전역: `{"globalStats":{"playerCount":...}}`, 테이블 목록 `{"tableKey":[...]}`
- 로비에는 바카라 외 게임도 섞여 온다(룰렛 `last20Results`, 주사위 `diceResults`, 휠/크래시 `winBetSpot`/`boosterMul`). 파서는 바카라(`player`/`banker`/`winner` 형태)만 취해야 한다.

## 아직 확보 못 함 (자동 배팅에 필수)
- **배팅 명령 원문**: 어떤 `{"type":"..."}`인지(예상: bet/placeBet, betCode·amount·tableId·gameId 포함), 같은 DGA 소켓인지 별도 소켓인지.
- **취소 명령 원문**.
- **베팅창 open/close·라운드 타이머 프레임**: 로비 피드에는 안 보였다(결과만 옴). 테이블에 실제 앉아 배팅 UI가 뜰 때 오는 프레임을 봐야 한다.
- 기존 `bet_builder.rs`의 XML `<command><lpbet>`(ROSE 유래)은 이 MTB JSON 소켓과 형식이 다르다 — **재검증 전 사용 금지.**

## 다음 캡처에 필요한 것
같은 수동 캡처 모드에서 **바카라 멀티플레이 테이블에 실제로 최소 배팅 1회 + 마감 전 취소 1회**.
그때 `[WS-TRACE][SENT]`에 잡히는 프레임이 배팅/취소 포맷이고, 그 직후 `[WS-TRACE][RX]`가 수락/거절·잔액.
