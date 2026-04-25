//! Performance baseline micro-benchmarks.
//!
//! Run with: `cargo bench`
//!
//! These benches measure **allocation-sensitive hot paths** flagged in
//! `.forge/perf-plan/plan.md` (Rust Critical #3). They run without any
//! WebSocket or Tauri dependency — pure deserialization / construction.
//!
//! NOT a workload simulation. For steady-state multi-room memory behaviour,
//! run the actual app and follow the procedure in
//! `.forge/perf-plan/baseline.md` K1/K2.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use serde_json::Value;

/// Minimal representative Evolution game-result payload (synthetic, shape only).
const SAMPLE_GAME_RESULT_JSON: &str = r#"{
    "type": "game.round.finished",
    "tableId": "pbbaccarat000001",
    "data": {
        "result": { "winner": "banker", "playerPair": false, "bankerPair": false },
        "history": [
            { "winner": "B" }, { "winner": "P" }, { "winner": "B" },
            { "winner": "T" }, { "winner": "P" }, { "winner": "B" },
            { "winner": "B" }, { "winner": "P" }, { "winner": "P" },
            { "winner": "B" }
        ],
        "gameCount": 42,
        "remainingSeconds": 12
    }
}"#;

/// Bench: parse a typical inbound WebSocket frame as `serde_json::Value`.
/// Upper bound on per-message parse cost.
fn bench_parse_generic_value(c: &mut Criterion) {
    c.bench_function("parse_generic_value", |b| {
        b.iter(|| {
            let v: Value = serde_json::from_str(black_box(SAMPLE_GAME_RESULT_JSON)).unwrap();
            black_box(v);
        });
    });
}

/// Bench: clone a 100-element history Vec — upper bound on the hot-path clone
/// patterns described in the Rust audit (`.forge/perf-plan/plan.md` Lane R3).
fn bench_clone_history_vec(c: &mut Criterion) {
    #[derive(Clone)]
    #[allow(dead_code)]
    struct GameRound {
        winner: char,
        player_pair: bool,
        banker_pair: bool,
    }

    let history: Vec<GameRound> = (0..100)
        .map(|i| GameRound {
            winner: match i % 3 { 0 => 'B', 1 => 'P', _ => 'T' },
            player_pair: i % 5 == 0,
            banker_pair: i % 7 == 0,
        })
        .collect();

    c.bench_function("clone_history_vec_100", |b| {
        b.iter(|| {
            let cloned = black_box(&history).clone();
            black_box(cloned);
        });
    });

    let shared = std::sync::Arc::new(history.clone());
    c.bench_function("arc_clone_history_vec_100", |b| {
        b.iter(|| {
            let cloned = std::sync::Arc::clone(black_box(&shared));
            black_box(cloned);
        });
    });
}

criterion_group!(benches, bench_parse_generic_value, bench_clone_history_vec);
criterion_main!(benches);
