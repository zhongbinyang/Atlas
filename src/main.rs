mod agent_settings;
mod api;
mod config;
mod db;
mod dto;
mod error;
mod labview_cmd;
mod poller;
mod spec_ini;
mod station_releases;
mod store;
mod test_runs;
mod version;
mod web;

use std::net::SocketAddr;

use api::AppState;
use config::SchedulerConfig;
use store::Store;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("http client")
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cfg = SchedulerConfig::load();
    tracing::info!(
        database_url = %db::redact_database_url(&cfg.database_url),
        "connecting to postgres"
    );
    let pool = db::connect(&cfg.database_url).await.unwrap_or_else(|e| {
        panic!(
            "database connection failed ({}) url={}",
            e,
            db::redact_database_url(&cfg.database_url)
        );
    });
    let store = Store::new(pool);
    let client = http_client();

    let poll_store = store.clone();
    let poll_client = client.clone();
    let poll_interval = cfg.poll_status_interval_secs;
    tokio::spawn(async move {
        poller::run_status_poller(poll_store, poll_client, poll_interval).await;
    });


    let app = api::router(AppState { store })
        .merge(web::static_router());
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port).parse().unwrap();
    tracing::info!("scheduler listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
