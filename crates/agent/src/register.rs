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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct AgentSettingsPayload {
    #[serde(default, deserialize_with = "deserialize_units_flex")]
    pub units: Vec<common::AgentUnit>,
    #[serde(default)]
    pub variables: Vec<common::AgentVariable>,
    #[serde(default)]
    pub array_expand_mode: common::ArrayExpandMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub device_profiles: Vec<AgentConfigProfilePayload>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_profiles: Vec<AgentConfigProfilePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_calibration_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct AgentConfigProfilePayload {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub agent_id: String,
    pub name: String,
    #[serde(default)]
    pub setting: Value,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub source_filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateAgentConfigProfileBody {
    pub name: String,
    #[serde(default)]
    pub setting: Value,
    #[serde(default)]
    pub source_filename: String,
    #[serde(default)]
    pub activate: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UpdateAgentConfigProfileBody {
    pub name: String,
    #[serde(default)]
    pub setting: Value,
    #[serde(default)]
    pub source_filename: String,
}

fn deserialize_units_flex<'de, D>(deserializer: D) -> Result<Vec<common::AgentUnit>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
    let raw = serde_json::to_string(&value).unwrap_or_else(|_| "[]".into());
    Ok(common::parse_units_json(&raw))
}

pub async fn get_agent_settings(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<AgentSettingsPayload, String> {
    let url = format!(
        "{}/api/agents/{}/settings",
        center_url.trim_end_matches('/'),
        agent_id
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get settings failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct CenterUnitsPayload {
    #[serde(default, deserialize_with = "deserialize_units_flex")]
    pub units: Vec<common::AgentUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

pub async fn get_center_units(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<CenterUnitsPayload, String> {
    let url = format!("{}/api/units", center_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get units failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn put_agent_settings(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    body: &AgentSettingsPayload,
) -> Result<AgentSettingsPayload, String> {
    let url = format!(
        "{}/api/agents/{}/settings",
        center_url.trim_end_matches('/'),
        agent_id
    );
    // Only persist units/variables; profiles use dedicated APIs.
    let slim = AgentSettingsPayload {
        units: Vec::new(),
        variables: body.variables.clone(),
        array_expand_mode: body.array_expand_mode,
        updated_at: None,
        device_profiles: Vec::new(),
        calibration_profiles: Vec::new(),
        active_device_id: None,
        active_calibration_id: None,
    };
    let resp = client
        .put(&url)
        .json(&slim)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("put settings failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

fn config_profiles_url(center_url: &str, agent_id: &str, kind: &str) -> String {
    format!(
        "{}/api/agents/{}/{}",
        center_url.trim_end_matches('/'),
        agent_id,
        kind
    )
}

pub async fn list_config_profiles(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    kind: &str,
) -> Result<Vec<AgentConfigProfilePayload>, String> {
    let url = config_profiles_url(center_url, agent_id, kind);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("list {kind} failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn create_config_profile(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    kind: &str,
    body: &CreateAgentConfigProfileBody,
) -> Result<AgentConfigProfilePayload, String> {
    let url = config_profiles_url(center_url, agent_id, kind);
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("create {kind} failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn update_config_profile(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    kind: &str,
    profile_id: &str,
    body: &UpdateAgentConfigProfileBody,
) -> Result<AgentConfigProfilePayload, String> {
    let url = format!(
        "{}/{}",
        config_profiles_url(center_url, agent_id, kind),
        profile_id
    );
    let resp = client
        .put(&url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("update {kind} failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn delete_config_profile(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    kind: &str,
    profile_id: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/{}",
        config_profiles_url(center_url, agent_id, kind),
        profile_id
    );
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT || resp.status().is_success() {
        return Ok(());
    }
    Err(format!("delete {kind} failed: {}", resp.status()))
}

pub async fn activate_config_profile(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    kind: &str,
    profile_id: &str,
) -> Result<AgentConfigProfilePayload, String> {
    let url = format!(
        "{}/{}/activate",
        config_profiles_url(center_url, agent_id, kind),
        profile_id
    );
    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("activate {kind} failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub async fn get_active_config_profiles(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<(Option<AgentConfigProfilePayload>, Option<AgentConfigProfilePayload>), String> {
    let settings = get_agent_settings(client, center_url, agent_id).await?;
    let device = settings
        .device_profiles
        .into_iter()
        .find(|p| p.is_active);
    let calibration = settings
        .calibration_profiles
        .into_iter()
        .find(|p| p.is_active);
    Ok((device, calibration))
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

pub async fn get_vi_run_queue(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agents/{}/run-queue",
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
        "{}/api/agents/{}/run-queue",
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

pub async fn get_agent_channels(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agents/{}/channels",
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

pub async fn put_agent_channels(
    client: &reqwest::Client,
    center_url: &str,
    agent_id: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agents/{}/channels",
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

pub async fn list_agent_config_templates(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agent-config-templates",
        center_url.trim_end_matches('/')
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn create_agent_config_template(
    client: &reqwest::Client,
    center_url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agent-config-templates",
        center_url.trim_end_matches('/')
    );
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

pub async fn load_agent_config_template_to_agent(
    client: &reqwest::Client,
    center_url: &str,
    template_id: &str,
    agent_id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/agent-config-templates/{}/load-to-agent",
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

pub async fn list_spec_templates(
    client: &reqwest::Client,
    center_url: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/spec-templates", center_url.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

pub async fn get_spec_template(
    client: &reqwest::Client,
    center_url: &str,
    id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/spec-templates/{}",
        center_url.trim_end_matches('/'),
        id
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, value))
}

/// Fetch a spec template's parsed `spec` JSON document from the center scheduler.
pub async fn fetch_spec_template_spec_json(
    client: &reqwest::Client,
    center_url: &str,
    template_id: i64,
) -> Result<String, String> {
    let (status, body) = get_spec_template(client, center_url, &template_id.to_string()).await?;
    if !status.is_success() {
        return Err(format!(
            "spec template {template_id} not found (HTTP {status})"
        ));
    }
    let spec = body.get("spec").ok_or_else(|| {
        format!("spec template {template_id} response missing spec field")
    })?;
    Ok(spec.to_string())
}

pub async fn create_spec_template(
    client: &reqwest::Client,
    center_url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!("{}/api/spec-templates", center_url.trim_end_matches('/'));
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

pub async fn delete_spec_template(
    client: &reqwest::Client,
    center_url: &str,
    id: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let url = format!(
        "{}/api/spec-templates/{}",
        center_url.trim_end_matches('/'),
        id
    );
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    };
    Ok((status, value))
}
