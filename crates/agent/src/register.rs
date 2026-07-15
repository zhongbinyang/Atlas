use std::time::Duration;

use common::RegisterAgentRequest;

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("http client")
}

pub async fn register_with_center(
    client: &reqwest::Client,
    center_url: &str,
    req: &RegisterAgentRequest,
) -> Result<(), String> {
    let url = format!("{}/api/agents/register", center_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("register failed: {}", resp.status()));
    }
    Ok(())
}
