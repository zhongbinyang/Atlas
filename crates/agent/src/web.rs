use axum::http::{header, HeaderValue};
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    let index = concat!(env!("CARGO_MANIFEST_DIR"), "/static/index.html");
    // Avoid stale HTML/JS after UI updates (browsers otherwise keep old tabs).
    let no_cache = HeaderValue::from_static("no-cache, must-revalidate");
    Router::new()
        .fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index)))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            no_cache,
        ))
}
