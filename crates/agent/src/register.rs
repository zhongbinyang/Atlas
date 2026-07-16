use std::time::Duration;

use common::RegisterAgentRequest;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
struct AgentListEntry {
    id: String,
    name: String,
    ip: String,
    port: u16,
}

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

pub async fn resolve_agent_id(
    client: &reqwest::Client,
    center_url: &str,
    name: &str,
    ip: &str,
    port: u16,
) -> Result<String, String> {
    let url = format!("{}/api/agents", center_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("list agents failed: {}", resp.status()));
    }
    let agents: Vec<AgentListEntry> = resp.json().await.map_err(|e| e.to_string())?;
    agents
        .into_iter()
        .find(|a| a.name == name && a.ip == ip && a.port == port)
        .map(|a| a.id)
        .ok_or_else(|| "agent not found on center".into())
}

pub async fn register_vi_template(
    client: &reqwest::Client,
    center_url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/vi-templates", center_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn list_vi_templates_for_agent(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/vi-templates?agent_id={}",
        center_url.trim_end_matches('/'),
        agent_id
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}
