//! Evolution 멀티위젯 소켓 프레임 암복호 (RC4 + zstd).
//!
//! Evolution client_version 6.20260828(2026-08-28 빌드)부터 멀티위젯 소켓
//! (`/public/.../multiwidget/socket`)이 바이너리 암호화 프레임을 쓴다. 평문 JSON을
//! 보내면 서버가 `1003 plaintext is not supported`로 끊고, 재연결이 세션을 태워
//! 화면에 EV.7(notAuthorised)이 뜬다.
//!
//! 스킴(프론트엔드 commons.js 역난독화 + 실트래픽 캡처로 확정·검증):
//! ```text
//! Frame(binary) = [0x01][algo] + RC4(inner)
//!   byte0 = 0x01                버전. 다르면 서버가 거부.
//!   byte1 = algo                1=rc4, 3=rc4(+압축 서비스 존재), 2/4=aes-gcm(미사용)
//!   inner (= RC4 복호 결과) = [flag] + payload
//!     flag 0x00 → payload = raw JSON(UTF-8)
//!     flag 0x01 → payload = zstd 프레임 → 풀면 JSON
//! ```
//! RC4 키 = UTF8(`RC4_SECRET + ":" + instanceId + ":" + nonce`). instanceId·nonce는
//! 소켓 URL의 `instance`·`nonce` 쿼리 파라미터(nonce는 base64 문자열 그대로)다.
//! RC4 S-box는 연결당 1회 KSA로 만들고, 프레임마다 사본을 써서 키스트림이 리셋된다
//! (그래서 같은 평문 → 같은 암호문). 송·수신 동일 키.

/// 마지막으로 확인된 RC4 파생 시크릿(6.20260828 빌드). **폴백 전용**.
///
/// Evolution은 빌드마다 이 값을 바꾼다(6.20260828 → 6.20260901에서 로테이션 확인).
/// 그래서 정상 경로는 CDP 훅이 게임 번들에서 런타임 추출해 `browser_profile::set_runtime_secret`
/// 으로 넣어준 값이고, 이 상수는 추출 실패 시의 마지막 수단이다. 틀린 키로 붙으면 서버가
/// `1007 malformed data`로 끊고 재연결이 세션을 태우므로, 호출측은 복호 실패를 치명 오류로 다뤄야 한다.
const RC4_SECRET_FALLBACK: &str =
    "9e7ab238f42eebf3547861a1576efdd9f5dcfef0060cef43a52b205a68117272";

/// 멀티위젯 프레임 암복호기. 연결당 하나.
#[derive(Clone)]
pub struct MultiwidgetCrypto {
    /// KSA로 초기화된 S-box. 프레임마다 복사해서 사용한다(리셋).
    sbox: [u8; 256],
    /// 이 크립토가 런타임 추출 시크릿으로 만들어졌는지(진단·로깅용).
    from_runtime_secret: bool,
}

impl MultiwidgetCrypto {
    /// URL의 instance·nonce로 RC4 키를 조립해 초기화한다.
    /// 시크릿은 런타임 추출값을 우선 쓰고, 없으면 빌트인 폴백을 쓴다.
    pub fn new(instance: &str, nonce: &str) -> Self {
        match super::browser_profile::runtime_secret() {
            Some(secret) => Self::with_secret(&secret, instance, nonce, true),
            None => Self::with_secret(RC4_SECRET_FALLBACK, instance, nonce, false),
        }
    }

    /// 시크릿을 명시해 초기화한다(테스트·런타임 추출 경로).
    pub fn with_secret(
        secret: &str,
        instance: &str,
        nonce: &str,
        from_runtime_secret: bool,
    ) -> Self {
        let key = format!("{}:{}:{}", secret, instance, nonce);
        Self {
            sbox: rc4_ksa(key.as_bytes()),
            from_runtime_secret,
        }
    }

    /// 런타임 추출 시크릿으로 만들어졌는지. false면 폴백이라 로테이션에 취약하다.
    pub fn uses_runtime_secret(&self) -> bool {
        self.from_runtime_secret
    }

