pub struct SchedulerConfig {
    pub bind: String,
    pub port: u16,
    pub database_url: String,
    pub poll_status_interval_secs: u64,
}

impl SchedulerConfig {
    pub fn load() -> Self {
        Self {
            bind: std::env::var("SCHEDULER_BIND").unwrap_or_else(|_| "0.0.0.0".into()),
            port: std::env::var("SCHEDULER_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(26630),
            database_url: std::env::var("SCHEDULER_DATABASE_URL").unwrap_or_else(|_| {
                "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable".into()
            }),
            poll_status_interval_secs: std::env::var("SCHEDULER_POLL_STATUS_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
        }
    }
}
