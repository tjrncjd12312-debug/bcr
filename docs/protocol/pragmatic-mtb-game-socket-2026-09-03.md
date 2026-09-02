# Pragmatic MTB 게임 소켓 프로토콜 — 배팅·취소·라운드 (라이브 캡처 2026-09-03 16:04 KST+9)

로그: `scratchpad/diag/bcr-runtime-2026-09-03-prag-capture5-BET.log` (수동 캡처 모드, 브라우저만 클라이언트).
로비(DGA `/ws`, JSON subscribe) 문서는 `pragmatic-mtb-capture-2026-09-03.md`. 이 문서는 **배팅이 나가는 게임 소켓**.

## 소켓·구조
- 멀티플레이(BACCARAT_MULTIPLAY, MTB) 진입 시 로더 iframe(`…ytlvvulh.biz/gs2c/game/load`) **안에 게임 iframe이 하나 더** 생기고(about:blank/srcdoc, CDP type=iframe) 거기서 게임 소켓이 열린다.
  `wss://gs10.<rotating>.net/game?JSESSIONID=<71자>&tableId=<대표테이블>&type=json&launchSource=…&multiTable=true&mtbGroupId=<n>`
- **단일 소켓이 여러 테이블**을 `channel="table-<id>"`로 실어 나른다(캡처 시 ~30개, `tablesorder`가 전체 목록). 테이블 id는 영숫자(`tobcspbaccarat61`, `cbcf6qas8fscb222`…), 로비의 숫자 id(007, 404)와 다르다. 이름은 `tableconfig.table_name`.
- CDP: 최상위 페이지의 setAutoAttach만으론 손자 iframe이 안 붙는다 → 붙은 iframe 세션마다 `Target.setAutoAttach`를 다시 걸어야 한다(코드 반영됨).
- 수신은 **JSON**(`{"<kind>":{...}}` 한 키), **송신은 XML** 명령. 기존 `pragmatic/bet_builder.rs`의 XML(ROSE 유래)이 **정확히 일치**한다.

## 송신 (브라우저 → 서버)
- 입장: `<command channel="table-<대표>"><autoBet></autoBet></command>`
- 핑(10초): `<ping channel="table-<any>" time="<ms>"/>`
- **배팅**: `<command channel="table-tobcspbaccarat61"><lpbet gm="mtb_desktop" gId="16448657510" uId="ppc1735381141035" ck="1788365065336" ><bet amt="1000" bc="0" ck="1788365065336"/></lpbet></command>`
  - `gId` = 현재 라운드 gameId(`game`/`betsopen`의 game), `uId` = 플레이어 id(`ppc…`; 로비 좌석 프레임 `currentUserId`와 동일), `ck` = epoch ms(둘 다 같은 값)
  - `bc`: 0 Player, 1 Banker, 2 Tie (기존 bet_builder 매핑과 일치; 3/4 pair는 미검증)
- **취소**: 같은 lpbet에 `<bet amt="0" bc="8" ck="…"/>` (bc=8 = 전체 취소). 응답으로 `{"bets":{...,"bet":[{}]}}`(빈 목록).

## 수신 (서버 → 브라우저)
- 명령 ACK: `{"command":{"channel":"table-…","status":"success","seq":n}}` (배팅/취소/autoBet 모두, ~0.2초)
- 체결 확정(마감 직후): `{"bet":{"bc":"true","amount":"1000","betcode":"0","table":"…"}}` + `{"bets":{"bc":"true","table":"…","bet":[{"amount":"1000","betcode":"0"}]}}`
- 정산: `{"win":{"gameId":"…","win":"2000.0","nwb":"1000.0","rewardtype":"CASH","table":"…"}}` (win=총 지급, nwb=순이익; 패배는 0.0/0.0)
- 라운드: `{"betsopen":{"game":"<gameId>","table":"…"}}` → `{"betsclosingsoon":{…}}` → `{"betsclosed":{…}}` → `{"card":{"sc":"3S7","place":"player","cardCount":…}}`… → `{"gameresult":{"result":"player|banker|tie","score":"9","gameId":"…","table":"…","natural":…,"player_pair":…,"banker_pair":…}}` → `{"win":…}` → 약 5초 뒤 다음 `betsopen`
- 새 라운드/시각: `{"game":{"id":"<gameId>","starttime":"<ms>","table":"…","value":"16:04:15"}}`
- **타이머**: `{"timer":{"id":"<gameId>","table":"…","value":"8"}}`는 **접속 직후 스냅샷에서만 1회**(남은 초, 마감 후엔 음수). 라운드 중엔 안 온다 → 카운트다운은 `betsopen` 수신 시각 + 창 길이로 계산해야 한다.
  - 창 길이 = `tableconfig.betting_time`(초, 테이블별 13/14/18…). 실측: `betsclosed` = open + (betting_time − 1)s, `betsclosingsoon` = open + (betting_time − 6)s. (13초 테이블: +7/+12, 18초 테이블: +12/+17)
- 기타: `tableconfig`(table_name, betting_time, 최소/최대·페이아웃), `tablesorder`, `subscribe`(테이블별 success), `statistic`(bigRoad/beadPlate JSON 문자열), `statisticLA`, `betstats`, `ShoeSummary`, `SideBetsLimits`, `dealer`, `table`, `startshuffling`, `winners`(타 플레이어 상위 당첨), `pong`.
- **잔액 프레임은 이 소켓에 없다**(`balance` 키 0건). 잔액은 `win`(nwb) 누적 또는 로비/HTTP 경로로 따로 확보해야 한다.

## 자동화 설계 요점 (에볼루션 브릿지와 동일 골격)
1. 멀티플레이 자동 진입: 로비 DOM에서 BACCARAT_MULTIPLAY 클릭(기존 click_pragmatic_room_in_lobby 활용) → 게임 iframe·소켓은 브라우저가 열고 모든 테이블을 스스로 구독한다.
2. 탭: 손자 iframe 세션의 `Network.webSocketFrameReceived`로 위 JSON을 파싱 → 방/결과/라운드 이벤트. gameId는 `betsopen.game`(또는 `game.id`)로 테이블별 추적.
3. 주입: 게임 iframe **컨텍스트**(contextId)에 WebSocket send 훅을 두고 XML 배팅/취소를 `Runtime.evaluate`로 송신(에볼루션의 contextId 수정과 같은 원리, 평문이라 암호화 불필요).
4. 타이밍 가드: `betsopen` 수신 시각 + betting_time − 1초 = 마감. 마감 1초 전까지만 전송. 체결은 `command success` → 마감 후 `bet/bets`로 확정, 정산은 `win`.
