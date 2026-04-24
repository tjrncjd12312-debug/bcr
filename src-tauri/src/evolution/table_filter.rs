//! Evolution Table Filter
//!
//! 테이블 목록에서 바카라 테이블만 필터링하는 로직을 분리합니다.
//! 다국어 테이블명(한국어, 일본어) 및 다양한 config 구조를 지원합니다.

use super::message_parser::TableInfo;
use tracing::{debug, warn};

/// 테이블 필터
pub struct TableFilter;

impl TableFilter {
    /// 바카라 테이블만 필터링하여 테이블 ID 목록 반환
    ///
    /// # Arguments
    /// * `tables` - 전체 테이블 정보 목록
    ///
    /// # Returns
    /// 바카라 테이블 ID 목록. 필터링 결과가 0이면 전체 테이블 반환 (fallback)
    pub fn filter_baccarat_tables(tables: &[TableInfo]) -> Vec<String> {
        let baccarat_ids: Vec<String> = tables
            .iter()
            .filter(|t| Self::is_baccarat_table(t))
            .map(|t| t.table_id.clone())
            .collect();

        // Fallback: 필터 결과가 비어있으면 전체 테이블 반환
        if baccarat_ids.is_empty() {
            warn!("[TableFilter] ⚠️ Baccarat filter matched 0 tables. Falling back to all available tables.");
            return tables.iter().map(|t| t.table_id.clone()).collect();
        }

        debug!(
            "[TableFilter] 🎰 Filtered {} baccarat tables from {} total",
            baccarat_ids.len(),
            tables.len()
        );

        baccarat_ids
    }

    /// 단일 테이블이 바카라인지 확인
    pub fn is_baccarat_table(table: &TableInfo) -> bool {
        // 1. 테이블명으로 확인 (다국어 지원)
        if let Some(name) = &table.table_name {
            if Self::is_baccarat_name(name) {
                return true;
            }
        }

        // 2. gameType으로 확인
        if let Some(game_type) = &table.game_type {
            if Self::is_baccarat_game_type(game_type) {
                return true;
            }
        }

        // 3. roadmapType으로 확인
        if let Some(roadmap_type) = &table.roadmap_type {
            if roadmap_type.to_lowercase().contains("baccarat") {
                return true;
            }
        }

        false
    }

    /// 테이블명이 바카라인지 확인 (다국어 지원)
    fn is_baccarat_name(name: &str) -> bool {
        let name_lower = name.to_lowercase();

        // 영어
        if name_lower.contains("baccarat") || name_lower.contains("bac") {
            return true;
        }

        // 일본어: バカラ
        if name.contains("バカラ") {
            return true;
        }

        // 한국어: 바카라, 바카
        if name.contains("바카라") || name.contains("바카") {
            return true;
        }

        false
    }

    /// gameType이 바카라인지 확인
    fn is_baccarat_game_type(game_type: &str) -> bool {
        let gt_lower = game_type.to_lowercase();
        gt_lower.contains("baccarat")
    }

    /// 테이블 목록 중 일부만 선택 (최대 개수 제한)
    pub fn take_tables(table_ids: Vec<String>, max_count: usize) -> Vec<String> {
        table_ids.into_iter().take(max_count).collect()
    }

    /// 디버그용: 첫 번째 테이블의 메타 정보 로깅
    pub fn log_first_table_meta(tables: &[TableInfo]) {
        if let Some(first) = tables.first() {
            let name = first.table_name.as_deref().unwrap_or("");
            let game_type = first.game_type.as_deref().unwrap_or("");
            debug!(
                "[TableFilter] 🧩 First table: name='{}', gameType='{}'",
                name, game_type
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_table(id: &str, name: Option<&str>, game_type: Option<&str>) -> TableInfo {
        TableInfo {
            table_id: id.to_string(),
            table_name: name.map(|s| s.to_string()),
            game_type: game_type.map(|s| s.to_string()),
            roadmap_type: None,
            raw_config: None,
        }
    }

    #[test]
    fn test_filter_baccarat_by_name() {
        let tables = vec![
            make_table("t1", Some("Speed Baccarat A"), None),
            make_table("t2", Some("Blackjack VIP"), None),
            make_table("t3", Some("Lightning Bac"), None),
        ];

        let result = TableFilter::filter_baccarat_tables(&tables);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"t1".to_string()));
        assert!(result.contains(&"t3".to_string()));
    }

    #[test]
    fn test_filter_baccarat_by_game_type() {
        let tables = vec![
            make_table("t1", Some("Table A"), Some("baccarat")),
            make_table("t2", Some("Table B"), Some("blackjack")),
            make_table("t3", Some("Table C"), Some("speedBaccarat")),
        ];

        let result = TableFilter::filter_baccarat_tables(&tables);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"t1".to_string()));
        assert!(result.contains(&"t3".to_string()));
    }

    #[test]
    fn test_filter_baccarat_korean_name() {
        let tables = vec![
            make_table("t1", Some("바카라 A"), None),
            make_table("t2", Some("슬롯 게임"), None),
            make_table("t3", Some("스피드 바카"), None),
        ];

        let result = TableFilter::filter_baccarat_tables(&tables);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"t1".to_string()));
        assert!(result.contains(&"t3".to_string()));
    }

    #[test]
    fn test_filter_baccarat_japanese_name() {
        let tables = vec![
            make_table("t1", Some("スピードバカラ"), None),
            make_table("t2", Some("ブラックジャック"), None),
        ];

        let result = TableFilter::filter_baccarat_tables(&tables);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&"t1".to_string()));
    }

    #[test]
    fn test_fallback_when_no_baccarat() {
        let tables = vec![
            make_table("t1", Some("Blackjack A"), Some("blackjack")),
            make_table("t2", Some("Roulette B"), Some("roulette")),
        ];

        let result = TableFilter::filter_baccarat_tables(&tables);
        // Fallback: 전체 반환
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_take_tables() {
        let ids = vec![
            "t1".to_string(),
            "t2".to_string(),
            "t3".to_string(),
            "t4".to_string(),
            "t5".to_string(),
        ];

        let result = TableFilter::take_tables(ids, 3);
        assert_eq!(result.len(), 3);
        assert_eq!(result, vec!["t1", "t2", "t3"]);
    }

    #[test]
    fn test_is_baccarat_table() {
        let bac_table = make_table("t1", Some("Baccarat VIP"), None);
        let other_table = make_table("t2", Some("Blackjack"), None);

        assert!(TableFilter::is_baccarat_table(&bac_table));
        assert!(!TableFilter::is_baccarat_table(&other_table));
    }

    #[test]
    fn test_roadmap_type_baccarat() {
        let table = TableInfo {
            table_id: "t1".to_string(),
            table_name: Some("Generic Table".to_string()),
            game_type: None,
            roadmap_type: Some("baccarat_roadmap".to_string()),
            raw_config: None,
        };

        assert!(TableFilter::is_baccarat_table(&table));
    }
}
