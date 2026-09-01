//! 런타임 브라우저 지문 미러링 — "어떤 PC에서든" 탐지되지 않게 하는 핵심.
//!
//! Evolution은 1인1세션이라, 브라우저가 인증한 세션(EVOSESSIONID)에 Rust 클라이언트가
//! 붙는다. 이때 **브라우저와 Rust가 서로 다른 기기처럼 보이면** 서버는 세션 탈취/중복으로
//! 판단해 `notAuthorised`로 죽인다. 따라서 UA·TLS 지문·핸드셰이크 헤더를 하드코딩하면 안 되고,
//! **그 PC에서 실제로 띄운 Chrome이 보내는 값을 CDP로 읽어 그대로 복제**해야 한다.
//!
//! 실측(2026-09-01, skylinextm.evo-games.com 멀티위젯 핸드셰이크)에서 브라우저는
//! `Referer`도 `Cookie`도 **보내지 않았다**. 인증은 URL의 `EVOSESSIONID` 하나로만 이뤄진다.
//! 우리가 임의로 덧붙이던 Referer/Cookie는 브라우저엔 없는 헤더라 그 자체가 식별 신호였다.
//!
//! 그래서 이 모듈은 두 가지를 전역에 보관한다:
//!  1. `BrowserProfile` — 실제 Chrome의 UA/버전 + 브라우저가 보낸 WS 핸드셰이크 헤더 원본
//!  2. `RuntimeSecret` — 게임 번들에서 런타임 추출한 멀티위젯 크립토 시크릿
//!
//! 둘 다 CDP 훅(webview_commands)이 채워 넣고, `multi_client`가 읽어 쓴다.

use std::sync::RwLock;
use tracing::info;
use wreq_util::Emulation;

/// 브라우저 핸드셰이크에서 **우리가 복제하면 안 되는** 홉 단위/커넥션 단위 헤더.
/// wreq가 커넥션마다 직접 생성하므로 복제하면 중복되거나 깨진다.
const PER_CONNECTION_HEADERS: &[&str] = &[
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "sec-websocket-accept",
    "content-length",
];

/// HTTP/2 유사 헤더(`:method` 등). 헤더로 복제하면 안 된다.
fn is_pseudo_header(name: &str) -> bool {
    name.starts_with(':')
}

/// 실제로 띄운 Chrome에서 읽어온 신원. 하드코딩 값은 하나도 없다.
#[derive(Debug, Clone, Default)]
pub struct BrowserProfile {
    /// CDP `Browser.getVersion`의 UA. 브라우저가 실제 보내는 문자열 그대로.
    pub user_agent: Option<String>,
    /// UA에서 파싱한 Chrome 메이저 버전. TLS/HTTP2 지문 선택에 쓴다.
    pub chrome_major: Option<u32>,
    /// 게임 프론트의 `location.origin`. 게이트 호스트와 다를 수 있어 추측하면 안 된다
    /// (실측: 프론트 `spadeblackstone.evo-games.com.se` vs 게이트 `gate72_019.evo-games.com.se`).
    pub origin: Option<String>,
    /// `navigator.languages`로 만든 Accept-Language 헤더 값. PC의 언어 설정을 따른다.
    pub accept_language: Option<String>,
    /// 브라우저가 멀티위젯 WS 핸드셰이크에 실제로 보낸 헤더의 이름·값 집합.
    /// `Network.webSocketWillSendHandshakeRequest`에서 캡처한다.
    /// CDP가 주는 headers는 이미 정규화돼 있어 와이어 순서가 아니다 — 순서는 wreq의
    /// Chrome 에뮬레이션이 부여하므로, 여기서 중요한 건 **어떤 헤더를 보내고 안 보내는가**다.
    pub handshake_headers: Vec<(String, String)>,
}

impl BrowserProfile {
    /// 복제해도 되는 헤더만 골라 (이름, 값)으로 돌려준다.
    /// 커넥션 단위 헤더와 HTTP/2 유사 헤더는 제외한다(wreq가 직접 만든다).
    pub fn replayable_headers(&self) -> Vec<(&str, &str)> {
        self.handshake_headers
            .iter()
            .filter(|(k, _)| {
                let lk = k.to_ascii_lowercase();
                !is_pseudo_header(&lk) && !PER_CONNECTION_HEADERS.contains(&lk.as_str())
            })
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }

