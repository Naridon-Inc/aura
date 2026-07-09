use thiserror::Error;

#[derive(Error, Debug)]
pub enum KmsError {
    #[error("KMS signing failed: {0}")]
    SignFailed(String),
    #[error("KMS key retrieval failed: {0}")]
    KeyRetrievalFailed(String),
}

/// Abstract provider for secure signing, mapping to external KMS/HSM
pub trait KmsProvider: Send + Sync {
    fn sign(&self, payload: &[u8]) -> impl std::future::Future<Output = Result<Vec<u8>, KmsError>> + Send;
    fn get_public_key(&self) -> impl std::future::Future<Output = Result<Vec<u8>, KmsError>> + Send;
}

/// A stub KMS for local development
pub struct StubKms;

impl KmsProvider for StubKms {
    async fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, KmsError> {
        // In a real implementation, this interacts with AWS KMS, HashiCorp Vault, or a local YubiKey.
        Ok(payload.to_vec()) // Stub signature
    }

    async fn get_public_key(&self) -> Result<Vec<u8>, KmsError> {
        Ok(b"stub_public_key_001".to_vec())
    }
}
