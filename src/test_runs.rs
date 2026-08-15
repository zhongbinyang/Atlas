use chrono::Utc;
use crate::store::Store;

pub struct NewTestRun {
    pub id: String,
    pub agent_id: Option<String>,
    pub channel_index: i32,
    pub channel_name: String,
    pub sequence_template_id: Option<i64>,
    pub run_generation: i64,
    pub overall: String,
    pub stopped: bool,
    pub failed_at: Option<i32>,
    pub elapsed_ms: i64,
    pub started_at: String,
    pub finished_at: String,
    pub context: NewTestRunContext,
    pub steps: Vec<NewTestRunStep>,
}

pub struct NewTestRunContext {
    pub sn: String,
    pub work_order: String,
    pub product_pn: String,
    pub corner: String,
    pub hostname: String,
    pub config_revision: Option<i64>,
    pub device_profile_id: String,
    pub device_profile_name: String,
    pub calibration_profile_id: String,
    pub calibration_profile_name: String,
}

pub struct NewTestRunStep {
    pub position: i32,
    pub queue_item_id: String,
    pub template_id: String,
    pub template_source: String,
    pub name: String,
    pub kind: String,
    pub ok: bool,
    pub status: String,
    pub elapsed_ms: i64,
    pub measured: Option<serde_json::Value>,
    pub limits: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub spec_template_id: Option<i64>,
    pub spec_section: String,
}

pub struct InsertTestRunOutcome {
    pub created: bool,
    pub detail: TestRunDetail,
}

#[derive(Debug, Clone)]
pub struct TestRunDetail {
    pub id: String,
    pub agent_id: Option<String>,
    pub channel_index: i32,
    pub channel_name: String,
    pub sequence_template_id: Option<i64>,
    pub run_generation: i64,
    pub overall: String,
    pub stopped: bool,
    pub failed_at: Option<i32>,
    pub elapsed_ms: i64,
    pub started_at: String,
    pub finished_at: String,
    pub created_at: String,
    pub context: TestRunContext,
    pub steps: Vec<TestRunStep>,
}

