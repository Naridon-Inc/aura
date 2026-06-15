//! Unified embedding engine (Memory W1 / AURA-39).
//!
//! One place answers "turn this text into a vector" for the whole CLI —
//! project-memory recall, checkpoint `intent_vector`s, and `aura ask`.
//! Two paths:
//!
//! - **Cloud** (OpenAI → Gemini, whichever key exists): true semantic
//!   vectors. Moved here verbatim from `main.rs::generate_embedding`,
//!   plus an explicit timeout so write paths never hang on a dead API.
//! - **Local** ([`embed_local`]): a deterministic char-trigram + word
//!   feature-hash vector. No model download, no key, fully offline —
//!   the sovereign fallback. It captures lexical/morphological
//!   similarity (shared identifiers, stems, names), which is exactly
//!   what code-adjacent memory queries lean on.
//!
//! Every vector is stamped with the **model id** that produced it.
//! Vectors from different models live in different spaces — comparing
//! them is noise — so consumers store the stamp next to the vector and
//! only cosine within the same model (see `memory::retrieval`).
//!
//! `config.use_local_embeddings = true` forces the local path (100%
//! offline). Otherwise cloud is tried first and local is the fallback,
//! so `embed()` always returns a usable vector.

use crate::config::ConfigManager;

/// Model id stamped on locally-hashed vectors.
pub const LOCAL_MODEL: &str = "aura-local-trigram-v1";
/// Dimensionality of the local feature-hash space.
pub const LOCAL_DIMS: usize = 256;

/// Embed `text`, honoring `use_local_embeddings`. Returns the vector and
/// the id of the model that produced it. Only `None` for empty input.
pub fn embed(text: &str) -> Option<(Vec<f32>, String)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let config = ConfigManager::load();
    if !config.use_local_embeddings {
        if let Some(hit) = embed_remote(trimmed) {
            return Some(hit);
        }
    }
    Some((embed_local(trimmed), LOCAL_MODEL.to_string()))
}

/// Cloud embedding: OpenAI first (if keyed), then Gemini. `None` when no
/// key is configured or both providers fail — callers fall back to local.
pub fn embed_remote(text: &str) -> Option<(Vec<f32>, String)> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;

    if let Some(openai_key) = ConfigManager::get_api_key("openai") {
        let body = serde_json::json!({
            "model": "text-embedding-3-small",
            "input": text
        });

        if let Ok(res) = client
            .post("https://api.openai.com/v1/embeddings")
            .bearer_auth(openai_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
        {
            if let Ok(json) = res.json::<serde_json::Value>() {
                if let Some(data) = json["data"].as_array() {
                    if let Some(embedding) = data.get(0).and_then(|d| d["embedding"].as_array()) {
                        let vec: Vec<f32> = embedding
                            .iter()
                            .filter_map(|v| v.as_f64().map(|f| f as f32))
                            .collect();
                        if !vec.is_empty() {
                            return Some((vec, "openai:text-embedding-3-small".to_string()));
                        }
                    }
                }
            }
        }
    }

    if let Some(gemini_key) = ConfigManager::get_api_key("gemini") {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={}",
            gemini_key
        );
        let body = serde_json::json!({
            "model": "models/gemini-embedding-001",
            "content": {
                "parts": [{ "text": text }]
            }
        });

        if let Ok(res) = client.post(&url).json(&body).send() {
            if let Ok(json) = res.json::<serde_json::Value>() {
                if let Some(values) = json["embedding"]["values"].as_array() {
                    let vec: Vec<f32> = values
                        .iter()
                        .filter_map(|v| v.as_f64().map(|f| f as f32))
                        .collect();
                    if !vec.is_empty() {
                        return Some((vec, "gemini:gemini-embedding-001".to_string()));
                    }
                }
            }
        }
    }

    None
}

/// Deterministic offline embedding: char trigrams + word unigrams,
/// feature-hashed into [`LOCAL_DIMS`] buckets, tf-weighted, L2-normalized.
/// Same text → same vector, on every machine, with zero dependencies.
pub fn embed_local(text: &str) -> Vec<f32> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut v = vec![0f32; LOCAL_DIMS];
    let normalized = text.to_lowercase();

    let mut bump = |feature: &str| {
        let mut h = DefaultHasher::new();
        feature.hash(&mut h);
        let bucket = (h.finish() as usize) % LOCAL_DIMS;
        // Second independent hash picks the sign, which de-correlates
        // colliding features (standard feature-hashing trick).
        let mut h2 = DefaultHasher::new();
        (feature, 0x9e37u16).hash(&mut h2);
        let sign = if h2.finish() & 1 == 0 { 1.0 } else { -1.0 };
        v[bucket] += sign;
    };

    for word in normalized.split(|c: char| !c.is_alphanumeric()) {
        if word.len() < 2 {
            continue;
        }
        bump(word);
        let chars: Vec<char> = word.chars().collect();
        if chars.len() >= 3 {
            for w in chars.windows(3) {
                let tri: String = w.iter().collect();
                bump(&tri);
            }
        }
    }

    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v
}

/// Cosine similarity between two vectors (0.0 when either is zero-length).
/// Callers MUST only compare vectors stamped with the same model id.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_embed_is_deterministic_and_normalized() {
        let a = embed_local("refactor the retry logic for rate limits");
        let b = embed_local("refactor the retry logic for rate limits");
        assert_eq!(a, b, "same text must hash to the same vector");
        assert_eq!(a.len(), LOCAL_DIMS);
        let norm: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "vector must be L2-normalized");
    }

    #[test]
    fn local_embed_ranks_related_text_above_unrelated() {
        let query = embed_local("authentication token refresh");
        let related = embed_local("the auth token refresh flow re-issues tokens");
        let unrelated = embed_local("tailwind css grid layout breakpoints");
        let s_related = cosine_similarity(&query, &related);
        let s_unrelated = cosine_similarity(&query, &unrelated);
        assert!(
            s_related > s_unrelated,
            "related ({s_related}) must beat unrelated ({s_unrelated})"
        );
    }

    #[test]
    fn cosine_guards_mismatched_lengths() {
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0, 0.0]), 0.0);
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }
}
