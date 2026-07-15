use common::RegisterAgentRequest;

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
