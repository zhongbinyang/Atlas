use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Duration;

async fn apply_migration(pool: &PgPool, sql: &str) -> Result<(), sqlx::Error> {
    match sqlx::raw_sql(sql).execute(pool).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already exists") || msg.contains("duplicate column") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    for sql in [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_screenshots.sql"),
        include_str!("../migrations/003_vi_templates.sql"),
    ] {
        sqlx::raw_sql(sql).execute(pool).await?;
    }
    apply_migration(
        pool,
        include_str!("../migrations/004_vi_origin_and_unique.sql"),
    )
    .await?;
    sqlx::raw_sql(include_str!("../migrations/005_vi_run_queue.sql"))
        .execute(pool)
        .await?;
    apply_migration(
        pool,
        include_str!("../migrations/006_vi_drop_path_unique.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/007_vi_drop_agent_id.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/008_vi_template_serial_id.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/009_vi_template_kind.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/010_vi_run_queue_step_meta.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/011_vi_template_outputs.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/012_general_templates.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/013_vi_run_queue_general_support.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/014_vi_run_queue_inputs.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/015_sequence_templates.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/016_sequence_template_last_steps.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/017_agent_settings.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/018_queue_group_rows.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/019_agent_device_calibration_profiles.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/020_center_units.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/021_array_expand_mode.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/022_agent_channels.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/023_step_resources.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/024_agent_config_templates.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/025_agent_config_templates_text_timestamps.sql"),
    )
    .await?;
    apply_migration(
        pool,
        include_str!("../migrations/026_spec_templates.sql"),
    )
    .await?;
    Ok(())
}

/// Redact password in a postgres URL for logs / error messages.
pub fn redact_database_url(url: &str) -> String {
    // postgres://user:pass@host/db → postgres://user:***@host/db
    if let Some(scheme_end) = url.find("://") {
        let rest = &url[scheme_end + 3..];
        if let Some(at) = rest.find('@') {
            let creds = &rest[..at];
            if let Some(colon) = creds.find(':') {
                let user = &creds[..colon];
                return format!(
                    "{}{}:***@{}",
                    &url[..=scheme_end + 2],
                    user,
                    &rest[at + 1..]
                );
            }
        }
    }
    url.to_string()
}

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let opts = PgConnectOptions::from_str(database_url)?.ssl_mode(PgSslMode::Disable);
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(15))
        .connect_with(opts)
        .await
        .map_err(|e| {
            tracing::error!(
                database_url = %redact_database_url(database_url),
                error = %e,
                "postgres connect failed; check host reachability, credentials, and that database exists"
            );
            e
        })?;
    migrate(&pool).await?;
    Ok(pool)
}

pub fn default_database_url() -> String {
    std::env::var("SCHEDULER_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable".into()
    })
}

#[cfg(test)]
pub struct TestDb {
    pub pool: PgPool,
    schema: String,
    admin_url: String,
}

#[cfg(test)]
impl TestDb {
    pub async fn create() -> Self {
        let admin_url = default_database_url();
        let schema = format!("test_{}", uuid::Uuid::new_v4().simple());

        let admin = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(
                PgConnectOptions::from_str(&admin_url)
                    .expect("parse database url")
                    .ssl_mode(PgSslMode::Disable),
            )
            .await
            .expect("connect postgres admin for test schema");
        sqlx::query(&format!("CREATE SCHEMA \"{schema}\""))
            .execute(&admin)
            .await
            .expect("create test schema");
        admin.close().await;

        let opts = PgConnectOptions::from_str(&admin_url)
            .expect("parse database url")
            .ssl_mode(PgSslMode::Disable)
            .options([("search_path", schema.as_str())]);
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(15))
            .connect_with(opts)
            .await
            .expect("connect postgres test pool");
        migrate(&pool).await.expect("migrate test schema");

        Self {
            pool,
            schema,
            admin_url,
        }
    }
}

#[cfg(test)]
impl Drop for TestDb {
    fn drop(&mut self) {
        let url = self.admin_url.clone();
        let schema = self.schema.clone();
        let pool = self.pool.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test schema cleanup runtime");
            rt.block_on(async move {
                pool.close().await;
                if let Ok(opts) = PgConnectOptions::from_str(&url) {
                    if let Ok(admin) = PgPoolOptions::new()
                        .acquire_timeout(Duration::from_secs(10))
                        .connect_with(opts.ssl_mode(PgSslMode::Disable))
                        .await
                    {
                        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"))
                            .execute(&admin)
                            .await;
                        admin.close().await;
                    }
                }
            });
        })
        .join();
    }
}

#[cfg(test)]
pub struct GuardedStore {
    store: crate::store::Store,
    _db: TestDb,
}

#[cfg(test)]
impl GuardedStore {
    pub async fn new() -> Self {
        let db = TestDb::create().await;
        let store = crate::store::Store::new(db.pool.clone());
        Self { store, _db: db }
    }

    pub fn store(&self) -> &crate::store::Store {
        &self.store
    }
}

#[cfg(test)]
impl std::ops::Deref for GuardedStore {
    type Target = crate::store::Store;

    fn deref(&self) -> &Self::Target {
        &self.store
    }
}
