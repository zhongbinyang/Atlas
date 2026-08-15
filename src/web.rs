use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    let index = concat!(env!("CARGO_MANIFEST_DIR"), "/static/index.html");
    Router::new()
        .fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index)))
}