    /// 브라우저 핸드셰이크 헤더를 실제로 확보했는지. 확보 전에는 파리티를 보장할 수 없다.
    pub fn has_handshake(&self) -> bool {
        !self.handshake_headers.is_empty()
    }
}

static PROFILE: RwLock<Option<BrowserProfile>> = RwLock::new(None);
static RUNTIME_SECRET: RwLock<Option<String>> = RwLock::new(None);

/// UA 문자열에서 Chrome 메이저 버전을 뽑는다. 예: `... Chrome/152.0.0.0 ...` → 152.
pub fn parse_chrome_major(ua: &str) -> Option<u32> {
    let idx = ua.find("Chrome/")? + "Chrome/".len();
    let rest = &ua[idx..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// 실제 Chrome 버전에 가장 가까운 TLS/HTTP2 지문을 고른다.
///
/// wreq-util이 지원하는 최신 버전보다 브라우저가 최신이면(예: 로컬 152 vs 지원 147)
/// **가장 높은 지원 버전으로 클램프**한다. 나중에 wreq-util이 올라가면 이 함수 수정 없이
/// 자동으로 더 가까운 지문이 잡히도록 매핑을 버전 내림차순으로 둔다.
pub fn emulation_for(chrome_major: u32) -> Emulation {
    match chrome_major {
        0..=128 => Emulation::Chrome128,
        129 => Emulation::Chrome129,
        130 => Emulation::Chrome130,
        131 => Emulation::Chrome131,
        132 => Emulation::Chrome132,
        133 => Emulation::Chrome133,
        134 => Emulation::Chrome134,
        135 => Emulation::Chrome135,
        136 => Emulation::Chrome136,
        137 => Emulation::Chrome137,
        138 => Emulation::Chrome138,
        139 => Emulation::Chrome139,
        140 => Emulation::Chrome140,
        141 => Emulation::Chrome141,
        142 => Emulation::Chrome142,
        143 => Emulation::Chrome143,
        144 => Emulation::Chrome144,
        145 => Emulation::Chrome145,
        146 => Emulation::Chrome146,
        // 147 이상(로컬이 더 최신인 경우 포함)은 지원되는 최신 지문으로 클램프한다.
        _ => Emulation::Chrome147,
    }
}

/// 게임 페이지가 보고한 신원(UA / origin / languages)을 기록한다. 같은 값이면 조용히 무시한다.
pub fn set_page_identity(ua: &str, origin: Option<&str>, languages: &[String]) {
    let major = parse_chrome_major(ua);
    let accept_language = build_accept_language(languages);
    let mut guard = PROFILE.write().expect("browser profile lock poisoned");
    let p = guard.get_or_insert_with(BrowserProfile::default);
    let unchanged = p.user_agent.as_deref() == Some(ua)
        && p.origin.as_deref() == origin
        && p.accept_language == accept_language;
    if unchanged {
        return;
    }
    info!(
        "[BrowserProfile] 🪞 UA 미러링: {} (major={:?}, origin={:?}, lang={:?})",
        ua, major, origin, accept_language
    );
    p.user_agent = Some(ua.to_string());
    p.chrome_major = major;
    if origin.is_some() {
        p.origin = origin.map(str::to_string);
    }
    if accept_language.is_some() {
        p.accept_language = accept_language;
    }
}

/// `navigator.languages`를 Chrome이 실제로 보내는 Accept-Language 형식으로 만든다.
/// Chrome은 첫 항목엔 q를 안 붙이고 이후 0.9부터 0.1씩 낮추며, 0.1 미만으로는 안 내려간다.
/// 예: `["ko-KR","ko","en-US","en"]` → `ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7`.
fn build_accept_language(languages: &[String]) -> Option<String> {
    let langs: Vec<&String> = languages.iter().filter(|l| !l.trim().is_empty()).collect();
    let (first, rest) = langs.split_first()?;
    let mut out = (*first).clone();
    for (i, lang) in rest.iter().enumerate() {
        let q = 9_i32.saturating_sub(i as i32);
        let q = q.max(1);
        out.push_str(&format!(",{};q=0.{}", lang, q));
    }
    Some(out)
}

/// 브라우저가 멀티위젯 WS 핸드셰이크에 보낸 헤더 원본을 기록한다(순서 유지).
pub fn set_handshake_headers(headers: Vec<(String, String)>) {
    if headers.is_empty() {
        return;
    }
    let mut guard = PROFILE.write().expect("browser profile lock poisoned");
    let p = guard.get_or_insert_with(BrowserProfile::default);
    if p.handshake_headers == headers {
        return;
    }
    // UA가 헤더에 있으면 그 값이 가장 정확하다(실제 와이어 값).
    if let Some((_, ua)) = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
    {
        if p.user_agent.as_deref() != Some(ua.as_str()) {
            p.chrome_major = parse_chrome_major(ua);
            p.user_agent = Some(ua.clone());
        }
    }
    info!(
        "[BrowserProfile] 🪞 핸드셰이크 헤더 {}개 캡처 (Referer={}, Cookie={})",
        headers.len(),
        headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("referer")),
        headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie")),
    );
    p.handshake_headers = headers;
}

/// 현재 프로필 스냅샷.
pub fn profile() -> Option<BrowserProfile> {
    PROFILE.read().expect("browser profile lock poisoned").clone()
}

/// 런타임 추출한 멀티위젯 크립토 시크릿을 기록한다.
/// Evolution이 빌드마다 시크릿을 바꾸므로, 하드코딩 대신 이 값이 우선한다.
pub fn set_runtime_secret(secret: &str) {
    let mut guard = RUNTIME_SECRET.write().expect("runtime secret lock poisoned");
    if guard.as_deref() == Some(secret) {
        return;
    }
    info!(
        "[BrowserProfile] 🔑 런타임 크립토 시크릿 확보 (len={}, prefix={})",
        secret.len(),
        &secret[..secret.len().min(8)]
    );
    *guard = Some(secret.to_string());
}

/// 런타임 시크릿 조회. 없으면 `None`(호출측이 빌트인 폴백을 쓴다).
pub fn runtime_secret() -> Option<String> {
    RUNTIME_SECRET
        .read()
        .expect("runtime secret lock poisoned")
        .clone()
}

/// 시크릿이 들어올 때까지 `timeout`까지 기다린다.
///
/// 순서 문제가 있다: 브라우저가 멀티위젯 소켓을 만드는 순간 CDP가 URL을 캡처해 Rust 접속을
/// 시작하는데, 게임의 크립토 init(=시크릿이 노출되는 시점)은 그 직후 더미 소켓의 onopen에서
/// 돈다. 그래서 암호화 소켓이면 접속 전에 잠깐 기다려야 폴백(구 시크릿)으로 붙는 사고를 막는다.
/// 폴백으로 붙으면 서버가 `1007`로 끊고, 그게 밴의 시작이었다.
pub async fn wait_for_runtime_secret(timeout: std::time::Duration) -> Option<String> {
    const POLL: std::time::Duration = std::time::Duration::from_millis(50);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(s) = runtime_secret() {
            return Some(s);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// 브릿지 모드 여부의 **단일 진실 공급원**. 0=미결정, 1=브릿지, 2=레거시(직접 소켓).
///
/// 이 값이 하나의 모듈에 있어야 하는 이유: 1인1세션 정책에서 킥을 막는 핵심은 "Rust가 두 번째
/// 소켓을 절대 열지 않는 것"이고, 직접 접속 진입점이 여럿이다(캡처 핸들러, 수동 커맨드,
/// 프론트 connect 커맨드). 각자 env를 읽게 두면 하나만 빠져도 킥이 난다. `EvolutionMultiSocket::connect`
/// 가 이 함수를 보고 브릿지 모드면 무조건 거절한다(fail-closed).
static BRIDGE_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// 브릿지 모드(기본 ON). `BCR_LEGACY_RUST_SOCKET=1`이면 레거시(Rust 직접 소켓).
pub fn bridge_mode_enabled() -> bool {
    use std::sync::atomic::Ordering;
    match BRIDGE_MODE.load(Ordering::Relaxed) {
        1 => true,
        2 => false,
        _ => {
            let legacy = std::env::var("BCR_LEGACY_RUST_SOCKET")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            BRIDGE_MODE.store(if legacy { 2 } else { 1 }, Ordering::Relaxed);
            !legacy
        }
    }
}

/// 테스트 전용: 모드를 강제한다. `None`이면 다시 env에서 읽는다.
#[cfg(test)]
pub fn set_bridge_mode_for_test(mode: Option<bool>) {
    use std::sync::atomic::Ordering;
    BRIDGE_MODE.store(
        match mode {
            Some(true) => 1,
            Some(false) => 2,
            None => 0,
        },
        Ordering::Relaxed,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chrome_major_from_real_uas() {
        let mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
        assert_eq!(parse_chrome_major(mac), Some(152));
        let win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
        assert_eq!(parse_chrome_major(win), Some(136));
        assert_eq!(parse_chrome_major("no chrome here"), None);
    }

    #[test]
    fn clamps_emulation_to_supported_range() {
        // 로컬 Chrome이 지원 범위보다 최신이면 최신 지원 지문으로 클램프한다.
        assert!(matches!(emulation_for(152), Emulation::Chrome147));
        assert!(matches!(emulation_for(147), Emulation::Chrome147));
        assert!(matches!(emulation_for(140), Emulation::Chrome140));
        assert!(matches!(emulation_for(100), Emulation::Chrome128));
    }

    #[test]
    fn builds_chrome_style_accept_language() {
        // Chrome 실측 형식: 첫 항목엔 q 없음, 이후 0.9부터 0.1씩 감소.
        assert_eq!(
            build_accept_language(&[
                "ko-KR".into(),
                "ko".into(),
                "en-US".into(),
                "en".into()
            ]),
            Some("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7".into())
        );
        assert_eq!(build_accept_language(&["en-US".into()]), Some("en-US".into()));
        assert_eq!(build_accept_language(&[]), None);
    }

    #[test]
    fn replayable_headers_drop_connection_scoped_and_pseudo() {
        // 2026-09-01 실측 핸드셰이크 그대로.
        let p = BrowserProfile {
            user_agent: None,
            chrome_major: None,
            origin: None,
            accept_language: None,
            handshake_headers: vec![
                ("Upgrade".into(), "websocket".into()),
                ("Origin".into(), "https://spadeblackstone.evo-games.com.se".into()),
                ("Cache-Control".into(), "no-cache".into()),
                ("Accept-Language".into(), "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7".into()),
                ("Pragma".into(), "no-cache".into()),
                ("Connection".into(), "Upgrade".into()),
                ("Sec-WebSocket-Key".into(), "DqXONpE3VbxOOkoepdO/nQ==".into()),
                ("Accept-Encoding".into(), "gzip, deflate, br, zstd".into()),
                ("User-Agent".into(), "Mozilla/5.0 ... Chrome/152.0.0.0 ...".into()),
                ("Sec-WebSocket-Version".into(), "13".into()),
                ("Host".into(), "gate72_019.evo-games.com.se:8443".into()),
                (
                    "Sec-WebSocket-Extensions".into(),
                    "permessage-deflate; client_max_window_bits".into(),
                ),
                (":method".into(), "GET".into()),
            ],
        };
        let names: Vec<&str> = p.replayable_headers().iter().map(|(k, _)| *k).collect();
        assert_eq!(
            names,
            vec![
                "Origin",
                "Cache-Control",
                "Accept-Language",
                "Pragma",
                "Accept-Encoding",
                "User-Agent",
            ]
        );
        // 브라우저가 안 보낸 헤더는 애초에 목록에 없다 = 우리도 안 보낸다.
        assert!(!names.iter().any(|n| n.eq_ignore_ascii_case("referer")));
        assert!(!names.iter().any(|n| n.eq_ignore_ascii_case("cookie")));
    }
}