    /// RC4 PRGA. 매 호출마다 S-box 사본을 써서 키스트림이 처음부터 시작한다.
    fn process(&self, data: &[u8]) -> Vec<u8> {
        let mut s = self.sbox;
        let (mut i, mut j) = (0u8, 0u8);
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[i as usize]);
            s.swap(i as usize, j as usize);
            let k = s[(s[i as usize].wrapping_add(s[j as usize])) as usize];
            out.push(b ^ k);
        }
        out
    }

    /// JSON 텍스트를 프레임으로 암호화한다. 브라우저 송신과 동일하게 무압축(flag=0)으로 보낸다:
    /// `[0x01, 0x03] + RC4([0x00] + json)`. (압축 인코더가 필요 없다 — 송신은 무압축이 정상.)
    pub fn encrypt(&self, json: &[u8]) -> Vec<u8> {
        let mut inner = Vec::with_capacity(1 + json.len());
        inner.push(0x00); // flag: 무압축
        inner.extend_from_slice(json);
        let enc = self.process(&inner);
        let mut frame = Vec::with_capacity(2 + enc.len());
        frame.push(0x01); // version
        frame.push(0x03); // algo: rc4(+압축 서비스 존재) — 브라우저 송신과 동일
        frame.extend_from_slice(&enc);
        frame
    }

    /// 수신 바이너리 프레임을 복호화해 JSON 바이트로 되돌린다.
    pub fn decrypt(&self, frame: &[u8]) -> Result<Vec<u8>, String> {
        if frame.len() < 3 {
            return Err(format!("frame too short: {} bytes", frame.len()));
        }
        if frame[0] != 0x01 {
            return Err(format!("unsupported version: {}", frame[0]));
        }
        let algo = frame[1];
        if algo != 1 && algo != 3 {
            // 2/4 = aes-gcm. 멀티위젯은 rc4만 쓴다.
            return Err(format!("unsupported algo: {}", algo));
        }
        let dec = self.process(&frame[2..]);
        let flag = dec[0];
        let rest = &dec[1..];
        match flag {
            0 => Ok(rest.to_vec()),
            1 => zstd::decode_all(rest)
                .map_err(|e| format!("zstd decompress failed: {}", e)),
            other => Err(format!("unknown compression flag: {}", other)),
        }
    }
}

/// RC4 KSA: 키에서 초기 S-box를 만든다.
fn rc4_ksa(key: &[u8]) -> [u8; 256] {
    let mut s = [0u8; 256];
    for (i, b) in s.iter_mut().enumerate() {
        *b = i as u8;
    }
    let mut j = 0u8;
    for i in 0..256 {
        j = j
            .wrapping_add(s[i])
            .wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-08-30 브라우저 실트래픽에서 캡처한 실제 프레임·키.
    // 테스트는 그날의 시크릿을 명시적으로 고정한다 — 런타임 추출값에 영향받지 않게.
    const SECRET_20260828: &str = RC4_SECRET_FALLBACK;
    const INSTANCE: &str = "9c1ulp-ubcgfgwsxmjqgzei-";
    const NONCE: &str = "ASHKOnDY54MI0I8G/aqycA==";
    // 송신 프레임(base64). 복호 시 settings.read JSON이 나와야 한다.
    const SENT_FRAME_B64: &str = "AQPLrqelnm1bGGnVrX5KeaWBt2lNcb5YpF0uwIVDJ1HI6KI/alDIX8CmsMgQMEWNJZAg1uGA1yIJMaOgavuQQ3ayfSHOnULt0KLX1bai5brDkF9Jcg2jQVjRSApWUgpVStDkUsCjHAI+sL5BqhBOtpb777krbv8SmZKBYjniolEKn0NpqfBhKPhqaDLMmdGQYBk5g/+O";

    fn b64(s: &str) -> Vec<u8> {
        // 테스트 전용 최소 base64 디코더(표준 알파벳, '='패딩).
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut rev = [255u8; 256];
        for (i, &c) in T.iter().enumerate() {
            rev[c as usize] = i as u8;
        }
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for &c in s.as_bytes() {
            if c == b'=' {
                break;
            }
            let v = rev[c as usize];
            if v == 255 {
                continue;
            }
            acc = (acc << 6) | v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn decrypts_captured_sent_frame_to_expected_json() {
        let crypto = MultiwidgetCrypto::with_secret(SECRET_20260828, INSTANCE, NONCE, false);
        let frame = b64(SENT_FRAME_B64);
        let json = crypto.decrypt(&frame).expect("decrypt");
        let text = String::from_utf8(json).expect("utf8");
        assert!(
            text.starts_with(r#"{"id":"1syloo4lz2","type":"settings.read""#),
            "예상과 다른 복호 결과: {}",
            &text[..text.len().min(80)]
        );
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let crypto = MultiwidgetCrypto::with_secret(SECRET_20260828, INSTANCE, NONCE, false);
        let msg = br#"{"id":"abc","type":"widget.subscribeTable","args":{"tableId":"x"}}"#;
        let frame = crypto.encrypt(msg);
        assert_eq!(&frame[..2], &[0x01, 0x03]);
        let back = crypto.decrypt(&frame).expect("decrypt");
        assert_eq!(back, msg);
    }

    #[test]
    fn encrypt_matches_browser_shape_for_known_plaintext() {
        // 캡처된 SENT 프레임과 동일한 평문을 무압축 암호화하면 바이트가 일치해야 한다
        // (같은 키·무압축·리셋 키스트림 → 결정적).
        let crypto = MultiwidgetCrypto::with_secret(SECRET_20260828, INSTANCE, NONCE, false);
        let json = br#"{"id":"1syloo4lz2","type":"settings.read","args":{"keys":["generic.common","multiplay.common","baccarat.common","generic.phone","generic.tablet"]}}"#;
        let frame = crypto.encrypt(json);
        assert_eq!(frame, b64(SENT_FRAME_B64));
    }
}
