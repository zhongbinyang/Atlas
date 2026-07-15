mod api;
mod config;
mod db;
mod dispatcher;
mod poller;
mod store;
mod web;

use std::net::SocketAddr;

use api::AppState;
use config::SchedulerConfig;
use store::Store;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cfg = SchedulerConfig::load();
    let pool = db::connect(&cfg.database_url)
        .await
        .expect("database connection failed");
    let store = Store::new(pool);
    let client = reqwest::Client::new();

    let poll_store = store.clone();
    let poll_client = client.clone();
    let poll_interval = cfg.poll_status_interval_secs;
    tokio::spawn(async move {
        poller::run_status_poller(poll_store, poll_client, poll_interval).await;
    });

    let dispatch_store = store.clone();
    let dispatch_client = client.clone();
    let dispatch_interval = cfg.poll_task_interval_secs;
    tokio::spawn(async move {
        dispatcher::run_dispatcher(dispatch_store, dispatch_client, dispatch_interval).await;
    });

    let app = api::router(AppState { store }).merge(web::static_router());
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port).parse().unwrap();
    tracing::info!("scheduler listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
