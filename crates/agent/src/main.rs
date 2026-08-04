mod advertise;
mod api;
mod channel_run;
mod config;
mod expand;
mod general;
mod labview;
mod labview_sequence;
mod limits;
mod logging;
mod metrics;
mod register;
mod resource_lock;
mod rest;
mod sequence_session;
mod settings_defaults;
mod task_slot;
mod web;

use api::AppState;
use config::AgentConfig;
use metrics::{MetricsSampler, MetricsSnapshot};
use resource_lock::ResourceLockManager;
use sequence_session::{SequenceCancelRegistry, SequenceProgressSlot};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use task_slot::TaskSlot;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() {
    let cfg = AgentConfig::load_from_env().expect("config");
    if let Err(e) = logging::init_file_tracing(&cfg.log_dir) {
        // Last-resort startup diagnostic only; operational logs stay on disk.
        eprintln!(
            "failed to init file logging at {}: {e}",
            cfg.log_dir.display()
        );
    }

    let hostname = cfg
        .hostname
        .clone()
        .unwrap_or_else(|| hostname::get().unwrap().to_string_lossy().into_owned());
    let ip = advertise::resolve_advertise_ip(cfg.advertise_ip.as_deref(), &cfg.center_url);
    tracing::info!(%ip, "advertise ip selected");

    let http_client = register::http_client();
    let metrics = Arc::new(RwLock::new(MetricsSnapshot::default()));
    metrics::start_metrics_sampler(MetricsSampler::new(), metrics.clone());
    let state = AppState {
        hostname: hostname.clone(),
        ip: ip.clone(),
        port: cfg.port,
        started: Instant::now(),
        slot: TaskSlot::new(),
        metrics,
        center_url: cfg.center_url.clone(),
        http_client: http_client.clone(),
        log_dir: cfg.log_dir.clone(),
        labview_cli: cfg.labview_cli.clone(),
        labview_getinfo: cfg.labview_getinfo.clone(),
        sequence_progress: SequenceProgressSlot::new(),
        resource_locks: ResourceLockManager::new(),
        sequence_cancel: SequenceCancelRegistry::new(),
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
    tracing::info!(log_dir = %cfg.log_dir.display(), "agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
