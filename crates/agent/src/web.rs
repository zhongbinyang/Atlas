use axum::http::{header, HeaderValue};
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    // Avoid stale HTML/JS after UI updates (browsers otherwise keep old tabs).
    let no_cache = HeaderValue::from_static("no-cache, must-revalidate");
    Router::new()
        .fallback_service(ServeDir::new(dir))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            no_cache,
        ))
}
