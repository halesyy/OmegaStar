//! The boundary error: every command rejects as `{ code, message }`.

use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Invalid,
    NotFound,
    Conflict,
    Internal,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn invalid(m: impl Into<String>) -> Self {
        AppError { code: ErrorCode::Invalid, message: m.into() }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        AppError { code: ErrorCode::NotFound, message: m.into() }
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        AppError { code: ErrorCode::Conflict, message: m.into() }
    }
    pub fn internal(m: impl Into<String>) -> Self {
        AppError { code: ErrorCode::Internal, message: m.into() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self.code {
            ErrorCode::Invalid => "invalid",
            ErrorCode::NotFound => "notFound",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Internal => "internal",
        };
        write!(f, "{code}: {}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::internal(format!("database: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::internal(format!("io: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::internal(format!("json: {e}"))
    }
}
