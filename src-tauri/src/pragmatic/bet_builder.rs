use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BetCode(u8);

impl BetCode {
    pub fn as_u8(self) -> u8 {
        self.0
    }
    /// 전체 취소 코드(라이브 캡처 2026-09-03: `<bet amt="0" bc="8"/>`).
    pub fn cancel() -> Self {
        BetCode(8)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BetTypeError {
    Invalid(String),
}

pub fn normalize_table_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("pragmatic:")
        .trim_start_matches("table-")
        .to_string()
}

pub fn parse_bet_type(value: &str) -> Result<BetCode, BetTypeError> {
    let normalized = value.trim().to_ascii_lowercase().replace(['_', '-'], " ");

    match normalized.as_str() {
        "p" | "player" => Ok(BetCode(0)),
        "b" | "banker" => Ok(BetCode(1)),
        "t" | "tie" => Ok(BetCode(2)),
        "pp" | "p pair" | "player pair" | "playerpair" => Ok(BetCode(3)),
        "bp" | "b pair" | "banker pair" | "bankerpair" => Ok(BetCode(4)),
        _ => Err(BetTypeError::Invalid(value.to_string())),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn build_bet_xml(
    table_id: &str,
    bet_code: BetCode,
    amount: u64,
    game_id: &str,
    user_id: &str,
    ck: i64,
) -> String {
    let table_id = xml_escape_attr(&normalize_table_id(table_id));
    let game_id = xml_escape_attr(game_id);
    let user_id = xml_escape_attr(user_id);

    format!(
        r#"<command channel="table-{table_id}"><lpbet gm="mtb_desktop" gId="{game_id}" uId="{user_id}" ck="{ck}"><bet amt="{amount}" bc="{}" ck="{ck}" /></lpbet></command>"#,
        bet_code.as_u8()
    )
}

fn xml_escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_rose_pragmatic_bet_codes() {
        assert_eq!(parse_bet_type("player").unwrap().as_u8(), 0);
        assert_eq!(parse_bet_type("banker").unwrap().as_u8(), 1);
        assert_eq!(parse_bet_type("tie").unwrap().as_u8(), 2);
        assert_eq!(parse_bet_type("player_pair").unwrap().as_u8(), 3);
        assert_eq!(parse_bet_type("banker-pair").unwrap().as_u8(), 4);
    }

    #[test]
    fn builds_rose_lpbet_xml() {
        let xml = build_bet_xml("table-413", BetCode(1), 5000, "G-1", "user-1", 123);

        assert_eq!(
            xml,
            r#"<command channel="table-413"><lpbet gm="mtb_desktop" gId="G-1" uId="user-1" ck="123"><bet amt="5000" bc="1" ck="123" /></lpbet></command>"#
        );
    }
}
