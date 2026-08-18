use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Duration;

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/001_init.sql"))
        .execute(pool)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrate_twice_leaves_stations_not_agents() {
        let db = TestDb::create().await;
        migrate(&db.pool)
            .await
            .expect("second migrate after agents→stations rename");
        let stations: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'stations'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        let agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'agents'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(stations, 1);
        assert_eq!(agents, 0);
    }
}
