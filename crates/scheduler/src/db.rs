use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub async fn connect(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    if let Some(path) = database_url.strip_prefix("sqlite:") {
        let path = path.trim_start_matches("//");
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let opts = SqliteConnectOptions::from_str(database_url)?.create_if_missing(true);
    let pool = SqlitePoolOptions::new().connect_with(opts).await?;
    for sql in [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_screenshots.sql"),
        include_str!("../migrations/003_vi_templates.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await?;
    }
    Ok(pool)
}
