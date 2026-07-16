use serde::Deserialize;

use crate::labview_cmd::normalize_fs_path;
use crate::store::{Store, TransferError, ViTemplate};

#[derive(Debug)]
pub enum TransferApiError {
    NotFound,
    AgentNotFound,
    SameAgent,
    Config(String),
    Db(String),
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

pub async fn transfer_template(
    store: &Store,
    labview_client: &reqwest::Client,
    source: &ViTemplate,
    target_agent_id: &str,
    vi_path_override: Option<&str>,
) -> Result<ViTemplate, TransferApiError> {
    if target_agent_id == source.agent_id {
        return Err(TransferApiError::SameAgent);
    }

    let agent = match store.get_agent(target_agent_id).await {
        Ok(Some(a)) => a,
        Ok(None) => return Err(TransferApiError::AgentNotFound),
        Err(e) => return Err(TransferApiError::Db(e.to_string())),
    };

    let config = match fetch_labview_config(labview_client, &agent.ip, agent.port).await {
        Ok(c) => c,
        Err(e) => return Err(TransferApiError::Config(e)),
    };

    let cli_path = normalize_fs_path(&config.cli_path);
    let getinfo_path = normalize_fs_path(&config.getinfo_path);
    let vi_path = match vi_path_override {
        Some(p) if !normalize_fs_path(p).is_empty() => Some(normalize_fs_path(p)),
        _ => None,
    };

    store
        .transfer_vi_template(
            &source.id,
            target_agent_id,
            &cli_path,
            &getinfo_path,
            vi_path.as_deref(),
        )
        .await
        .map_err(|e| match e {
            TransferError::NotFound => TransferApiError::NotFound,
            TransferError::AgentNotFound => TransferApiError::AgentNotFound,
            TransferError::SameAgent => TransferApiError::SameAgent,
            TransferError::Db(e) => TransferApiError::Db(e.to_string()),
        })
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
    async fn transfer_moves_template_to_target() {
        let store = test_store().await;
        let (addr, _mock) = start_mock_labview().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store
            .upsert_agent("b", &addr.ip().to_string(), addr.port())
            .await
            .unwrap();
        let inputs = serde_json::json!([{"name":"x","value":1}]);
        let source = store
            .insert_vi_template(
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
        let transferred = transfer_template(
            &store,
            &labview_client,
            &source,
            &agent_b.id,
            None,
        )
        .await
        .unwrap();
        assert_eq!(transferred.id, source.id);
        assert_eq!(transferred.agent_id, agent_b.id);
        assert_eq!(transferred.origin_agent_id, agent_a.id);
        assert_eq!(transferred.cli_path, r"C:\cli\LabVIEWCLI.exe");

        let listed_a = store
            .list_vi_templates(Some(&agent_a.id))
            .await
            .unwrap();
        assert!(listed_a.is_empty());

        let listed_b = store
            .list_vi_templates(Some(&agent_b.id))
            .await
            .unwrap();
        assert_eq!(listed_b.len(), 1);
        assert_eq!(listed_b[0].id, source.id);
    }

    #[tokio::test]
    async fn transfer_to_self_errors() {
        let store = test_store().await;
        let agent = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let source = store
            .insert_vi_template(
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

        let err = transfer_template(
            &store,
            &reqwest::Client::new(),
            &source,
            &agent.id,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TransferApiError::SameAgent));
    }
}