#[derive(Debug, Clone)]
pub struct TestRunContext {
    pub sn: String,
    pub work_order: String,
    pub product_pn: String,
    pub corner: String,
    pub hostname: String,
    pub config_revision: Option<i64>,
    pub device_profile_id: String,
    pub device_profile_name: String,
    pub calibration_profile_id: String,
    pub calibration_profile_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TestRunStep {
    pub position: i32,
    pub queue_item_id: String,
    pub template_id: String,
    pub template_source: String,
    pub name: String,
    pub kind: String,
    pub ok: bool,
    pub status: String,
    pub elapsed_ms: i64,
    pub measured: Option<serde_json::Value>,
    pub limits: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub spec_template_id: Option<i64>,
    pub spec_section: String,
}

pub struct TestRunListQuery {
    pub agent_id: Option<String>,
    pub overall: Option<String>,
    pub sn: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

pub struct TestRunListPage {
    pub items: Vec<TestRunListItem>,
    pub total: i64,
}

#[derive(Debug, Clone)]
pub struct TestRunListItem {
    pub id: String,
    pub agent_id: Option<String>,
    pub channel_index: i32,
    pub channel_name: String,
    pub sequence_template_id: Option<i64>,
    pub overall: String,
    pub elapsed_ms: i64,
    pub started_at: String,
    pub finished_at: String,
    pub sn: String,
    pub work_order: String,
    pub hostname: String,
}

#[derive(sqlx::FromRow)]
struct TestRunRow {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    run_generation: i64,
    overall: String,
    stopped: bool,
    failed_at: Option<i32>,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct TestRunContextRow {
    sn: String,
    work_order: String,
    product_pn: String,
    corner: String,
    hostname: String,
    config_revision: Option<i64>,
    device_profile_id: String,
    device_profile_name: String,
    calibration_profile_id: String,
    calibration_profile_name: String,
}

impl TestRunContextRow {
    fn into_context(self) -> TestRunContext {
        TestRunContext {
            sn: self.sn,
            work_order: self.work_order,
            product_pn: self.product_pn,
            corner: self.corner,
            hostname: self.hostname,
            config_revision: self.config_revision,
            device_profile_id: self.device_profile_id,
            device_profile_name: self.device_profile_name,
            calibration_profile_id: self.calibration_profile_id,
            calibration_profile_name: self.calibration_profile_name,
        }
    }
}

#[derive(sqlx::FromRow)]
struct TestRunStepRow {
    position: i32,
    queue_item_id: String,
    template_id: String,
    template_source: String,
    name: String,
    kind: String,
    ok: bool,
    status: String,
    elapsed_ms: i64,
    measured_json: Option<String>,
    limits_json: Option<String>,
    result_json: Option<String>,
    error: Option<String>,
    spec_template_id: Option<i64>,
    spec_section: String,
}

impl TestRunStepRow {
    fn into_step(self) -> TestRunStep {
        TestRunStep {
            position: self.position,
            queue_item_id: self.queue_item_id,
            template_id: self.template_id,
            template_source: self.template_source,
            name: self.name,
            kind: self.kind,
            ok: self.ok,
            status: self.status,
            elapsed_ms: self.elapsed_ms,
            measured: parse_json(self.measured_json),
            limits: parse_json(self.limits_json),
            result: parse_json(self.result_json),
            error: self.error,
            spec_template_id: self.spec_template_id,
            spec_section: self.spec_section,
        }
    }
}

#[derive(sqlx::FromRow)]
struct TestRunListItemRow {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    overall: String,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    sn: String,
    work_order: String,
    hostname: String,
}

impl TestRunListItemRow {
    fn into_item(self) -> TestRunListItem {
        TestRunListItem {
            id: self.id,
            agent_id: self.agent_id,
            channel_index: self.channel_index,
            channel_name: self.channel_name,
            sequence_template_id: self.sequence_template_id,
            overall: self.overall,
            elapsed_ms: self.elapsed_ms,
            started_at: self.started_at,
            finished_at: self.finished_at,
            sn: self.sn,
            work_order: self.work_order,
            hostname: self.hostname,
        }
    }
}

const LIST_FILTER_SQL: &str = r#"
FROM test_runs r
INNER JOIN test_run_context c ON c.test_run_id = r.id
WHERE ($1::text IS NULL OR r.agent_id = $1)
  AND ($2::text IS NULL OR r.overall = $2)
  AND ($3::text IS NULL OR c.sn = $3)
  AND ($4::text IS NULL OR r.finished_at >= $4)
  AND ($5::text IS NULL OR r.finished_at <= $5)
"#;

fn json_text(value: &Option<serde_json::Value>) -> Result<Option<String>, sqlx::Error> {
    match value {
        None => Ok(None),
        Some(v) => serde_json::to_string(v)
            .map(Some)
            .map_err(|e| sqlx::Error::Protocol(format!("json encode: {e}"))),
    }
}

fn parse_json(text: Option<String>) -> Option<serde_json::Value> {
    text.and_then(|s| serde_json::from_str(&s).ok())
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|s| if s.is_empty() { None } else { Some(s) })
}

fn clamp_limit(limit: i64) -> i64 {
    if limit <= 0 {
        100
    } else {
        limit.clamp(1, 200)
    }
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db) => db.is_unique_violation(),
        _ => false,
    }
}

