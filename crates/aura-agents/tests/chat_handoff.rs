use aura_agents::{cursor::Cursor, kimi_coder::KimiCoder, opencode::OpenCode, AgentProvider, InvokeMode, InvokeRequest};

#[test]
fn terminal_handoff_keeps_exact_session_and_model_without_bypassing_permissions() {
    let providers: Vec<(Box<dyn AgentProvider>, &str)> = vec![
        (Box::new(Cursor), "--resume"),
        (Box::new(KimiCoder), "--session"),
        (Box::new(OpenCode), "-s"),
    ];
    for (provider, resume_flag) in providers {
        let request = InvokeRequest {
            prompt: "", mode: InvokeMode::PtyRepl,
            resume_session_id: Some("exact-native-session"), model: Some("custom/model"),
            attachments_via_stdin: false, effort: None, fast: false, approval: None,
        };
        let invocation = provider.build_invocation(&request).unwrap();
        let model_flag = if provider.id() == "opencode" { "-m" } else { "--model" };
        assert!(invocation.args.windows(2).any(|p| p == [resume_flag, "exact-native-session"]), "{} must resume the exact session", provider.id());
        assert!(invocation.args.windows(2).any(|p| p == [model_flag, "custom/model"]), "{} must keep the selected model", provider.id());
        assert_eq!(invocation.args.len(), 4, "{} must not add permission bypasses", provider.id());
        let fresh = provider.build_invocation(&InvokeRequest { resume_session_id: None, model: None, ..request }).unwrap();
        assert!(fresh.args.is_empty(), "{} must retain its native defaults", provider.id());
    }
}
