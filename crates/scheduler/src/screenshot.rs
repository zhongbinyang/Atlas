use uuid::Uuid;

use crate::store::{Screenshot, Store};

pub const MAX_SCREENSHOT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug)]
pub enum CaptureError {
    AgentNotFound,
    Unreachable(String),
    BadImage(String),
    Io(String),
}

pub async fn capture_and_archive(
    store: &Store,
    client: &reqwest::Client,
    screenshot_root: &str,
    agent_id: &str,
) -> Result<Screenshot, CaptureError> {
    let agent = store
        .get_agent(agent_id)
        .await
        .map_err(|e| CaptureError::Io(e.to_string()))?
        .ok_or(CaptureError::AgentNotFound)?;

    let url = format!("http://{}:{}/api/screenshot", agent.ip, agent.port);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| CaptureError::Unreachable(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(CaptureError::BadImage(format!(
            "agent status {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CaptureError::BadImage(e.to_string()))?;

    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(CaptureError::BadImage("exceeds 20 MiB".into()));
    }

    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(CaptureError::BadImage("not a PNG".into()));
    }

    let id = Uuid::new_v4().to_string();
    let rel = format!("{screenshot_root}/{agent_id}/{id}.png");
    let path = std::path::Path::new(&rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CaptureError::Io(e.to_string()))?;
    }
    std::fs::write(path, &bytes).map_err(|e| CaptureError::Io(e.to_string()))?;

    match store
        .insert_screenshot_with_id(
            &id,
            agent_id,
            &rel,
            "image/png",
            bytes.len() as i64,
            None,
            None,
        )
        .await
    {
        Ok(meta) => Ok(meta),
        Err(e) => {
            let _ = std::fs::remove_file(path);
            Err(CaptureError::Io(e.to_string()))
        }
    }
}
