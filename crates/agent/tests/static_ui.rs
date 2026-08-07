#[test]
fn agent_static_serves_vite_index() {
    let index = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("static/index.html"),
    )
    .unwrap();
    assert!(
        index.contains("root"),
        "Vite index must mount React on #root"
    );
    assert!(
        index.contains("/assets/") || index.contains("assets/"),
        "Vite index must reference hashed assets"
    );
    assert!(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/favicon.svg")
            .is_file()
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/app.js")
            .is_file(),
        "legacy app.js must be removed after React cutover"
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/workbench-runtime.js")
            .is_file(),
        "legacy workbench-runtime.js must be removed after React cutover"
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/style.css")
            .is_file(),
        "legacy style.css must be removed after React cutover"
    );
}
