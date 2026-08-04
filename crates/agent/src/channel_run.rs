//! Multi-channel sequence orchestrator: one station run across N channel workers
//! sharing a [`ResourceLockManager`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use crate::labview_sequence::{
    run_one_step, run_sequence_from_with_opts, QueueItemForRun, SequenceResponse, SequenceRunOpts,
};
use crate::resource_lock::ResourceLockManager;
use crate::sequence_session::SequenceProgressSlot;
use crate::settings_defaults::apply_channel_overlay;

#[derive(Debug, Clone)]
pub struct ChannelSpec {
    pub channel_index: usize,
    pub name: String,
    pub overlay: Value,
}

#[derive(Debug, Clone)]
pub struct ChannelRunRequest {
    pub items: Vec<QueueItemForRun>,
    pub base_vars: HashMap<String, String>,
    pub channels: Vec<ChannelSpec>, // enabled only; if empty → one synthetic CH index 0
    pub resource_locks: Arc<ResourceLockManager>,
    pub resource_timeout: Duration,
    pub sn: Option<String>,
    pub work_order: Option<String>,
    pub progress: Arc<SequenceProgressSlot>,
    pub cancel: watch::Receiver<bool>,
    /// TaskSlot generation for this run (scopes progress clear / writes).
    pub run_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSequenceResponse {
    pub channel_index: usize,
    pub channel_name: String,
    pub run_generation: u64,
    pub response: SequenceResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiChannelSequenceResponse {
    pub channels: Vec<ChannelSequenceResponse>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_channel_indexes: Vec<usize>,
    /// `fail` if any channel is fail/error/aborted/stop-fail; else `pass`.
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_order: Option<String>,
}

/// Aggregate per-channel overalls into a station-level result.
pub fn aggregate_overall(overalls: &[&str]) -> String {
    if overalls.is_empty() {
        return "pass".into();
    }
    if overalls
        .iter()
        .any(|o| matches!(*o, "fail" | "error" | "aborted" | "stop-fail" | "failed"))
    {
        "fail".into()
    } else {
        "pass".into()
    }
}

fn synthetic_channel() -> ChannelSpec {
    ChannelSpec {
        channel_index: 0,
        name: "CH0".into(),
        overlay: Value::Object(Default::default()),
    }
}

fn resolve_channels(channels: Vec<ChannelSpec>) -> Vec<ChannelSpec> {
    if channels.is_empty() {
        vec![synthetic_channel()]
    } else {
        channels
    }
}

/// Run the same queue items on each channel in parallel with shared resource locks,
/// using the real LabVIEW / builtin step runner.
pub async fn run_multi_channel(
    cli: &Path,
    getinfo: &Path,
    req: ChannelRunRequest,
) -> MultiChannelSequenceResponse {
    let cli = cli.to_path_buf();
    let getinfo = getinfo.to_path_buf();
    run_multi_channel_with(req, move |item, vars| {
        let cli = cli.clone();
        let getinfo = getinfo.clone();
        let item = item.clone();
        let vars = vars.clone();
        async move { run_one_step(&cli, &getinfo, &item, &vars).await }
    })
    .await
}

/// Like [`run_multi_channel`] but with an injectable per-step runner (tests).
pub async fn run_multi_channel_with<F, Fut>(
    req: ChannelRunRequest,
    run_one: F,
) -> MultiChannelSequenceResponse
where
    F: Fn(&QueueItemForRun, &HashMap<String, String>) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    let channels = resolve_channels(req.channels);
    let channel_meta: Vec<(usize, String)> = channels
        .iter()
        .map(|c| (c.channel_index, c.name.clone()))
        .collect();
    let run_generation = req.run_generation;
    req.progress
        .begin_channels(run_generation, &channel_meta)
        .await;

    let items = Arc::new(req.items);
    let base_vars = Arc::new(req.base_vars);
    let locks = req.resource_locks.clone();
    let progress = req.progress.clone();
    let timeout = req.resource_timeout;
    let sn_opt = req.sn.clone();
    let wo_opt = req.work_order.clone();

    let mut handles = Vec::with_capacity(channels.len());
    for ch in channels {
        let channel_index = ch.channel_index;
        let channel_name = ch.name.clone();
        let items = items.clone();
        let base_vars = base_vars.clone();
        let locks = locks.clone();
        let progress = progress.clone();
        let cancel = req.cancel.clone();
        let sn = sn_opt.clone();
        let work_order = wo_opt.clone();
        let run_one = run_one.clone();
        handles.push((
            channel_index,
            channel_name,
            tokio::spawn(async move {
                let vars =
                    apply_channel_overlay(&base_vars, ch.channel_index, &ch.name, &ch.overlay);
                let vars_for_step = vars.clone();
                let opts = SequenceRunOpts {
                    sn,
                    work_order,
                    vars,
                    progress: Some(progress),
                    progress_channel: Some((ch.channel_index, ch.name.clone())),
                    progress_generation: run_generation,
                    resource_locks: Some(locks),
                    resource_owner: format!("ch-{}", ch.channel_index),
                    resource_timeout: timeout,
                    cancel: Some(cancel),
                };
                let response =
                    run_sequence_from_with_opts(&items, 0, opts, Vec::new(), move |item| {
                        let run_one = run_one.clone();
                        let vars_for_step = vars_for_step.clone();
                        let item = item.clone();
                        async move { run_one(&item, &vars_for_step).await }
                    })
                    .await;
                ChannelSequenceResponse {
                    channel_index: ch.channel_index,
                    channel_name: ch.name,
                    run_generation,
                    response,
                }
            }),
        ));
    }

    let mut channel_results = Vec::with_capacity(handles.len());
    for (channel_index, channel_name, h) in handles {
        match h.await {
            Ok(r) => channel_results.push(r),
            Err(join_err) => {
                tracing::error!(error = %join_err, "channel worker panicked");
                channel_results.push(ChannelSequenceResponse {
                    channel_index,
                    channel_name,
                    run_generation,
                    response: SequenceResponse {
                        stopped: true,
                        failed_at: None,
                        steps: vec![],
                        sn: None,
                        work_order: None,
                        overall: "error".into(),
                        elapsed_ms: 0,
                    },
                });
            }
        }
    }

    channel_results.sort_by_key(|c| c.channel_index);

    let overalls: Vec<&str> = channel_results
        .iter()
        .map(|c| c.response.overall.as_str())
        .collect();
    let overall = aggregate_overall(&overalls);

    let sn = channel_results
        .iter()
        .find_map(|c| c.response.sn.clone())
        .or(sn_opt);
    let work_order = wo_opt;

    let steps_for_progress: Vec<_> = channel_results
        .iter()
        .map(|c| {
            (
                c.channel_index,
                c.channel_name.clone(),
                c.response.steps.clone(),
                c.response.overall.clone(),
            )
        })
        .collect();
    progress
        .finish_channels(run_generation, &steps_for_progress)
        .await;

    MultiChannelSequenceResponse {
        channels: channel_results,
        skipped_channel_indexes: Vec::new(),
        overall,
        sn,
        work_order,
    }
}

/// When Center channels cannot be loaded:
/// - if `channel_indexes` was set → hard error (do not invent CH0)
/// - otherwise → empty list (orchestrator synthesizes CH0)
pub fn channels_unavailable_fallback(
    channel_indexes: Option<&[usize]>,
    reason: &str,
) -> Result<Vec<ChannelSpec>, String> {
    if channel_indexes.is_some() {
        Err(format!(
            "failed to load channels (required when channel_indexes is set): {reason}"
        ))
    } else {
        Ok(Vec::new())
    }
}

/// Parse Center/Agent channels list JSON into enabled [`ChannelSpec`]s,
/// optionally filtered by `channel_indexes`.
pub fn channel_specs_from_list(
    body: &Value,
    channel_indexes: Option<&[usize]>,
) -> Result<Vec<ChannelSpec>, String> {
    let arr = body
        .get("channels")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "invalid channels response: missing channels".to_string())?;

