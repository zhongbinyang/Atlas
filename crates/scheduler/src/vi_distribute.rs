use serde::{Deserialize, Serialize};

use crate::labview_cmd::normalize_fs_path;
use crate::store::{Store, ViTemplate};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DistributeResultItem {
    pub agent_id: String,
    pub status: String,
    pub template_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributeViTemplateResponse {
    pub results: Vec<DistributeResultItem>,
}

#[derive(Debug, Deserialize)]
struct LabviewConfig {
    cli_path: String,
    getinfo_path: String,
}

async fn fetch_labview_config(
    client: &reqwest::Client,
    ip: &str,
    port: u16,
) -> Result<LabviewConfig, String> {
    let url = format!("http://{ip}:{port}/api/labview/config");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("labview config returned {}", resp.status()));
    }
    resp.json::<LabviewConfig>()
        .await
        .map_err(|e| format!("invalid labview config: {e}"))
}

pub async fn distribute_template(
    store: &Store,
    labview_client: &reqwest::Client,
    source: &ViTemplate,
    targets: &[String],
    vi_path_override: Option<&str>,
) -> Vec<DistributeResultItem> {
    let inputs: serde_json::Value =
        serde_json::from_str(&source.inputs_json).unwrap_or_else(|_| serde_json::json!([]));
    let final_vi_path = match vi_path_override {
        Some(p) if !normalize_fs_path(p).is_empty() => normalize_fs_path(p),
        _ => source.vi_path.clone(),
    };

    let mut results = Vec::with_capacity(targets.len());
    for target_id in targets {
        if target_id == &source.agent_id {
            results.push(DistributeResultItem {
                agent_id: target_id.clone(),
                status: "skipped".into(),
                template_id: None,
                error: Some("source agent".into()),
            });
            continue;
        }

        let agent = match store.get_agent(target_id).await {
            Ok(Some(a)) => a,
            Ok(None) => {
                results.push(DistributeResultItem {
                    agent_id: target_id.clone(),
                    status: "error".into(),
                    template_id: None,
                    error: Some("agent not found".into()),
                });
                continue;
            }
            Err(e) => {
                results.push(DistributeResultItem {
                    agent_id: target_id.clone(),
                    status: "error".into(),
                    template_id: None,
                    error: Some(format!("database error: {e}")),
                });
                continue;
            }
        };

        let config = match fetch_labview_config(labview_client, &agent.ip, agent.port).await {
            Ok(c) => c,
            Err(e) => {
                results.push(DistributeResultItem {
                    agent_id: target_id.clone(),
                    status: "error".into(),
                    template_id: None,
                    error: Some(e),
                });
                continue;
            }
        };

        let cli_path = normalize_fs_path(&config.cli_path);
        let getinfo_path = normalize_fs_path(&config.getinfo_path);

        match store
            .upsert_vi_template_distribute(
                &source.name,
                target_id,
                &source.origin_agent_id,
                &final_vi_path,
                &cli_path,
                &getinfo_path,
                &inputs,
                source.show_front_panel,
                source.timeout_secs,
            )
            .await
        {
            Ok((tpl, created)) => {
                results.push(DistributeResultItem {
                    agent_id: target_id.clone(),
                    status: if created {
                        "created".into()
                    } else {
                        "updated".into()
                    },
                    template_id: Some(tpl.id),
                    error: None,
                });
            }
            Err(e) => {
                results.push(DistributeResultItem {
                    agent_id: target_id.clone(),
                    status: "error".into(),
                    template_id: None,
                    error: Some(format!("database error: {e}")),
                });
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    async fn test_store() -> Store {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        Store::new(pool)
    }

    async fn start_mock_labview() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use axum::{http::StatusCode, routing::get, Router};
        const CONFIG: &str =
            r#"{"cli_path":"C:\\cli\\LabVIEWCLI.exe","getinfo_path":"C:\\cli\\GetInfo.exe"}"#;
        let config_json = CONFIG.to_string();
        let mock = Router::new().route(
            "/api/labview/config",
            get({
                let config_json = config_json.clone();
                move || async move {
                    (
                        StatusCode::OK,
                        [(axum::http::header::CONTENT_TYPE, "application/json")],
                        config_json,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn distribute_creates_on_target_with_source_origin() {
        let store = test_store().await;
        let (addr, _mock) = start_mock_labview().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store
            .upsert_agent("b", &addr.ip().to_string(), addr.port())
            .await
            .unwrap();
        let inputs = serde_json::json!([{"name":"x","value":1}]);
        let (source, _) = store
            .upsert_vi_template(
                "Add",
                &agent_a.id,
                &agent_a.id,
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                true,
                Some(30),
            )
            .await
            .unwrap();

        let labview_client = reqwest::Client::new();
        let results = distribute_template(
            &store,
            &labview_client,
            &source,
            &[agent_b.id.clone()],
            None,
        )
        .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, "created");
        assert!(results[0].template_id.is_some());

        let listed = store
            .list_vi_templates(Some(&agent_b.id))
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent_id, agent_b.id);
        assert_eq!(listed[0].origin_agent_id, agent_a.id);
        assert_eq!(
            listed[0].cli_path,
            r"C:\cli\LabVIEWCLI.exe"
        );
    }

    #[tokio::test]
    async fn distribute_skips_source_agent() {
        let store = test_store().await;
        let agent = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let (source, _) = store
            .upsert_vi_template(
                "Add",
                &agent.id,
                &agent.id,
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();

        let results = distribute_template(
            &store,
            &reqwest::Client::new(),
            &source,
            &[agent.id.clone()],
            None,
        )
        .await;
        assert_eq!(results[0].status, "skipped");
        assert_eq!(results[0].error.as_deref(), Some("source agent"));
    }
}
