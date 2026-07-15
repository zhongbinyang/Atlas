mod api;
mod capture;
mod config;
mod files;
mod executor;
mod metrics;
mod register;
mod task_slot;
mod web;

use api::AppState;
use config::AgentConfig;
use metrics::MetricsSampler;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use task_slot::TaskSlot;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cfg = AgentConfig::load_from_env().expect("config");
    let hostname = cfg
        .hostname
        .clone()
        .unwrap_or_else(|| hostname::get().unwrap().to_string_lossy().into_owned());
    let ip = cfg.advertise_ip.clone().unwrap_or_else(|| {
        local_ip_address::local_ip()
            .map(|i| i.to_string())
            .unwrap_or_else(|_| "127.0.0.1".into())
    });

    let state = AppState {
        hostname: hostname.clone(),
        ip: ip.clone(),
        port: cfg.port,
        started: Instant::now(),
        slot: TaskSlot::new(),
        metrics: Arc::new(Mutex::new(MetricsSampler::new())),
        center_url: cfg.center_url.clone(),
    };

    let client = register::http_client();
    let reg = common::RegisterAgentRequest {
        name: hostname,
        ip,
        port: cfg.port,
    };
    if let Err(e) = register::register_with_center(&client, &cfg.center_url, &reg).await {
        tracing::warn!("initial register failed: {e}");
    }

    let app = api::router(state).merge(web::static_router());
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port).parse().unwrap();
    tracing::info!("agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