    let mut out = Vec::new();
    for c in arr {
        let enabled = c.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        if !enabled {
            continue;
        }
        let channel_index =
            c.get("channel_index")
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i as u64)))
                .ok_or_else(|| "channel missing channel_index".to_string())? as usize;
        if let Some(filter) = channel_indexes {
            if !filter.contains(&channel_index) {
                continue;
            }
        }
        let name = c
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let overlay = c
            .get("overlay")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        out.push(ChannelSpec {
            channel_index,
            name,
            overlay,
        });
    }
    out.sort_by_key(|c| c.channel_index);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::watch;

    #[test]
    fn multi_overall_fails_if_any_channel_fails() {
        assert_eq!(aggregate_overall(&["pass", "fail"]), "fail");
        assert_eq!(aggregate_overall(&["pass", "pass"]), "pass");
    }

    #[test]
    fn multi_overall_fails_on_error_or_aborted() {
        assert_eq!(aggregate_overall(&["pass", "error"]), "fail");
        assert_eq!(aggregate_overall(&["aborted"]), "fail");
        assert_eq!(aggregate_overall(&["ok", "pass"]), "pass");
    }

    #[test]
    fn empty_channels_list_parses_to_empty_specs() {
        let specs = channel_specs_from_list(&json!({"channels": []}), None).unwrap();
        assert!(specs.is_empty());
    }

    #[test]
    fn channels_unavailable_soft_fallback_without_indexes() {
        let specs = channels_unavailable_fallback(None, "center down").unwrap();
        assert!(specs.is_empty());
    }

    #[test]
    fn channels_unavailable_hard_fails_when_indexes_requested() {
        let err = channels_unavailable_fallback(Some(&[0, 2]), "center down").unwrap_err();
        assert!(err.contains("channel_indexes"));
        assert!(err.contains("center down"));
    }

    #[test]
    fn channel_specs_filters_enabled_and_indexes() {
        let body = json!({
            "channels": [
                {"channel_index": 0, "name": "A", "enabled": true, "overlay": {"Port": "1"}},
                {"channel_index": 1, "name": "B", "enabled": false, "overlay": {}},
                {"channel_index": 2, "name": "C", "enabled": true, "overlay": {}}
            ]
        });
        let all = channel_specs_from_list(&body, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].channel_index, 0);
        assert_eq!(all[1].channel_index, 2);

        let filtered = channel_specs_from_list(&body, Some(&[2])).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "C");
    }

    #[tokio::test]
    async fn run_multi_channel_two_channels_aggregates_overall() {
        let locks = ResourceLockManager::new();
        let progress = SequenceProgressSlot::new();
        let (tx, rx) = watch::channel(false);
        let _keep = tx;

        let item = QueueItemForRun {
            position: 0,
            queue_item_id: "q0".into(),
            template_id: "t0".into(),
            name: "step".into(),
            kind: "labview".into(),
            vi_path: "C:\\x.vi".into(),
            inputs: json!([]),
            show_front_panel: false,
            timeout_secs: None,
            enabled: true,
            breakpoint: false,
            fail_policy: "stop".into(),
            limits: vec![],
            resources: vec![],
        };

        let calls = Arc::new(AtomicUsize::new(0));
        let calls2 = calls.clone();

        let req = ChannelRunRequest {
            items: vec![item],
            base_vars: HashMap::new(),
            channels: vec![
                ChannelSpec {
                    channel_index: 0,
                    name: "CH0".into(),
                    overlay: json!({}),
                },
                ChannelSpec {
                    channel_index: 1,
                    name: "CH1".into(),
                    overlay: json!({"Port": "2"}),
                },
            ],
            resource_locks: locks,
            resource_timeout: Duration::from_secs(5),
            sn: Some("SN1".into()),
            work_order: Some("WO1".into()),
            progress,
            cancel: rx,
            run_generation: 1,
        };

        let resp = run_multi_channel_with(req, move |_item, vars| {
            let calls2 = calls2.clone();
            let port = vars.get("Port").cloned();
            let ch = vars.get("Channel").cloned();
            async move {
                calls2.fetch_add(1, Ordering::SeqCst);
                // CH1 overlay Port=2 → fail; CH0 no Port → pass
                if port.as_deref() == Some("2") {
                    Ok(json!({"ok": false, "error": format!("fail on {ch:?}")}))
                } else {
                    Ok(json!({"ok": true}))
                }
            }
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(resp.channels.len(), 2);
        assert_eq!(resp.overall, "fail");
        assert_eq!(resp.sn.as_deref(), Some("SN1"));
        assert_eq!(resp.work_order.as_deref(), Some("WO1"));
        let ch0 = resp.channels.iter().find(|c| c.channel_index == 0).unwrap();
        let ch1 = resp.channels.iter().find(|c| c.channel_index == 1).unwrap();
        assert_eq!(ch0.response.overall, "pass");
        assert_eq!(ch1.response.overall, "fail");
    }

    #[tokio::test]
    async fn independent_requests_keep_both_channel_progress_entries() {
        let progress = SequenceProgressSlot::new();
        let locks = ResourceLockManager::new();
        let req0 = request_for_channel(0, 40, progress.clone(), locks.clone());
        let req1 = request_for_channel(1, 41, progress.clone(), locks.clone());

        let (r0, r1) = tokio::join!(
            run_multi_channel_with(req0, |_item, _vars| async { Ok(json!({"sum": 20})) }),
            run_multi_channel_with(req1, |_item, _vars| async { Ok(json!({"sum": 20})) })
        );

        assert_eq!(r0.channels[0].run_generation, 40);
        assert_eq!(r1.channels[0].run_generation, 41);
        let snapshot = progress.snapshot().await;
        assert_eq!(snapshot.channels.len(), 2);
        assert!(snapshot.channels.iter().all(|channel| !channel.running));
    }

    #[tokio::test]
    async fn panicked_nonzero_channel_keeps_its_response_and_finishes_progress() {
        let progress = SequenceProgressSlot::new();
        let req = request_for_channel(2, 42, progress.clone(), ResourceLockManager::new());

        let response = run_multi_channel_with(req, |_item, _vars| async move {
            panic!("worker panic");
        })
        .await;

        assert_eq!(response.channels.len(), 1);
        assert_eq!(response.channels[0].channel_index, 2);
        assert_eq!(response.channels[0].channel_name, "CH2");
        assert_eq!(response.channels[0].run_generation, 42);
        assert_eq!(response.channels[0].response.overall, "error");

        let snapshot = progress.snapshot().await;
        assert_eq!(snapshot.channels.len(), 1);
        assert_eq!(snapshot.channels[0].channel_index, 2);
        assert!(!snapshot.channels[0].running);
    }

    fn request_for_channel(
        channel_index: usize,
        generation: u64,
        progress: Arc<SequenceProgressSlot>,
        resource_locks: Arc<ResourceLockManager>,
    ) -> ChannelRunRequest {
        let (_cancel_tx, cancel) = watch::channel(false);
        ChannelRunRequest {
            items: vec![QueueItemForRun {
                position: 0,
                queue_item_id: format!("q-{channel_index}"),
                template_id: "add".into(),
                name: "Add".into(),
                kind: "general".into(),
                vi_path: String::new(),
                inputs: json!({"a": 10, "b": 10}),
                show_front_panel: false,
                timeout_secs: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits: vec![],
                resources: vec![],
            }],
            base_vars: HashMap::new(),
            channels: vec![ChannelSpec {
                channel_index,
                name: format!("CH{channel_index}"),
                overlay: json!({}),
            }],
            resource_locks,
            resource_timeout: Duration::from_secs(1),
            sn: None,
            work_order: None,
            progress,
            cancel,
            run_generation: generation,
        }
    }

    #[tokio::test]
    async fn cancel_stops_workers_between_steps() {
        let locks = ResourceLockManager::new();
        let progress = SequenceProgressSlot::new();
        let (tx, rx) = watch::channel(false);

        let items = vec![
            QueueItemForRun {
                position: 0,
                queue_item_id: "q0".into(),
                template_id: "t0".into(),
                name: "first".into(),
                kind: "labview".into(),
                vi_path: "C:\\x.vi".into(),
                inputs: json!([]),
                show_front_panel: false,
                timeout_secs: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits: vec![],
                resources: vec![],
            },
            QueueItemForRun {
                position: 1,
                queue_item_id: "q1".into(),
                template_id: "t1".into(),
                name: "second".into(),
                kind: "labview".into(),
                vi_path: "C:\\y.vi".into(),
                inputs: json!([]),
                show_front_panel: false,
                timeout_secs: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits: vec![],
                resources: vec![],
            },
        ];

        let req = ChannelRunRequest {
            items,
            base_vars: HashMap::new(),
            channels: vec![ChannelSpec {
                channel_index: 0,
                name: "CH0".into(),
                overlay: json!({}),
            }],
            resource_locks: locks,
            resource_timeout: Duration::from_secs(5),
            sn: None,
            work_order: None,
            progress,
            cancel: rx,
            run_generation: 1,
        };

        let resp = run_multi_channel_with(req, move |item, _vars| {
            let tx = tx.clone();
            let name = item.name.clone();
            async move {
                if name == "first" {
                    let _ = tx.send(true);
                }
                Ok(json!({"ok": true}))
            }
        })
        .await;

        assert_eq!(resp.overall, "fail");
        assert_eq!(resp.channels[0].response.overall, "aborted");
        assert_eq!(resp.channels[0].response.steps.len(), 1);
        assert_eq!(resp.channels[0].response.steps[0].name, "first");
    }
}
