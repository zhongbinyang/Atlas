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

pub async fn patch_vi_template(
    client: &reqwest::Client,
    center_url: &str,
    id: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/vi-templates/{}",
        center_url.trim_end_matches('/'),
        id
    );
    let resp = client
        .patch(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
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

pub async fn register_general_template(
    client: &reqwest::Client,
    center_url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/general-templates", center_url.trim_end_matches('/'));
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

pub async fn list_general_templates_by_kind(
    client: &reqwest::Client,
    center_url: &str,
    kind: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/general-templates?kind={}",
        center_url.trim_end_matches('/'),
        kind
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

pub async fn list_all_general_templates(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/general-templates", center_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
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

pub async fn list_all_vi_templates(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    list_vi_templates_filtered(client, center_url, None).await
}

pub async fn list_vi_templates_by_kind(
    client: &reqwest::Client,
    center_url: &str,
    kind: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    list_vi_templates_filtered(client, center_url, Some(kind)).await
}

async fn list_vi_templates_filtered(
    client: &reqwest::Client,
    center_url: &str,
    kind: Option<&str>,
) -> Result<(reqwest::StatusCode, Value), String> {
    let mut url = format!("{}/api/vi-templates", center_url.trim_end_matches('/'));
    if let Some(kind) = kind {
        url.push_str(&format!("?kind={}", kind));
    }
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn distribute_vi_template(
    client: &reqwest::Client,
    center_url: &str,
    template_id: &str,
    target_agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/vi-templates/{}/distribute",
        center_url.trim_end_matches('/'),
        template_id
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "target_agent_id": target_agent_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn get_vi_run_queue(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agents/{}/vi-run-queue",
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

pub async fn put_vi_run_queue(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agents/{}/vi-run-queue",
        center_url.trim_end_matches('/'),
        agent_id
    );
    let resp = client
        .put(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn list_sequence_templates(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/sequence-templates", center_url.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn create_sequence_template(
    client: &reqwest::Client,
    center_url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/sequence-templates", center_url.trim_end_matches('/'));
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

pub async fn get_sequence_template(
    client: &reqwest::Client,
    center_url: &str,
    id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/sequence-templates/{}",
        center_url.trim_end_matches('/'),
        id
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn load_sequence_template_to_agent(
    client: &reqwest::Client,
    center_url: &str,
    template_id: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/sequence-templates/{}/load-to-agent",
        center_url.trim_end_matches('/'),
        template_id
    );
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "agent_id": agent_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}
