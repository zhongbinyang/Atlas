mod advertise;
mod api;
mod capture;
mod config;
mod files;
mod general;
mod labview;
mod labview_sequence;
mod limits;
mod executor;
mod metrics;
mod register;
mod sequence_session;
mod task_slot;
mod web;

use api::AppState;
use config::AgentConfig;
use metrics::MetricsSampler;
use sequence_session::SequenceSessionSlot;
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
    let ip = advertise::resolve_advertise_ip(cfg.advertise_ip.as_deref(), &cfg.center_url);
    tracing::info!(%ip, "advertise ip selected");

    let http_client = register::http_client();
    let state = AppState {
        hostname: hostname.clone(),
        ip: ip.clone(),
        port: cfg.port,
        started: Instant::now(),
        slot: TaskSlot::new(),
        metrics: Arc::new(Mutex::new(MetricsSampler::new())),
        center_url: cfg.center_url.clone(),
        http_client: http_client.clone(),
        files_root: cfg.files_root.clone(),
        labview_cli: cfg.labview_cli.clone(),
        labview_getinfo: cfg.labview_getinfo.clone(),
        sequence_session: SequenceSessionSlot::new(),
    };

    let reg = common::RegisterAgentRequest {
        name: hostname,
        ip,
        port: cfg.port,
    };
    if let Err(e) = register::register_with_center(&http_client, &cfg.center_url, &reg).await {
        tracing::warn!("initial register failed: {e}");
    }

    let app = api::router(state).merge(web::static_router());
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port).parse().unwrap();
    tracing::info!("agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
