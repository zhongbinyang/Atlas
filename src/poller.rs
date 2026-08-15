use crate::store::Store;

pub async fn run_status_poller(store: Store, client: reqwest::Client, interval_secs: u64) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        let agents = match store.list_agents().await {
            Ok(a) => a,
            Err(e) => {
                tracing::error!("list agents: {e}");
                continue;
            }
        };
        for agent in agents {
            let url = format!("http://{}:{}/api/status", agent.ip, agent.port);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(st) = resp.json::<crate::dto::AgentStatusResponse>().await {
                        if let Err(e) = store
                            .update_agent_metrics(
                                &agent.id,
                                "online",
                                st.cpu_percent,
                                st.memory_percent,
                                st.busy,
                            )
                            .await
                        {
                            tracing::warn!("update agent metrics {}: {e}", agent.id);
                        }
                    }
                }
                _ => {
                    if let Err(e) = store.mark_agent_offline(&agent.id).await {
                        tracing::warn!("mark agent offline {}: {e}", agent.id);
                    }
                }
            }
        }
    }
}
