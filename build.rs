use std::env;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=ATLAS_BUILD_DATE");
    println!("cargo:rerun-if-env-changed=ATLAS_GIT_SHA");
    println!("cargo:rerun-if-env-changed=ATLAS_GIT_DIRTY");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/index");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let date = env::var("ATLAS_BUILD_DATE").unwrap_or_else(|_| {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    });
    let sha = env::var("ATLAS_GIT_SHA")
        .unwrap_or_else(|_| git_short_sha().unwrap_or_else(|| "unknown".into()));
    let dirty = match env::var("ATLAS_GIT_DIRTY") {
        Ok(value) => value == "1",
        Err(_) => sha != "unknown" && git_is_dirty(),
    };
    let git = if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    };
    let version = format!("{date}.{git}");

    println!("cargo:rustc-env=ATLAS_BUILD_DATE={date}");
    println!("cargo:rustc-env=ATLAS_GIT_REV={git}");
    println!("cargo:rustc-env=ATLAS_VERSION={version}");
}

fn git_short_sha() -> Option<String> {
    let dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let out = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .current_dir(&dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn git_is_dirty() -> bool {
    let Ok(dir) = env::var("CARGO_MANIFEST_DIR") else {
        return false;
    };
    let Ok(out) = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&dir)
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}