impl Store {
    pub async fn insert_test_run(
        &self,
        mut run: NewTestRun,
    ) -> Result<InsertTestRunOutcome, sqlx::Error> {
        if let Some(detail) = self.get_test_run(&run.id).await? {
            return Ok(InsertTestRunOutcome {
                created: false,
                detail,
            });
        }

        if let Some(template_id) = run.sequence_template_id {
            let exists: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM sequence_templates WHERE id = $1")
                    .bind(template_id)
                    .fetch_optional(self.pool())
                    .await?;
            if exists.is_none() {
                run.sequence_template_id = None;
            }
        }

        let created_at = Utc::now().to_rfc3339();
        let mut tx = self.pool().begin().await?;
        let insert_run = sqlx::query(
            r#"
            INSERT INTO test_runs (
              id, agent_id, channel_index, channel_name, sequence_template_id,
              run_generation, overall, stopped, failed_at, elapsed_ms,
              started_at, finished_at, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
        )
        .bind(&run.id)
        .bind(&run.agent_id)
        .bind(run.channel_index)
        .bind(&run.channel_name)
        .bind(run.sequence_template_id)
        .bind(run.run_generation)
        .bind(&run.overall)
        .bind(run.stopped)
        .bind(run.failed_at)
        .bind(run.elapsed_ms)
        .bind(&run.started_at)
        .bind(&run.finished_at)
        .bind(&created_at)
        .execute(&mut *tx)
        .await;

        if let Err(e) = insert_run {
            let _ = tx.rollback().await;
            if is_unique_violation(&e) {
                let detail = self.get_test_run(&run.id).await?.ok_or_else(|| {
                    sqlx::Error::Protocol("test run missing after unique violation".into())
                })?;
                return Ok(InsertTestRunOutcome {
                    created: false,
                    detail,
                });
            }
            return Err(e);
        }

        sqlx::query(
            r#"
            INSERT INTO test_run_context (
              test_run_id, sn, work_order, product_pn, corner, hostname,
              config_revision, device_profile_id, device_profile_name,
              calibration_profile_id, calibration_profile_name
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
        )
        .bind(&run.id)
        .bind(&run.context.sn)
        .bind(&run.context.work_order)
        .bind(&run.context.product_pn)
        .bind(&run.context.corner)
        .bind(&run.context.hostname)
        .bind(run.context.config_revision)
        .bind(&run.context.device_profile_id)
        .bind(&run.context.device_profile_name)
        .bind(&run.context.calibration_profile_id)
        .bind(&run.context.calibration_profile_name)
        .execute(&mut *tx)
        .await?;

        for step in &run.steps {
            let measured = json_text(&step.measured)?;
            let limits = json_text(&step.limits)?;
            let result = json_text(&step.result)?;
            sqlx::query(
                r#"
                INSERT INTO test_run_steps (
                  test_run_id, position, queue_item_id, template_id, template_source,
                  name, kind, ok, status, elapsed_ms,
                  measured_json, limits_json, result_json, error,
                  spec_template_id, spec_section
                )
                VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                  $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16
                )
                "#,
            )
            .bind(&run.id)
            .bind(step.position)
            .bind(&step.queue_item_id)
            .bind(&step.template_id)
            .bind(&step.template_source)
            .bind(&step.name)
            .bind(&step.kind)
            .bind(step.ok)
            .bind(&step.status)
            .bind(step.elapsed_ms)
            .bind(measured)
            .bind(limits)
            .bind(result)
            .bind(&step.error)
            .bind(step.spec_template_id)
            .bind(&step.spec_section)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        let detail = self.get_test_run(&run.id).await?.ok_or_else(|| {
            sqlx::Error::Protocol("test run missing after insert".into())
        })?;
        Ok(InsertTestRunOutcome {
            created: true,
            detail,
        })
    }

    pub async fn get_test_run(&self, id: &str) -> Result<Option<TestRunDetail>, sqlx::Error> {
        let row = sqlx::query_as::<_, TestRunRow>(
            r#"
            SELECT
              id, agent_id, channel_index, channel_name, sequence_template_id,
              run_generation, overall, stopped, failed_at, elapsed_ms,
              started_at, finished_at, created_at
            FROM test_runs
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(self.pool())
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let context = sqlx::query_as::<_, TestRunContextRow>(
            r#"
            SELECT
              sn, work_order, product_pn, corner, hostname, config_revision,
              device_profile_id, device_profile_name,
              calibration_profile_id, calibration_profile_name
            FROM test_run_context
            WHERE test_run_id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(self.pool())
        .await?
        .map(TestRunContextRow::into_context)
        .unwrap_or(TestRunContext {
            sn: String::new(),
            work_order: String::new(),
            product_pn: String::new(),
            corner: String::new(),
            hostname: String::new(),
            config_revision: None,
            device_profile_id: String::new(),
            device_profile_name: String::new(),
            calibration_profile_id: String::new(),
            calibration_profile_name: String::new(),
        });

        let steps = sqlx::query_as::<_, TestRunStepRow>(
            r#"
            SELECT
              position, queue_item_id, template_id, template_source, name, kind,
              ok, status, elapsed_ms,
              measured_json::text AS measured_json,
              limits_json::text AS limits_json,
              result_json::text AS result_json,
              error, spec_template_id, spec_section
            FROM test_run_steps
            WHERE test_run_id = $1
            ORDER BY position ASC
            "#,
        )
        .bind(id)
        .fetch_all(self.pool())
        .await?
        .into_iter()
        .map(TestRunStepRow::into_step)
        .collect();

        Ok(Some(TestRunDetail {
            id: row.id,
            agent_id: row.agent_id,
            channel_index: row.channel_index,
            channel_name: row.channel_name,
            sequence_template_id: row.sequence_template_id,
            run_generation: row.run_generation,
            overall: row.overall,
            stopped: row.stopped,
            failed_at: row.failed_at,
            elapsed_ms: row.elapsed_ms,
            started_at: row.started_at,
            finished_at: row.finished_at,
            created_at: row.created_at,
            context,
            steps,
        }))
    }

    pub async fn list_test_runs(
        &self,
        query: TestRunListQuery,
    ) -> Result<TestRunListPage, sqlx::Error> {
        let agent_id = query.agent_id;
        let overall = query.overall;
        let sn = blank_to_none(query.sn);
        let from = blank_to_none(query.from);
        let to = blank_to_none(query.to);
        let limit = clamp_limit(query.limit);
        let offset = query.offset.max(0);

        let count_sql = format!("SELECT COUNT(*)::bigint {LIST_FILTER_SQL}");
        let total: i64 = sqlx::query_scalar(&count_sql)
            .bind(&agent_id)
            .bind(&overall)
            .bind(&sn)
            .bind(&from)
            .bind(&to)
            .fetch_one(self.pool())
            .await?;

        let list_sql = format!(
            r#"
            SELECT
              r.id, r.agent_id, r.channel_index, r.channel_name, r.sequence_template_id,
              r.overall, r.elapsed_ms, r.started_at, r.finished_at,
              c.sn, c.work_order, c.hostname
            {LIST_FILTER_SQL}
            ORDER BY r.finished_at DESC, r.id DESC
            LIMIT $6 OFFSET $7
            "#
        );
        let items = sqlx::query_as::<_, TestRunListItemRow>(&list_sql)
            .bind(&agent_id)
            .bind(&overall)
            .bind(&sn)
            .bind(&from)
            .bind(&to)
            .bind(limit)
            .bind(offset)
            .fetch_all(self.pool())
            .await?
            .into_iter()
            .map(TestRunListItemRow::into_item)
            .collect();

        Ok(TestRunListPage { items, total })
    }

    pub async fn agent_exists(&self, id: &str) -> Result<bool, sqlx::Error> {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM agents WHERE id = $1")
            .bind(id)
            .fetch_optional(self.pool())
            .await?;
        Ok(found.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

    async fn store() -> crate::db::GuardedStore {
        crate::db::GuardedStore::new().await
    }

    fn sample(agent_id: &str, id: &str, sn: &str, overall: &str, finished_at: &str) -> NewTestRun {
        NewTestRun {
            id: id.into(),
            agent_id: Some(agent_id.into()),
            channel_index: 0,
            channel_name: "CH0".into(),
            sequence_template_id: None,
            run_generation: 7,
            overall: overall.into(),
            stopped: false,
            failed_at: None,
            elapsed_ms: 12,
            started_at: "2026-08-15T14:00:00+00:00".into(),
            finished_at: finished_at.into(),
            context: NewTestRunContext {
                sn: sn.into(),
                work_order: "WO-1".into(),
                product_pn: String::new(),
                corner: String::new(),
                hostname: "ATE01".into(),
                config_revision: Some(3),
                device_profile_id: String::new(),
                device_profile_name: String::new(),
                calibration_profile_id: String::new(),
                calibration_profile_name: String::new(),
            },
            steps: vec![NewTestRunStep {
                position: 1,
                queue_item_id: "q-1".into(),
                template_id: "12".into(),
                template_source: "labview".into(),
                name: "TX_AP".into(),
                kind: "labview".into(),
                ok: true,
                status: "pass".into(),
                elapsed_ms: 10,
                measured: Some(json!({"TX_AP": 1.2})),
                limits: Some(json!([{"output":"TX_AP","min":-2.0,"max":4.0}])),
                result: Some(json!({"TX_AP":"pass"})),
                error: None,
                spec_template_id: Some(1),
                spec_section: "FMT_HT".into(),
            }],
        }
    }

    #[tokio::test]
    async fn insert_then_get_round_trips_steps_and_context() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        let created = store
            .insert_test_run(sample(&agent.id, "run-1", "SN001", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        assert!(created.created);
        let got = store.get_test_run("run-1").await.unwrap().unwrap();
        assert_eq!(got.channel_name, "CH0");
        assert_eq!(got.context.sn, "SN001");
        assert_eq!(got.steps.len(), 1);
        assert_eq!(got.steps[0].spec_section, "FMT_HT");
        assert_eq!(got.steps[0].measured, Some(json!({"TX_AP": 1.2})));
    }

    #[tokio::test]
    async fn second_insert_same_id_is_not_created_and_does_not_overwrite() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        store
            .insert_test_run(sample(&agent.id, "run-dup", "SN001", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        let mut again = sample(&agent.id, "run-dup", "SN999", "fail", "2026-08-15T15:00:00+00:00");
        again.steps.clear();
        let outcome = store.insert_test_run(again).await.unwrap();
        assert!(!outcome.created);
        let got = store.get_test_run("run-dup").await.unwrap().unwrap();
        assert_eq!(got.overall, "pass");
        assert_eq!(got.context.sn, "SN001");
        assert_eq!(got.steps.len(), 1);
    }

    #[tokio::test]
    async fn unknown_sequence_template_id_is_stored_as_null() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        let mut run = sample(&agent.id, "run-tpl", "", "pass", "2026-08-15T14:01:00+00:00");
        run.sequence_template_id = Some(999_999);
        let outcome = store.insert_test_run(run).await.unwrap();
        assert!(outcome.created);
        let got = store.get_test_run("run-tpl").await.unwrap().unwrap();
        assert_eq!(got.sequence_template_id, None);
    }

    #[tokio::test]
    async fn list_filters_agent_overall_sn_and_time_and_ignores_empty_sn_param() {
        let store = store().await;
        let a = store.upsert_agent("a", "1.2.3.4", 9090).await.unwrap();
        let b = store.upsert_agent("b", "1.2.3.5", 9090).await.unwrap();
        store
            .insert_test_run(sample(&a.id, "r1", "SN-A", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        store
            .insert_test_run(sample(&a.id, "r2", "", "fail", "2026-08-15T14:02:00+00:00"))
            .await
            .unwrap();
        store
            .insert_test_run(sample(&b.id, "r3", "SN-A", "pass", "2026-08-15T14:03:00+00:00"))
            .await
            .unwrap();

        let page = store
            .list_test_runs(TestRunListQuery {
                agent_id: Some(a.id.clone()),
                overall: Some("pass".into()),
                sn: Some("SN-A".into()),
                from: None,
                to: None,
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "r1");

        let empty_sn = store
            .list_test_runs(TestRunListQuery {
                agent_id: Some(a.id.clone()),
                overall: None,
                sn: Some(String::new()),
                from: None,
                to: None,
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(empty_sn.total, 2);

        let window = store
            .list_test_runs(TestRunListQuery {
                agent_id: None,
                overall: None,
                sn: None,
                from: Some("2026-08-15T14:02:00+00:00".into()),
                to: Some("2026-08-15T14:03:00+00:00".into()),
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(window.total, 2);
        assert_eq!(window.items[0].id, "r3");
        assert_eq!(window.items[1].id, "r2");
    }
}
