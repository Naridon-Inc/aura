use aura_policy::contracts::{SandboxRequest, VerifierRequest, SchemaValidator};
use aura_policy::cedar::CedarEvaluator;
use serde_json::json;

#[tokio::test]
async fn test_end_to_end_contracts() {
    let sandbox_req = SandboxRequest {
        block_id: "block_123".to_string(),
        payload: json!({ "command": "echo test" }),
        context: std::collections::HashMap::new(),
    };

    let verifier_req = VerifierRequest {
        block_id: "block_123".to_string(),
        target_invariant: "state.is_valid".to_string(),
        ast_context: json!({ "fn": "handle_event" }),
    };

    let sandbox_schema = SchemaValidator::new::<SandboxRequest>();
    let verifier_schema = SchemaValidator::new::<VerifierRequest>();

    assert!(sandbox_schema.validate(&serde_json::to_value(&sandbox_req).unwrap()).is_ok());
    assert!(verifier_schema.validate(&serde_json::to_value(&verifier_req).unwrap()).is_ok());

    let policy_src = r#"
        permit(
            principal,
            action == Action::"Command",
            resource == Resource::"aura_workspace"
        );
    "#;

    let entities_json = r#"[
        {
            "uid": { "type": "User", "id": "did:aura:user/tester" },
            "attrs": {},
            "parents": []
        },
        {
            "uid": { "type": "Action", "id": "Command" },
            "attrs": {},
            "parents": []
        },
        {
            "uid": { "type": "Resource", "id": "aura_workspace" },
            "attrs": {},
            "parents": []
        }
    ]"#;

    let _cedar = CedarEvaluator::new(policy_src, entities_json).unwrap();
    // Simulate successful load
}