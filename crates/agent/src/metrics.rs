use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;
use tokio::sync::RwLock;

#[derive(Clone, Copy, Debug, Default)]
pub struct MetricsSnapshot {
    pub cpu_percent: f32,
    pub memory_percent: f32,
}

pub struct MetricsSampler {
    sys: System,
}

impl MetricsSampler {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        Self { sys }
    }

    async fn cpu_and_memory(&mut self) -> MetricsSnapshot {
        self.sys.refresh_cpu_usage();
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let cpu = self.sys.global_cpu_usage();
        let total = self.sys.total_memory() as f32;
        let used = self.sys.used_memory() as f32;
        let mem = if total > 0.0 {
            (used / total) * 100.0
        } else {
            0.0
        };
        MetricsSnapshot {
            cpu_percent: cpu,
            memory_percent: mem,
        }
    }
}

pub fn start_metrics_sampler(mut sampler: MetricsSampler, snapshot: Arc<RwLock<MetricsSnapshot>>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(2_000));
        loop {
            interval.tick().await;
            let next = sampler.cpu_and_memory().await;
            *snapshot.write().await = next;
        }
    });
}
