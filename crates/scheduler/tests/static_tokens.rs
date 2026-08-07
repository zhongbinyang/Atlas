use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn scheduler_static_serves_vite_index() {
    let index = fs::read_to_string(manifest_dir().join("static/index.html")).unwrap();
    assert!(index.contains(r#"id="root""#) || index.contains("id=root"));
    assert!(index.contains("/assets/") || index.contains("assets/"));
    assert!(index.contains(r#"type="module""#));
    assert!(index.contains(r#"href="/favicon.svg""#));
    assert!(manifest_dir().join("static/favicon.svg").is_file());
}

#[test]
fn scheduler_static_has_vite_assets() {
    let assets_dir = manifest_dir().join("static/assets");
    assert!(assets_dir.is_dir(), "Vite assets directory must be synced");

    let mut has_js = false;
    let mut has_css = false;
    for entry in fs::read_dir(assets_dir).unwrap() {
        let path = entry.unwrap().path();
        has_js |= path.extension().is_some_and(|ext| ext == "js");
        has_css |= path.extension().is_some_and(|ext| ext == "css");
    }

    assert!(has_js, "Vite JavaScript asset must be present");
    assert!(has_css, "Vite CSS asset must be present");
}

#[test]
fn scheduler_static_has_no_legacy_files() {
    let static_dir = manifest_dir().join("static");
    for file in ["app.js", "dashboard-runtime.js", "style.css"] {
        assert!(
            !static_dir.join(file).is_file(),
            "legacy scheduler static file must not be shipped: {file}"
        );
    }
}

#[test]
fn scheduler_defaults_postgres_to_loopback() {
    let scheduler_dir = manifest_dir();
    let config = fs::read_to_string(scheduler_dir.join("src/config.rs")).unwrap();
    let db = fs::read_to_string(scheduler_dir.join("src/db.rs")).unwrap();
    let readme = fs::read_to_string(scheduler_dir.join("../../README.md")).unwrap();
    let loopback_url = "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable";

    assert!(
        config.contains("SCHEDULER_DATABASE_URL") && config.contains(loopback_url),
        "scheduler config must default SCHEDULER_DATABASE_URL to the loopback PostgreSQL URL"
    );
    assert!(
        db.contains(loopback_url),
        "scheduler database test/default URL must use loopback PostgreSQL"
    );
    assert!(
        readme.contains("SCHEDULER_DATABASE_URL")
            && readme.contains(loopback_url)
            && readme.matches("127.0.0.1:5432").count() >= 3,
        "README overview, environment table, and PowerShell startup example must describe loopback PostgreSQL"
    );

    for (name, contents) in [("config.rs", &config), ("db.rs", &db), ("README.md", &readme)] {
        assert!(
            !contents.contains("10.102.30.18:5432"),
            "{name} must not retain the remote PostgreSQL endpoint"
        );
    }
}
