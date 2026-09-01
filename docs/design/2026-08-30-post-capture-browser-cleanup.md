# 설계: 캡처 후 브라우저 세션 정리 (1인1세션 경합 제거)

작성 2026-08-30. 상태: **설계(미구현)**. 밴 상태라 라이브 검증 불가 → 검증은 밴 해제 후.

## 배경 / 문제

Evolution은 **1인1세션** 정책이다. 현재 앱 구조:

1. 브라우저(CDP Chrome)가 카지노(el011.com) 로그인 → Evolution 바카라 멀티테이블 진입.
2. 브라우저가 멀티위젯 WebSocket을 만들면 WS-블로커가 **더미**로 가로채고 URL을 캡처
   (`webview_commands.rs` WS_BLOCKER_SCRIPT, `Captured blocked Evolution socket`).
3. Rust가 캡처한 URL로 멀티위젯 소켓을 직접 연결(RC4+zstd 암복호) → 데이터 수신 + 베팅 송신.
4. Rust 연결 성공 시 프론트가 **세션 로테이션 스케줄러**를 시작
   (`useCasino.ts` `evolution_multi_connected` → `createSessionRotationScheduler`,
   첫 5분/이후 7분 주기로 `rotate_evolution_session`).

**문제:** 3번 이후에도 브라우저의 Evolution 게임 페이지가 계속 살아 있다. 브라우저는
자체 lobby 소켓 + 플레이어 세션을 유지하는데, 이게 Rust의 멀티위젯 세션과 **같은 계정으로
동시 존재**한다. 이 경합이:

- 브라우저에 "로그아웃되었습니다" 팝업(세션이 Rust로 넘어감) 또는
- 무언가 브라우저를 재인증시키면 Rust가 `logoutByPlayer`로 킥,
- 재로그인/재로드가 반복되면 애그리게이터 `403 [G.8]` 밴

