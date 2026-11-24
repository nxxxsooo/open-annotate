use std::process::Command;

#[test]
#[allow(clippy::expect_used, reason = "test failures should name their setup operation")]
fn a_changed_focus_reports_failure_without_a_send_intent() {
    let directory = std::env::temp_dir().join(format!("annotate-hosted-pane-test-{}", std::process::id()));
    std::fs::create_dir(&directory).expect("private review directory");
    let marker = directory.join("send-intent");
    let output = Command::new(env!("CARGO_BIN_EXE_annotate-tui"))
        .args(["herdr", "hosted-pane"])
        .env("HERDR_ENV", "1")
        .env("HERDR_PLUGIN_CONTEXT_JSON", r#"{"focused_pane_id":"w1:p2"}"#)
        .env("ANNOTATE_AGY_SOURCE_PANE", "w1:p1")
        .env("ANNOTATE_AGY_REVIEW_DIR", &directory)
        .env("PLANNOTATOR_TUI_SEND_INTENT", &marker)
        .output()
        .expect("run native popup entrypoint");
    let status = std::fs::read_to_string(directory.join("done")).expect("completion status");
    let intent_exists = marker.exists();
    std::fs::remove_dir_all(&directory).expect("clean up review directory");
    assert!(!output.status.success());
    assert!(status.contains("focus changed"), "{status}");
    assert!(!intent_exists);
}
