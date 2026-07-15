use axum::Router;
use tower_http::services::ServeDir;

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    Router::new().fallback_service(ServeDir::new(dir))
}