을 유발한다. (2026-08-30 라이브에서 확인: 무한 새로고침 루프 수정 후 Rust는 2분+ 안정
유지됐고, 남은 킥은 앱 재시작=새 로그인 때문이었다. 즉 경합 자체는 "브라우저가 세션을
다시 잡을 때"만 문제가 된다.)

## 제약 (그냥 브라우저를 죽이면 안 되는 이유)

브라우저는 캡처 후에도 두 가지에 필요하다:

1. **테이블 배팅 한도** — `CLIENT_BET_CHIP` 메시지의 `tableMinLimit`/`tableMaxLimit`를
   브라우저 CDP가 캡처해 프론트로 넘긴다(`webview_commands.rs` ~3884).
   **Rust 멀티위젯 경로는 이 한도를 파싱하지 않는다**(`grep CLIENT_BET_CHIP src/evolution` → 0).
   AutoModeService가 배팅 캡 계산에 이 값을 쓴다(`AutoModeService.ts:2852` tableMaxLimit).
2. **세션 로테이션** — Evolution 세션은 단명(short-lived)이라 5~7분마다
   `rotate_evolution_session`이 Rust 연결을 끊고 브라우저 릴레이 런처를 다시 클릭해
   **새 세션을 재캡처**한다(`webview_commands.rs` rotate: stop_cdp → disconnect →
   start_cdp → `click_evolution_launch`).

즉 베팅은 소켓 기반이라 브라우저 클릭이 불필요하지만(확인: `playerBetRequest`는 Rust
`OutboundMessage`로 전송), **한도 캡처와 세션 재캡처**는 브라우저에 의존한다.

## 목표

Rust가 소켓을 소유한 뒤, **브라우저가 경합하는 Evolution 플레이어 세션을 들고 있지 않도록**
하되, ① 한도 캡처와 ② 로테이션 재캡처 능력은 유지한다.

## 설계

### 핵심 아이디어
캡처 직후 브라우저의 Evolution 탭을 **`about:blank`로 네비게이트**해 게임 클라이언트를
언로드한다. 그러면 브라우저의 lobby 소켓/플레이어 프레즌스가 닫혀 경합이 사라진다.
Chrome/CDP 프로세스는 살려둬서 로테이션 때 다시 게임으로 네비게이트해 재캡처한다.

### 순서 (연결 1회 수명)
1. 브라우저 게임 로드 → 멀티위젯 URL 캡처 → **`CLIENT_BET_CHIP` 한도 캡처 완료 대기**.
2. Rust 멀티위젯 연결 + `Subscribed N/N` 확인(`evolution_multi_connected`).
3. **브라우저 Evolution 탭 → `about:blank`** (게임 언로드, lobby 소켓 종료).
   - 이때 `MULTIWIDGET_CONNECTED=true`이므로 WS-블로커/캡처 로직은 재진입 안 함
     (`webview_commands.rs:1960` `!MULTIWIDGET_CONNECTED` 가드 이미 존재).
4. 5~7분 후 로테이션: `rotate_evolution_session`이 Rust 끊고 → 브라우저를 게임 URL로 다시
   네비게이트 → 재캡처 → Rust 재연결 → 다시 3번(about:blank).

### 트리거 지점
- **navigate-away 트리거**: `evolution_multi_connected` 수신 후(프론트 `useCasino.ts:562`
  핸들러) 또는 Rust `connect()` 성공 직후(webview 캡처 핸들러 `~2009`). 한도 캡처가
  끝났음을 보장하기 위해 "connected + 짧은 그레이스(예: 1.5~2s)" 뒤에 실행 권장.
- **구현 위치 후보**: 새 Tauri 커맨드 `park_browser_after_capture()` (Evolution 탭을
  about:blank로 네비) + 프론트가 `evolution_multi_connected`에서 호출. 기존
  `about:blank` 네비 헬퍼가 이미 여러 곳에 있음(`625/679/707/723`) → 재사용.

### 한도(limits) 처리
- 한도는 게임 로드 시 `CLIENT_BET_CHIP`로 한 번 들어와 캐시된다 → navigate-away 전에
  캡처되므로 유지된다.
- 로테이션마다 게임을 다시 열어 재캡처되므로 5~7분 주기로 갱신된다(충분).
- **확인 필요**: navigate-away 시점에 모든 구독 테이블의 한도가 이미 캡처됐는가?
  일부 테이블 한도가 늦게 오면 놓칠 수 있음 → "구독 완료 + N초" 또는 "한도 M개 수신"
  조건으로 지연.

## 옵션 비교

| 옵션 | 방식 | 장점 | 단점 |
|---|---|---|---|
| A. about:blank 네비 (권장) | 캡처 후 Evo 탭 언로드, Chrome 유지 | 경합 제거, 로테이션 재사용 가능, 한도 캐시 유지 | 네비 타이밍(한도 캡처 완료) 주의 |
| B. Chrome 완전 종료 | 캡처 후 Chrome kill | 가장 확실히 경합 0 | 로테이션 재캡처 불가(매번 재기동=느림), 한도 갱신 불가 |
| C. 브라우저 lobby 소켓만 JS로 닫기 | 페이지 유지, WS만 close | 페이지 상태 유지 | 취약(게임이 재연결 시도), 프레즌스 안 죽을 수 있음 |

→ **A 권장.** B는 로테이션과 충돌, C는 불확실.

## 리스크 / 검증 필요 (밴 해제 후, 최소 로그인)

1. **최대 리스크**: 브라우저 lobby 소켓을 닫으면 서버가 그 플레이어 세션 전체를 정리하면서
   **Rust 멀티위젯까지 끊길** 가능성. → 반드시 테스트: about:blank 후 Rust keepalive가
   계속 늘어나는지. 끊기면 옵션 A 무효 → C/다른 방식 재검토.
2. 한도 캡처 타이밍: navigate-away가 너무 일러 일부 테이블 한도 누락. → "구독완료+2s" 지연.
3. 로테이션과의 상호작용: about:blank 상태에서 rotate가 게임 URL로 재네비 가능해야 함
   (LOBBY_PAGE_ID/네비 헬퍼 경로 점검).
4. 예측/자동베팅 정상 여부: 브라우저 언로드 후에도 Rust 데이터로 예측·소켓 베팅 정상.

### 테스트 계획 (밴 해제 후 딱 1회 실행, 재시작 금지)
1. 앱 실행 → 로그인 → 바카라 멀티테이블 진입 (1회).
2. Rust `Subscribed N/N` 확인 → about:blank 네비 실행(수동 or 자동).
3. **관찰 포인트**: (a) Rust keepalive msgs 계속 증가(=끊기지 않음), (b) `logoutByPlayer`
   미발생, (c) 한도값 존재(AutoMode 캡 계산 정상), (d) 5~7분 뒤 로테이션 정상 재캡처.
4. 재시작·재로그인·다른 기기 로그인 절대 금지(그 자체가 새 로그인=킥).

## 참고 (밴 회피 운영수칙)
- 매 앱 실행/로테이션 = 로그인 1회. 짧은 시간 다수 로그인 → 애그리게이터 `403 [G.8]`.
- 개발 중 반복 재시작을 피하고, 한 세션을 길게 관찰.
- 로테이션 주기(5/7분)가 과하면 늘리는 것도 밴 완화에 도움(단 세션 만료와 트레이드오프).

## 현 상태 요약
- 무한 새로고침 루프는 이미 수정(커밋 f35fb0d) → logoutByPlayer 주원인 1차 제거, 2분+ 유지 확인.
- 본 설계(브라우저 파킹)는 그 위에 **경합 자체를 없애 재로그인 리스크를 더 낮추는** 추가 강화.
- 관련: [[evolution-multiwidget-encryption]] (암호화 이식 완료).
