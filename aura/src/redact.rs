use std::collections::HashMap;
use regex::Regex;

/// The Semantic Scrubber: Uses Information Theory and Regex to protect data.
pub struct Redactor;

impl Redactor {
    /// Main entry point to scrub a string before it leaves the local machine.
    pub fn scrub(text: &str) -> String {
        // Pass 1: Pattern-based heuristic scrubbing (Regex)
        let mut scrubbed = Self::scrub_patterns(text);

        // Pass 2: Information Theory scrubbing (Shannon Entropy)
        scrubbed = Self::scrub_high_entropy(&scrubbed);

        scrubbed
    }

    /// PASS 1: Scrub known patterns like emails, IPs, and common token prefixes.
    fn scrub_patterns(text: &str) -> String {
        let mut result = text.to_string();

        // Email Pattern
        let email_re = Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}").unwrap();
        result = email_re.replace_all(&result, "[REDACTED_EMAIL]").to_string();

        // IPv4 Pattern
        let ip_re = Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap();
        result = ip_re.replace_all(&result, "[REDACTED_IP]").to_string();

        // Common API Key Prefixes (e.g., sk-..., ghp_..., xoxb-...)
        let token_re = Regex::new(r"(?i)(sk-|ghp_|xoxb-|AIza)[a-zA-Z0-9_\-]+").unwrap();
        result = token_re.replace_all(&result, "[REDACTED_TOKEN]").to_string();

        result
    }

    /// PASS 2: Scrub tokens with high Shannon Entropy (cryptographic keys, base64 payloads).
    fn scrub_high_entropy(text: &str) -> String {
        let mut tokens: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();

        for token in tokens.iter_mut() {
            // Only analyze tokens of significant length (e.g., > 12 chars)
            if token.len() > 12 {
                let entropy = Self::calculate_shannon_entropy(token);
                // Threshold: 4.5 bits/char is a strong indicator of random data/keys.
                if entropy > 4.5 {
                    *token = "[REDACTED_HIGH_ENTROPY]".to_string();
                }
            }
        }

        tokens.join(" ")
    }

    /// Calculates Shannon Entropy in bits per character.
    /// Formula: H = -sum(p_i * log2(p_i))
    fn calculate_shannon_entropy(s: &str) -> f64 {
        if s.is_empty() {
            return 0.0;
        }

        let mut frequencies = HashMap::new();
        for c in s.chars() {
            *frequencies.entry(c).or_insert(0) += 1;
        }

        let len = s.chars().count() as f64;
        let mut entropy = 0.0;

        for &count in frequencies.values() {
            let p = count as f64 / len;
            entropy -= p * p.log2();
        }

        entropy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_email_redaction() {
        let input = "Contact me at admin@example.com for keys.";
        let output = Redactor::scrub(input);
        assert!(output.contains("[REDACTED_EMAIL]"));
        assert!(!output.contains("admin@example.com"));
    }

    #[test]
    fn test_high_entropy_redaction() {
        // A moderately high entropy string that should still trip the scrubber but pass the sentinel
        let input = "My key is a-very-long-string-with-random-parts-12345-67890-xyz";
        let output = Redactor::scrub(input);
        assert!(output.contains("[REDACTED_HIGH_ENTROPY]"));
    }

    #[test]
    fn test_low_entropy_preservation() {
        // Normal English sentence (low entropy)
        let input = "This is a perfectly normal sentence that should not be redacted.";
        let output = Redactor::scrub(input);
        assert!(!output.contains("[REDACTED]"));
        assert_eq!(input, output);
    }
}
