use aura_crdt_core::{CrdtDoc, TeamMessage, ZoneClaim, IntentLogEntry, LoroPersistence};
use chrono::Utc;
use uuid::Uuid;
use loro::{VersionVector, ToJson};

struct MockPersistence;

impl LoroPersistence for MockPersistence {
    fn save_snapshot(&self, _doc_id: Uuid, _repo_id: Uuid, _snapshot_bytes: &[u8], _version_vector: &[u8]) -> impl std::future::Future<Output = Result<(), String>> {
        async { Ok(()) }
    }
    fn append_operations(&self, _doc_id: Uuid, _operations_bytes: &[u8], _version_vector_after: &[u8]) -> impl std::future::Future<Output = Result<(), String>> {
        async { Ok(()) }
    }
    fn load_latest_snapshot(&self, _doc_id: Uuid) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> {
        async { Ok(None) }
    }
    fn load_operations_since(&self, _doc_id: Uuid, _version_vector: &[u8]) -> impl std::future::Future<Output = Result<Vec<Vec<u8>>, String>> {
        async { Ok(vec![]) }
    }
    fn prune_operations(&self, _doc_id: Uuid) -> impl std::future::Future<Output = Result<(), String>> {
        async { Ok(()) }
    }
}

#[tokio::test]
async fn test_crdt_validation() {
    let persistence = MockPersistence;
    let doc_id = Uuid::new_v4();
    let doc = CrdtDoc::load(&persistence, doc_id).await.unwrap();

    let msg = TeamMessage {
        id: Uuid::new_v4(),
        sender_id: Uuid::new_v4(),
        content: "Hello, Loro!".to_string(),
        timestamp: Utc::now(),
    };

    doc.add_message(&msg).unwrap();
    let msgs = doc.get_messages();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Hello, Loro!");

    let zone = ZoneClaim {
        id: Uuid::new_v4(),
        zone_path: "src/main.rs".to_string(),
        claim_type: "exclusive".to_string(),
        status: "active".to_string(),
        critical: true,
        claimant_id: Uuid::new_v4(),
        timestamp: Utc::now(),
    };
    doc.add_zone(&zone).unwrap();
    let zones = doc.get_zones();
    assert_eq!(zones.len(), 1);
    assert_eq!(zones[0].zone_path, "src/main.rs");

    let intent1 = IntentLogEntry {
        id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        intent_type: "Feature".to_string(),
        summary: "First".to_string(),
        file_path: "src/main.rs".to_string(),
        lamport_clock: 2,
        timestamp: Utc::now(),
    };
    let intent2 = IntentLogEntry {
        id: Uuid::new_v4(),
        user_id: Uuid::new_v4(),
        intent_type: "BugFix".to_string(),
        summary: "Second".to_string(),
        file_path: "src/main.rs".to_string(),
        lamport_clock: 1,
        timestamp: Utc::now(),
    };
    doc.add_intent(&intent1).unwrap();
    doc.add_intent(&intent2).unwrap();
    let intents = doc.get_intent_log();
    assert_eq!(intents.len(), 2);
    // Semantic ordering: lamport_clock 1 comes before lamport_clock 2
    assert_eq!(intents[0].summary, "Second");
    assert_eq!(intents[1].summary, "First");

    // Validate a patch
    let updates = doc.doc().export_from(&VersionVector::new());
    
    // Apply valid update
    let doc2 = CrdtDoc::new();
    let res = doc2.apply_and_validate(&updates, Uuid::new_v4());
    assert!(res.is_ok(), "Valid update should be applied");

    // Check invalid update
    let bad_msg = TeamMessage {
        id: Uuid::new_v4(),
        sender_id: Uuid::new_v4(),
        content: "".to_string(),
        timestamp: Utc::now(),
    };
    doc.add_message(&bad_msg).unwrap();
    let bad_updates = doc.doc().export_from(&VersionVector::new());
    
    let doc3 = CrdtDoc::new();
    let res2 = doc3.apply_and_validate(&bad_updates, Uuid::new_v4());
    assert!(res2.is_err(), "Empty message content should be rejected");

    // Test Undo Manager integration
    let mut doc4 = CrdtDoc::new();
    
    let msg1 = TeamMessage {
        id: Uuid::new_v4(),
        sender_id: Uuid::new_v4(),
        content: "Message 1".to_string(),
        timestamp: Utc::now(),
    };
    let msg2 = TeamMessage {
        id: Uuid::new_v4(),
        sender_id: Uuid::new_v4(),
        content: "Message 2".to_string(),
        timestamp: Utc::now(),
    };

    doc4.add_message(&msg1).unwrap();
    // Record checkpoint manually to undo just msg2
    doc4.record_checkpoint().unwrap();
    doc4.add_message(&msg2).unwrap();
    
    assert_eq!(doc4.get_messages().len(), 2);
    
    // Sync doc4 state to doc5 first!
    let doc5 = CrdtDoc::new();
    doc5.apply_and_validate(&doc4.doc().export_from(&VersionVector::new()), Uuid::new_v4()).unwrap();
    assert_eq!(doc5.get_messages().len(), 2);
    
    // Rewind msg2 on doc4
    let inverse_patch = doc4.aura_rewind_op().unwrap();
    assert_eq!(doc4.get_messages().len(), 1);
    assert_eq!(doc4.get_messages()[0].content, "Message 1");
    
    // Apply inverse patch to doc5
    doc5.apply_and_validate(&inverse_patch, Uuid::new_v4()).unwrap();
    assert_eq!(doc5.get_messages().len(), 1); // doc5 now has 1 message after applying inverse patch
    assert_eq!(doc5.get_messages()[0].content, "Message 1");
}