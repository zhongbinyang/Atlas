use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub status: String,
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub busy: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

pub use common::{AgentUnit, AgentVariable};

#[derive(Debug, Clone, Default)]
pub struct AgentSettings {
    pub units: Vec<AgentUnit>,
    pub variables: Vec<AgentVariable>,
    pub array_expand_mode: common::ArrayExpandMode,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CenterUnits {
    pub units: Vec<AgentUnit>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct CenterUnitsRow {
    #[allow(dead_code)]
    id: String,
    units_json: String,
    updated_at: String,
}

impl CenterUnitsRow {
    fn into_units(self) -> CenterUnits {
        CenterUnits {
            units: common::parse_units_json(&self.units_json),
            updated_at: Some(self.updated_at),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentConfigProfile {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub setting_json: String,
    pub is_active: bool,
    pub source_filename: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AgentConfigProfileRow {
    id: String,
    agent_id: String,
    name: String,
    setting_json: String,
    is_active: bool,
    source_filename: String,
    updated_at: String,
}

impl AgentConfigProfileRow {
    fn into_profile(self) -> AgentConfigProfile {
        AgentConfigProfile {
            id: self.id,
            agent_id: self.agent_id,
            name: self.name,
            setting_json: self.setting_json,
            is_active: self.is_active,
            source_filename: self.source_filename,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AgentSettingsRow {
    #[allow(dead_code)]
    agent_id: String,
    units_json: String,
    variables_json: String,
    #[sqlx(default)]
    array_expand_mode: String,
    updated_at: String,
}

impl AgentSettingsRow {
    fn into_settings(self) -> AgentSettings {
        let units = common::parse_units_json(&self.units_json);
        let variables: Vec<AgentVariable> =
            serde_json::from_str(&self.variables_json).unwrap_or_default();
        AgentSettings {
            units,
            variables,
            array_expand_mode: common::ArrayExpandMode::parse(&self.array_expand_mode),
            updated_at: Some(self.updated_at),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskTemplate {
    pub id: String,
    pub name: String,
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub agent_id: String,
    pub source: String,
    pub template_id: Option<String>,
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: i64,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub agent_task_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateTaskParams {
    pub agent_id: String,
    pub source: String,
    pub template_id: Option<String>,
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: i64,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateTemplateParams {
    pub name: Option<String>,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub workdir: Option<Option<String>>,
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct TaskUpdate {
    pub status: Option<String>,
    pub exit_code: Option<Option<i32>>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub agent_task_id: Option<Option<String>>,
    pub started_at: Option<Option<String>>,
    pub finished_at: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct ViTemplate {
    pub id: i64,
    pub name: String,
    pub origin_agent_id: String,
    pub kind: String,
    pub vi_path: String,
    pub cli_path: String,
    pub getinfo_path: String,
    pub inputs_json: String,
    pub outputs_json: String,
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct GeneralTemplate {
    pub id: i64,
    pub name: String,
    pub origin_agent_id: String,
    pub kind: String,
    pub inputs_json: String,
    pub outputs_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SequenceTemplate {
    pub id: i64,
    pub name: String,
    pub note: String,
    pub created_by_agent_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SequenceTemplateStep {
    pub id: i64,
    pub sequence_template_id: i64,
    pub position: i64,
    pub template_source: String,
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub inputs_json: String,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits_json: String,
    pub note: String,
    pub title: String,
    pub collapsed: bool,
}

#[derive(Debug, Clone)]
pub struct SequenceTemplateEnriched {
    pub template: SequenceTemplate,
    pub created_by_agent_name: Option<String>,
    pub step_count: i64,
}

#[derive(Debug, Clone)]
pub struct ViRunQueueReplaceItem {
    pub template_source: String, // "labview" | "general" | "group"
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub inputs_json: Option<String>,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String, // "stop" | "continue"
    pub limits_json: String,   // JSON array text
    pub note: String,
    pub title: String,
    pub collapsed: bool,
}

#[derive(Debug, Clone)]
pub struct ViRunQueueItem {
    pub id: String,
    pub agent_id: String,
    pub template_source: String,
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub position: i64,
    pub created_at: String,
    pub template_name: String,
    pub kind: String,
    pub vi_path: String,
    pub inputs_json: String,
    pub outputs_json: String,
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits_json: String,
    pub note: String,
    pub title: String,
    pub collapsed: bool,
}

fn normalize_fail_policy(fail_policy: &str) -> &'static str {
    match fail_policy {
        "continue" => "continue",
        _ => "stop",
    }
}

#[derive(Debug)]
pub enum QueueReplaceError {
    AgentNotFound,
    BadTemplate {
        template_source: String,
        template_id: i64,
    },
    Db(sqlx::Error),
}

#[derive(Debug, Clone, Default)]
pub struct ViTemplatePatch {
    pub name: Option<String>,
    pub inputs: Option<serde_json::Value>,
    pub show_front_panel: Option<bool>,
    pub timeout_secs: Option<Option<i64>>,
}

#[derive(Debug)]
pub enum TransferError {
    NotFound,
    AgentNotFound,
    Db(sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct ViTemplateEnriched {
    pub template: ViTemplate,
    pub origin_agent_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GeneralTemplateEnriched {
    pub template: GeneralTemplate,
    pub origin_agent_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Screenshot {
    pub id: String,
    pub agent_id: String,
    pub file_path: String,
    pub content_type: String,
    pub byte_size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub created_at: String,
}

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

impl Store {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn upsert_agent(
        &self,
        name: &str,
        ip: &str,
        port: u16,
    ) -> Result<Agent, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let row = sqlx::query_as::<_, AgentRow>(
            r#"
            INSERT INTO agents (id, name, ip, port, status, cpu_percent, memory_percent, busy, created_at)
            VALUES ($1, $2, $3, $4, 'offline', 0, 0, 0, $5)
            ON CONFLICT (name, ip, port) DO UPDATE SET name = EXCLUDED.name
            RETURNING id, name, ip, port, status, cpu_percent, memory_percent, busy, last_seen_at, created_at
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(ip)
        .bind(i64::from(port))
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_agent())
    }

    pub async fn list_agents(&self) -> Result<Vec<Agent>, sqlx::Error> {
        let rows = sqlx::query_as::<_, AgentRow>(
            r#"
            SELECT id, name, ip, port, status, cpu_percent, memory_percent, busy, last_seen_at, created_at
            FROM agents
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_agent()).collect())
    }

    pub async fn get_agent(&self, id: &str) -> Result<Option<Agent>, sqlx::Error> {
        let row = sqlx::query_as::<_, AgentRow>(
            r#"
            SELECT id, name, ip, port, status, cpu_percent, memory_percent, busy, last_seen_at, created_at
            FROM agents
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_agent()))
    }

    pub async fn update_agent_status(&self, id: &str, status: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agents SET status = $1 WHERE id = $2")
            .bind(status)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn update_agent_metrics(
        &self,
        id: &str,
        status: &str,
        cpu_percent: f32,
        memory_percent: f32,
        busy: bool,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE agents
            SET status = $1, cpu_percent = $2, memory_percent = $3, busy = $4, last_seen_at = $5
            WHERE id = $6
            "#,
        )
        .bind(status)
        .bind(cpu_percent)
        .bind(memory_percent)
        .bind(i64::from(busy))
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_agent_offline(&self, id: &str) -> Result<(), sqlx::Error> {
        self.update_agent_status(id, "offline").await
    }

    pub async fn get_agent_settings(&self, agent_id: &str) -> Result<AgentSettings, sqlx::Error> {
        let row = sqlx::query_as::<_, AgentSettingsRow>(
            r#"
            SELECT agent_id, units_json, variables_json,
                   COALESCE(array_expand_mode, 'semicolon') AS array_expand_mode,
                   updated_at
            FROM agent_settings
            WHERE agent_id = $1
            "#,
        )
        .bind(agent_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .map(|r| r.into_settings())
            .unwrap_or_else(|| AgentSettings {
                units: Vec::new(),
                variables: common::default_agent_variables(),
                array_expand_mode: common::ArrayExpandMode::Semicolon,
                updated_at: None,
            }))
    }

    /// Persist variables + array expand mode; leave legacy `units_json` unchanged.
    pub async fn upsert_agent_settings(
        &self,
        agent_id: &str,
        variables: &[AgentVariable],
        array_expand_mode: common::ArrayExpandMode,
    ) -> Result<AgentSettings, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let variables_json = serde_json::to_string(variables).unwrap_or_else(|_| "[]".into());
        let mode = array_expand_mode.as_str();
        sqlx::query(
            r#"
            INSERT INTO agent_settings (agent_id, units_json, variables_json, array_expand_mode, updated_at)
            VALUES ($1, '[]', $2, $3, $4)
            ON CONFLICT (agent_id) DO UPDATE SET
              variables_json = EXCLUDED.variables_json,
              array_expand_mode = EXCLUDED.array_expand_mode,
              updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(agent_id)
        .bind(&variables_json)
        .bind(mode)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_agent_settings(agent_id).await
    }

    pub async fn get_center_units(&self) -> Result<CenterUnits, sqlx::Error> {
        let row = sqlx::query_as::<_, CenterUnitsRow>(
            r#"
            SELECT id, units_json, updated_at
            FROM center_units
            WHERE id = 'default'
            "#,
        )
        .fetch_optional(&self.pool)
        .await?;
        if let Some(r) = row {
            return Ok(r.into_units());
        }
        self.seed_center_units().await
    }

    async fn seed_center_units(&self) -> Result<CenterUnits, sqlx::Error> {
        // Prefer first non-empty historical per-agent units list; else optical defaults.
        let legacy_rows: Vec<(String,)> = sqlx::query_as(
            r#"
            SELECT units_json
            FROM agent_settings
            WHERE units_json IS NOT NULL AND units_json <> '' AND units_json <> '[]'
            ORDER BY updated_at DESC
            LIMIT 20
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let mut units = common::default_agent_units();
        for (raw,) in legacy_rows {
            let parsed = common::parse_units_json(&raw);
            if !parsed.is_empty() {
                units = parsed;
                break;
            }
        }
        self.upsert_center_units(&units).await
    }

    pub async fn upsert_center_units(
        &self,
        units: &[AgentUnit],
    ) -> Result<CenterUnits, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let units_json = serde_json::to_string(units).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            r#"
            INSERT INTO center_units (id, units_json, updated_at)
            VALUES ('default', $1, $2)
            ON CONFLICT (id) DO UPDATE SET
              units_json = EXCLUDED.units_json,
              updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&units_json)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(CenterUnits {
            units: units.to_vec(),
            updated_at: Some(now),
        })
    }

    pub async fn list_device_profiles(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentConfigProfile>, sqlx::Error> {
        self.list_config_profiles("agent_device_profiles", agent_id)
            .await
    }

    pub async fn list_calibration_profiles(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentConfigProfile>, sqlx::Error> {
        self.list_config_profiles("agent_calibration_profiles", agent_id)
            .await
    }

    async fn list_config_profiles(
        &self,
        table: &str,
        agent_id: &str,
    ) -> Result<Vec<AgentConfigProfile>, sqlx::Error> {
        // table is an internal constant only
        let sql = format!(
            r#"
            SELECT id, agent_id, name, setting_json, is_active, source_filename, updated_at
            FROM {table}
            WHERE agent_id = $1
            ORDER BY name ASC, updated_at DESC
            "#
        );
        let rows = sqlx::query_as::<_, AgentConfigProfileRow>(&sql)
            .bind(agent_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.into_profile()).collect())
    }

    pub async fn create_device_profile(
        &self,
        agent_id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
        activate: bool,
    ) -> Result<AgentConfigProfile, sqlx::Error> {
        self.create_config_profile(
            "agent_device_profiles",
            agent_id,
            name,
            setting_json,
            source_filename,
            activate,
        )
        .await
    }

    pub async fn create_calibration_profile(
        &self,
        agent_id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
        activate: bool,
    ) -> Result<AgentConfigProfile, sqlx::Error> {
        self.create_config_profile(
            "agent_calibration_profiles",
            agent_id,
            name,
            setting_json,
            source_filename,
            activate,
        )
        .await
    }

    async fn create_config_profile(
        &self,
        table: &str,
        agent_id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
        activate: bool,
    ) -> Result<AgentConfigProfile, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        if activate {
            let clear = format!("UPDATE {table} SET is_active = FALSE WHERE agent_id = $1");
            sqlx::query(&clear).bind(agent_id).execute(&mut *tx).await?;
        }
        let insert = format!(
            r#"
            INSERT INTO {table} (id, agent_id, name, setting_json, is_active, source_filename, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#
        );
        sqlx::query(&insert)
            .bind(&id)
            .bind(agent_id)
            .bind(name)
            .bind(setting_json)
            .bind(activate)
            .bind(source_filename)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.get_config_profile(table, &id)
            .await
            .map(|o| o.expect("just inserted"))
    }

    async fn get_config_profile(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        let sql = format!(
            r#"
            SELECT id, agent_id, name, setting_json, is_active, source_filename, updated_at
            FROM {table}
            WHERE id = $1
            "#
        );
        let row = sqlx::query_as::<_, AgentConfigProfileRow>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.into_profile()))
    }

    pub async fn get_device_profile(
        &self,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.get_config_profile("agent_device_profiles", id).await
    }

    pub async fn get_calibration_profile(
        &self,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.get_config_profile("agent_calibration_profiles", id)
            .await
    }

    pub async fn update_device_profile(
        &self,
        id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.update_config_profile(
            "agent_device_profiles",
            id,
            name,
            setting_json,
            source_filename,
        )
        .await
    }

    pub async fn update_calibration_profile(
        &self,
        id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.update_config_profile(
            "agent_calibration_profiles",
            id,
            name,
            setting_json,
            source_filename,
        )
        .await
    }

    async fn update_config_profile(
        &self,
        table: &str,
        id: &str,
        name: &str,
        setting_json: &str,
        source_filename: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let sql = format!(
            r#"
            UPDATE {table}
            SET name = $2, setting_json = $3, source_filename = $4, updated_at = $5
            WHERE id = $1
            "#
        );
        let res = sqlx::query(&sql)
            .bind(id)
            .bind(name)
            .bind(setting_json)
            .bind(source_filename)
            .bind(&now)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_config_profile(table, id).await
    }

    pub async fn delete_device_profile(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.delete_config_profile("agent_device_profiles", id).await
    }

    pub async fn delete_calibration_profile(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.delete_config_profile("agent_calibration_profiles", id)
            .await
    }

    async fn delete_config_profile(&self, table: &str, id: &str) -> Result<bool, sqlx::Error> {
        let sql = format!("DELETE FROM {table} WHERE id = $1");
        let res = sqlx::query(&sql).bind(id).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn activate_device_profile(
        &self,
        agent_id: &str,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.activate_config_profile("agent_device_profiles", agent_id, id)
            .await
    }

    pub async fn activate_calibration_profile(
        &self,
        agent_id: &str,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.activate_config_profile("agent_calibration_profiles", agent_id, id)
            .await
    }

    async fn activate_config_profile(
        &self,
        table: &str,
        agent_id: &str,
        id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        let existing = self.get_config_profile(table, id).await?;
        let Some(p) = existing else {
            return Ok(None);
        };
        if p.agent_id != agent_id {
            return Ok(None);
        }
        let mut tx = self.pool.begin().await?;
        let clear = format!("UPDATE {table} SET is_active = FALSE WHERE agent_id = $1");
        sqlx::query(&clear)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
        let now = Utc::now().to_rfc3339();
        let set = format!(
            "UPDATE {table} SET is_active = TRUE, updated_at = $2 WHERE id = $1 AND agent_id = $3"
        );
        sqlx::query(&set)
            .bind(id)
            .bind(&now)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.get_config_profile(table, id).await
    }

    pub async fn get_active_device_profile(
        &self,
        agent_id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.get_active_config_profile("agent_device_profiles", agent_id)
            .await
    }

    pub async fn get_active_calibration_profile(
        &self,
        agent_id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        self.get_active_config_profile("agent_calibration_profiles", agent_id)
            .await
    }

    async fn get_active_config_profile(
        &self,
        table: &str,
        agent_id: &str,
    ) -> Result<Option<AgentConfigProfile>, sqlx::Error> {
        let sql = format!(
            r#"
            SELECT id, agent_id, name, setting_json, is_active, source_filename, updated_at
            FROM {table}
            WHERE agent_id = $1 AND is_active = TRUE
            LIMIT 1
            "#
        );
        let row = sqlx::query_as::<_, AgentConfigProfileRow>(&sql)
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.into_profile()))
    }

    pub async fn create_template(
        &self,
        name: &str,
        shell: &str,
        command: &str,
        workdir: Option<&str>,
        timeout_secs: i64,
    ) -> Result<TaskTemplate, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let row = sqlx::query_as::<_, TemplateRow>(
            r#"
            INSERT INTO task_templates (id, name, shell, command, workdir, timeout_secs, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, name, shell, command, workdir, timeout_secs, created_at
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(shell)
        .bind(command)
        .bind(workdir)
        .bind(timeout_secs)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_template())
    }

    pub async fn list_templates(&self) -> Result<Vec<TaskTemplate>, sqlx::Error> {
        let rows = sqlx::query_as::<_, TemplateRow>(
            r#"
            SELECT id, name, shell, command, workdir, timeout_secs, created_at
            FROM task_templates
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_template()).collect())
    }

    pub async fn get_template(&self, id: &str) -> Result<Option<TaskTemplate>, sqlx::Error> {
        let row = sqlx::query_as::<_, TemplateRow>(
            r#"
            SELECT id, name, shell, command, workdir, timeout_secs, created_at
            FROM task_templates
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_template()))
    }

    pub async fn update_template(
        &self,
        id: &str,
        update: UpdateTemplateParams,
    ) -> Result<Option<TaskTemplate>, sqlx::Error> {
        let current = match self.get_template(id).await? {
            Some(t) => t,
            None => return Ok(None),
        };
        let name = update.name.unwrap_or(current.name);
        let shell = update.shell.unwrap_or(current.shell);
        let command = update.command.unwrap_or(current.command);
        let workdir = match update.workdir {
            Some(w) => w,
            None => current.workdir,
        };
        let timeout_secs = update.timeout_secs.unwrap_or(current.timeout_secs);
        sqlx::query(
            r#"
            UPDATE task_templates
            SET name = $1, shell = $2, command = $3, workdir = $4, timeout_secs = $5
            WHERE id = $6
            "#,
        )
        .bind(&name)
        .bind(&shell)
        .bind(&command)
        .bind(&workdir)
        .bind(timeout_secs)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_template(id).await
    }

    pub async fn delete_template(&self, id: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM task_templates WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn create_task(&self, params: CreateTaskParams) -> Result<Task, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let row = sqlx::query_as::<_, TaskRow>(
            r#"
            INSERT INTO tasks (
                id, agent_id, source, template_id, shell, command, workdir, timeout_secs,
                status, exit_code, stdout, stderr, agent_task_id, created_at, started_at, finished_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', NULL, '', '', NULL, $9, NULL, NULL)
            RETURNING
                id, agent_id, source, template_id, shell, command, workdir, timeout_secs,
                status, exit_code, stdout, stderr, agent_task_id, created_at, started_at, finished_at
            "#,
        )
        .bind(&id)
        .bind(&params.agent_id)
        .bind(&params.source)
        .bind(&params.template_id)
        .bind(&params.shell)
        .bind(&params.command)
        .bind(&params.workdir)
        .bind(params.timeout_secs)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_task())
    }

    pub async fn list_tasks(&self) -> Result<Vec<Task>, sqlx::Error> {
        let rows = sqlx::query_as::<_, TaskRow>(
            r#"
            SELECT
                id, agent_id, source, template_id, shell, command, workdir, timeout_secs,
                status, exit_code, stdout, stderr, agent_task_id, created_at, started_at, finished_at
            FROM tasks
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_task()).collect())
    }

    pub async fn get_task(&self, id: &str) -> Result<Option<Task>, sqlx::Error> {
        let row = sqlx::query_as::<_, TaskRow>(
            r#"
            SELECT
                id, agent_id, source, template_id, shell, command, workdir, timeout_secs,
                status, exit_code, stdout, stderr, agent_task_id, created_at, started_at, finished_at
            FROM tasks
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_task()))
    }

    pub async fn update_task(
        &self,
        id: &str,
        update: TaskUpdate,
    ) -> Result<Option<Task>, sqlx::Error> {
        let current = match self.get_task(id).await? {
            Some(t) => t,
            None => return Ok(None),
        };
        let status = update.status.unwrap_or(current.status);
        let exit_code = match update.exit_code {
            Some(v) => v,
            None => current.exit_code,
        };
        let stdout = update.stdout.unwrap_or(current.stdout);
        let stderr = update.stderr.unwrap_or(current.stderr);
        let agent_task_id = match update.agent_task_id {
            Some(v) => v,
            None => current.agent_task_id,
        };
        let started_at = match update.started_at {
            Some(v) => v,
            None => current.started_at,
        };
        let finished_at = match update.finished_at {
            Some(v) => v,
            None => current.finished_at,
        };
        sqlx::query(
            r#"
            UPDATE tasks
            SET status = $1, exit_code = $2, stdout = $3, stderr = $4, agent_task_id = $5,
                started_at = $6, finished_at = $7
            WHERE id = $8
            "#,
        )
        .bind(&status)
        .bind(exit_code)
        .bind(&stdout)
        .bind(&stderr)
        .bind(&agent_task_id)
        .bind(&started_at)
        .bind(&finished_at)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_task(id).await
    }

    pub async fn insert_screenshot_with_id(
        &self,
        id: &str,
        agent_id: &str,
        file_path: &str,
        content_type: &str,
        byte_size: i64,
        width: Option<i32>,
        height: Option<i32>,
    ) -> Result<Screenshot, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let row = sqlx::query_as::<_, ScreenshotRow>(
            r#"
            INSERT INTO screenshots (
                id, agent_id, file_path, content_type, byte_size, width, height, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, agent_id, file_path, content_type, byte_size, width, height, created_at
            "#,
        )
        .bind(id)
        .bind(agent_id)
        .bind(file_path)
        .bind(content_type)
        .bind(byte_size)
        .bind(width)
        .bind(height)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_screenshot())
    }

    pub async fn insert_screenshot(
        &self,
        agent_id: &str,
        file_path: &str,
        content_type: &str,
        byte_size: i64,
        width: Option<i32>,
        height: Option<i32>,
    ) -> Result<Screenshot, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        self.insert_screenshot_with_id(
            &id,
            agent_id,
            file_path,
            content_type,
            byte_size,
            width,
            height,
        )
        .await
    }

    pub async fn count_screenshots(&self, agent_id: &str) -> Result<i64, sqlx::Error> {
        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM screenshots WHERE agent_id = $1")
                .bind(agent_id)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.0)
    }

    pub async fn list_screenshots(
        &self,
        agent_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Screenshot>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ScreenshotRow>(
            r#"
            SELECT id, agent_id, file_path, content_type, byte_size, width, height, created_at
            FROM screenshots
            WHERE agent_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(agent_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_screenshot()).collect())
    }

    pub async fn get_screenshot(&self, id: &str) -> Result<Option<Screenshot>, sqlx::Error> {
        let row = sqlx::query_as::<_, ScreenshotRow>(
            r#"
            SELECT id, agent_id, file_path, content_type, byte_size, width, height, created_at
            FROM screenshots
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_screenshot()))
    }

    pub async fn insert_general_template(
        &self,
        name: &str,
        origin_agent_id: &str,
        kind: &str,
        inputs: &serde_json::Value,
        outputs: &serde_json::Value,
    ) -> Result<GeneralTemplate, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let inputs_json = serde_json::to_string(inputs)
            .map_err(|e| sqlx::Error::Protocol(format!("inputs json: {e}")))?;
        let outputs_json = serde_json::to_string(outputs)
            .map_err(|e| sqlx::Error::Protocol(format!("outputs json: {e}")))?;
        let row = sqlx::query_as::<_, GeneralTemplateRow>(
            r#"
            INSERT INTO general_templates (
                name, origin_agent_id, kind, inputs_json, outputs_json, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
                id, name, origin_agent_id, kind, inputs_json, outputs_json, created_at
            "#,
        )
        .bind(name)
        .bind(origin_agent_id)
        .bind(kind)
        .bind(&inputs_json)
        .bind(&outputs_json)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_general_template())
    }

    pub async fn find_duplicate_general_template(
        &self,
        name: &str,
        inputs: &serde_json::Value,
    ) -> Result<Option<GeneralTemplate>, sqlx::Error> {
        let rows = sqlx::query_as::<_, GeneralTemplateRow>(
            r#"
            SELECT
                id, name, origin_agent_id, kind, inputs_json, outputs_json, created_at
            FROM general_templates
            WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            let existing: serde_json::Value = match serde_json::from_str(&row.inputs_json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if &existing == inputs {
                return Ok(Some(row.into_general_template()));
            }
        }
        Ok(None)
    }

    pub async fn get_general_template(
        &self,
        id: i64,
    ) -> Result<Option<GeneralTemplate>, sqlx::Error> {
        let row = sqlx::query_as::<_, GeneralTemplateRow>(
            r#"
            SELECT
                id, name, origin_agent_id, kind, inputs_json, outputs_json, created_at
            FROM general_templates
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_general_template()))
    }

    pub async fn list_general_templates_enriched(
        &self,
        agent_id: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<GeneralTemplateEnriched>, sqlx::Error> {
        let rows = sqlx::query_as::<_, GeneralTemplateEnrichedRow>(
            r#"
            SELECT
                t.id, t.name, t.origin_agent_id, t.kind, t.inputs_json, t.outputs_json,
                t.created_at, o.name AS origin_agent_name
            FROM general_templates t
            LEFT JOIN agents o ON o.id = t.origin_agent_id
            WHERE ($1::text IS NULL OR t.origin_agent_id = $1)
              AND ($2::text IS NULL OR t.kind = $2)
            ORDER BY t.created_at ASC
            "#,
        )
        .bind(agent_id)
        .bind(kind)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_enriched()).collect())
    }

    pub async fn delete_general_template(&self, id: i64) -> Result<bool, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM vi_run_queue_items WHERE general_template_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let affected = sqlx::query("DELETE FROM general_templates WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
        tx.commit().await?;
        Ok(affected)
    }

    pub async fn create_sequence_template_from_queue(
        &self,
        agent_id: &str,
        name: &str,
        note: &str,
        queue_items: &[ViRunQueueItem],
    ) -> Result<SequenceTemplate, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        let tpl: SequenceTemplateRow = sqlx::query_as(
            r#"
            INSERT INTO sequence_templates
              (name, note, created_by_agent_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING
              id, name, note, created_by_agent_id, created_at, updated_at
            "#,
        )
        .bind(name)
        .bind(note)
        .bind(agent_id)
        .bind(&now)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;

        for item in queue_items {
            sqlx::query(
                r#"
                INSERT INTO sequence_template_steps
                  (sequence_template_id, position, template_source, vi_template_id, general_template_id,
                   inputs_json, enabled, breakpoint, fail_policy, limits_json, note, title, collapsed)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                "#,
            )
            .bind(tpl.id)
            .bind(item.position)
            .bind(&item.template_source)
            .bind(item.vi_template_id)
            .bind(item.general_template_id)
            .bind(&item.inputs_json)
            .bind(item.enabled)
            .bind(false) // breakpoints removed; column kept for migration
            .bind(&item.fail_policy)
            .bind(&item.limits_json)
            .bind(&item.note)
            .bind(&item.title)
            .bind(item.collapsed)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(tpl.into_sequence_template())
    }

    pub async fn list_sequence_templates(&self) -> Result<Vec<SequenceTemplateEnriched>, sqlx::Error> {
        let rows = sqlx::query_as::<_, SequenceTemplateEnrichedRow>(
            r#"
            SELECT
              t.id, t.name, t.note, t.created_by_agent_id, t.created_at, t.updated_at,
              a.name AS created_by_agent_name,
              COUNT(s.id) AS step_count
            FROM sequence_templates t
            LEFT JOIN agents a ON a.id = t.created_by_agent_id
            LEFT JOIN sequence_template_steps s ON s.sequence_template_id = t.id
            GROUP BY t.id, a.name
            ORDER BY t.updated_at DESC, t.id DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_enriched()).collect())
    }

    pub async fn get_sequence_template(&self, id: i64) -> Result<Option<SequenceTemplate>, sqlx::Error> {
        let row = sqlx::query_as::<_, SequenceTemplateRow>(
            r#"
            SELECT
              id, name, note, created_by_agent_id, created_at, updated_at
            FROM sequence_templates
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_sequence_template()))
    }

    pub async fn get_sequence_template_steps(
        &self,
        sequence_template_id: i64,
    ) -> Result<Vec<SequenceTemplateStep>, sqlx::Error> {
        let rows = sqlx::query_as::<_, SequenceTemplateStepRow>(
            r#"
            SELECT
              id, sequence_template_id, position, template_source, vi_template_id,
              general_template_id, inputs_json, enabled, breakpoint, fail_policy,
              limits_json, note, title, collapsed
            FROM sequence_template_steps
            WHERE sequence_template_id = $1
            ORDER BY position ASC, id ASC
            "#,
        )
        .bind(sequence_template_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_step()).collect())
    }

    pub async fn delete_sequence_template(&self, id: i64) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM sequence_templates WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn load_sequence_template_to_agent(
        &self,
        sequence_template_id: i64,
        agent_id: &str,
    ) -> Result<Vec<ViRunQueueItem>, QueueReplaceError> {
        let steps = self
            .get_sequence_template_steps(sequence_template_id)
            .await
            .map_err(QueueReplaceError::Db)?;
        let items: Vec<ViRunQueueReplaceItem> = steps
            .into_iter()
            .map(|step| ViRunQueueReplaceItem {
                template_source: step.template_source,
                vi_template_id: step.vi_template_id,
                general_template_id: step.general_template_id,
                inputs_json: Some(step.inputs_json),
                enabled: step.enabled,
                breakpoint: false,
                fail_policy: step.fail_policy,
                limits_json: step.limits_json,
                note: step.note,
                title: step.title,
                collapsed: step.collapsed,
            })
            .collect();
        self.replace_vi_run_queue(agent_id, &items).await
    }

    pub async fn insert_vi_template(
        &self,
        name: &str,
        origin_agent_id: &str,
        kind: &str,
        vi_path: &str,
        cli_path: &str,
        getinfo_path: &str,
        inputs: &serde_json::Value,
        outputs: &serde_json::Value,
        show_front_panel: bool,
        timeout_secs: Option<i64>,
    ) -> Result<ViTemplate, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let inputs_json = serde_json::to_string(inputs)
            .map_err(|e| sqlx::Error::Protocol(format!("inputs json: {e}")))?;
        let outputs_json = serde_json::to_string(outputs)
            .map_err(|e| sqlx::Error::Protocol(format!("outputs json: {e}")))?;
        let row = sqlx::query_as::<_, ViTemplateRow>(
            r#"
            INSERT INTO vi_templates (
                name, origin_agent_id, kind, vi_path, cli_path, getinfo_path,
                inputs_json, outputs_json, show_front_panel, timeout_secs, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING
                id, name, origin_agent_id, kind, vi_path, cli_path, getinfo_path,
                inputs_json, outputs_json, show_front_panel, timeout_secs, created_at
            "#,
        )
        .bind(name)
        .bind(origin_agent_id)
        .bind(kind)
        .bind(vi_path)
        .bind(cli_path)
        .bind(getinfo_path)
        .bind(&inputs_json)
        .bind(&outputs_json)
        .bind(i64::from(show_front_panel))
        .bind(timeout_secs)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_vi_template())
    }

    /// True when another template already has the same display name and equivalent inputs JSON.
    /// When `exclude_id` is set, that row is ignored (for rename/patch).
    pub async fn find_duplicate_vi_template(
        &self,
        name: &str,
        inputs: &serde_json::Value,
        exclude_id: Option<i64>,
    ) -> Result<Option<ViTemplate>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ViTemplateRow>(
            r#"
            SELECT
                id, name, origin_agent_id, kind, vi_path, cli_path, getinfo_path,
                inputs_json, outputs_json, show_front_panel, timeout_secs, created_at
            FROM vi_templates
            WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            if exclude_id.is_some_and(|ex| ex == row.id) {
                continue;
            }
            let existing: serde_json::Value = match serde_json::from_str(&row.inputs_json) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if &existing == inputs {
                return Ok(Some(row.into_vi_template()));
            }
        }
        Ok(None)
    }

    pub async fn patch_vi_template(
        &self,
        id: i64,
        patch: ViTemplatePatch,
    ) -> Result<Option<ViTemplate>, sqlx::Error> {
        let current = match self.get_vi_template(id).await? {
            Some(t) => t,
            None => return Ok(None),
        };
        let name = patch.name.unwrap_or(current.name);
        let inputs_json = match patch.inputs {
            Some(inputs) => serde_json::to_string(&inputs)
                .map_err(|e| sqlx::Error::Protocol(format!("inputs json: {e}")))?,
            None => current.inputs_json,
        };
        let show_front_panel = patch.show_front_panel.unwrap_or(current.show_front_panel);
        let timeout_secs = match patch.timeout_secs {
            Some(v) => v,
            None => current.timeout_secs,
        };
        sqlx::query(
            r#"
            UPDATE vi_templates
            SET name = $1, inputs_json = $2, show_front_panel = $3, timeout_secs = $4
            WHERE id = $5
            "#,
        )
        .bind(&name)
        .bind(&inputs_json)
        .bind(i64::from(show_front_panel))
        .bind(timeout_secs)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_vi_template(id).await
    }

    /// INSERT a copy; source row is unchanged. Origin stays with the source template.
    pub async fn copy_vi_template(
        &self,
        source_id: i64,
        target_agent_id: &str,
        cli_path: &str,
        getinfo_path: &str,
        vi_path: Option<&str>,
    ) -> Result<ViTemplate, TransferError> {
        let source = self
            .get_vi_template(source_id)
            .await
            .map_err(TransferError::Db)?
            .ok_or(TransferError::NotFound)?;

        if self
            .get_agent(target_agent_id)
            .await
            .map_err(TransferError::Db)?
            .is_none()
        {
            return Err(TransferError::AgentNotFound);
        }

        let vi_path = vi_path.unwrap_or(&source.vi_path);
        let inputs: serde_json::Value = serde_json::from_str(&source.inputs_json)
            .map_err(|e| TransferError::Db(sqlx::Error::Protocol(format!("inputs json: {e}"))))?;
        let outputs: serde_json::Value = serde_json::from_str(&source.outputs_json)
            .map_err(|e| TransferError::Db(sqlx::Error::Protocol(format!("outputs json: {e}"))))?;

        self.insert_vi_template(
            &source.name,
            &source.origin_agent_id,
            &source.kind,
            vi_path,
            cli_path,
            getinfo_path,
            &inputs,
            &outputs,
            source.show_front_panel,
            source.timeout_secs,
        )
        .await
        .map_err(TransferError::Db)
    }

    pub async fn transfer_vi_template(
        &self,
        id: i64,
        target_agent_id: &str,
        cli_path: &str,
        getinfo_path: &str,
        vi_path: Option<&str>,
    ) -> Result<ViTemplate, TransferError> {
        let source = self
            .get_vi_template(id)
            .await
            .map_err(TransferError::Db)?
            .ok_or(TransferError::NotFound)?;

        if self
            .get_agent(target_agent_id)
            .await
            .map_err(TransferError::Db)?
            .is_none()
        {
            return Err(TransferError::AgentNotFound);
        }

        let vi_path = vi_path.unwrap_or(&source.vi_path);

        let mut tx = self.pool.begin().await.map_err(TransferError::Db)?;

        sqlx::query(
            r#"
            UPDATE vi_templates
            SET vi_path = $1, cli_path = $2, getinfo_path = $3
            WHERE id = $4
            "#,
        )
        .bind(vi_path)
        .bind(cli_path)
        .bind(getinfo_path)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(TransferError::Db)?;

        sqlx::query("DELETE FROM vi_run_queue_items WHERE vi_template_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(TransferError::Db)?;

        tx.commit().await.map_err(TransferError::Db)?;

        self.get_vi_template(id)
            .await
            .map_err(TransferError::Db)?
            .ok_or(TransferError::NotFound)
    }

    pub async fn create_vi_template(
        &self,
        name: &str,
        origin_agent_id: &str,
        kind: &str,
        vi_path: &str,
        cli_path: &str,
        getinfo_path: &str,
        inputs: &serde_json::Value,
        show_front_panel: bool,
        timeout_secs: Option<i64>,
    ) -> Result<ViTemplate, sqlx::Error> {
        let outputs = serde_json::json!([]);
        self.insert_vi_template(
            name,
            origin_agent_id,
            kind,
            vi_path,
            cli_path,
            getinfo_path,
            inputs,
            &outputs,
            show_front_panel,
            timeout_secs,
        )
        .await
    }

    pub async fn list_vi_templates(
        &self,
        agent_id: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<ViTemplate>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ViTemplateRow>(
            r#"
            SELECT
                id, name, origin_agent_id, kind, vi_path, cli_path, getinfo_path,
                inputs_json, outputs_json, show_front_panel, timeout_secs, created_at
            FROM vi_templates
            WHERE ($1::text IS NULL OR origin_agent_id = $1)
              AND ($2::text IS NULL OR kind = $2)
            ORDER BY created_at ASC
            "#,
        )
        .bind(agent_id)
        .bind(kind)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_vi_template()).collect())
    }

    pub async fn list_vi_templates_enriched(
        &self,
        agent_id: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<ViTemplateEnriched>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ViTemplateEnrichedRow>(
            r#"
            SELECT
                t.id, t.name, t.origin_agent_id, t.kind, t.vi_path, t.cli_path,
                t.getinfo_path, t.inputs_json, t.outputs_json, t.show_front_panel, t.timeout_secs,
                t.created_at, o.name AS origin_agent_name
            FROM vi_templates t
            LEFT JOIN agents o ON o.id = t.origin_agent_id
            WHERE ($1::text IS NULL OR t.origin_agent_id = $1)
              AND ($2::text IS NULL OR t.kind = $2)
            ORDER BY t.created_at ASC
            "#,
        )
        .bind(agent_id)
        .bind(kind)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_enriched()).collect())
    }

    pub async fn get_vi_template_enriched(
        &self,
        id: i64,
    ) -> Result<Option<ViTemplateEnriched>, sqlx::Error> {
        let row = sqlx::query_as::<_, ViTemplateEnrichedRow>(
            r#"
            SELECT
                t.id, t.name, t.origin_agent_id, t.kind, t.vi_path, t.cli_path,
                t.getinfo_path, t.inputs_json, t.outputs_json, t.show_front_panel, t.timeout_secs,
                t.created_at, o.name AS origin_agent_name
            FROM vi_templates t
            LEFT JOIN agents o ON o.id = t.origin_agent_id
            WHERE t.id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_enriched()))
    }

    pub async fn get_vi_template(&self, id: i64) -> Result<Option<ViTemplate>, sqlx::Error> {
        let row = sqlx::query_as::<_, ViTemplateRow>(
            r#"
            SELECT
                id, name, origin_agent_id, kind, vi_path, cli_path, getinfo_path,
                inputs_json, outputs_json, show_front_panel, timeout_secs, created_at
            FROM vi_templates
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_vi_template()))
    }

    pub async fn list_vi_run_queue(&self, agent_id: &str) -> Result<Vec<ViRunQueueItem>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ViRunQueueItemRow>(
            r#"
            SELECT q.id, q.agent_id,
                   q.template_source,
                   q.vi_template_id, q.general_template_id, q.position, q.created_at,
                   CASE
                     WHEN q.template_source = 'group' THEN COALESCE(NULLIF(q.title, ''), '分组')
                     ELSE COALESCE(v.name, g.name, '')
                   END AS template_name,
                   CASE
                     WHEN q.template_source = 'group' THEN 'group'
                     ELSE COALESCE(v.kind, g.kind, 'labview')
                   END AS kind,
                   COALESCE(v.vi_path, '') AS vi_path,
                   COALESCE(q.inputs_json, v.inputs_json, g.inputs_json, '[]') AS inputs_json,
                   COALESCE(v.outputs_json, g.outputs_json, '[]') AS outputs_json,
                   COALESCE(v.show_front_panel, 0) AS show_front_panel,
                   v.timeout_secs AS timeout_secs,
                   q.enabled, q.breakpoint, q.fail_policy, q.limits_json, q.note,
                   q.title, q.collapsed
            FROM vi_run_queue_items q
            LEFT JOIN vi_templates v ON v.id = q.vi_template_id
            LEFT JOIN general_templates g ON g.id = q.general_template_id
            WHERE q.agent_id = $1
            ORDER BY q.position ASC
            "#,
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into_item()).collect())
    }

    pub async fn replace_vi_run_queue(
        &self,
        agent_id: &str,
        items: &[ViRunQueueReplaceItem],
    ) -> Result<Vec<ViRunQueueItem>, QueueReplaceError> {
        if self.get_agent(agent_id).await.map_err(QueueReplaceError::Db)?.is_none() {
            return Err(QueueReplaceError::AgentNotFound);
        }

        let mut normalized_items = Vec::with_capacity(items.len());
        for item in items {
            let source = item.template_source.as_str();
            match source {
                "group" => {
                    let title = item.title.trim();
                    let title = if title.is_empty() {
                        "分组".to_string()
                    } else {
                        title.to_string()
                    };
                    normalized_items.push(ViRunQueueReplaceItem {
                        template_source: "group".into(),
                        vi_template_id: None,
                        general_template_id: None,
                        inputs_json: Some("[]".into()),
                        enabled: item.enabled,
                        breakpoint: false,
                        fail_policy: "stop".into(),
                        limits_json: "[]".into(),
                        note: item.note.clone(),
                        title,
                        collapsed: item.collapsed,
                    });
                }
                "general" => {
                    let Some(template_id) = item.general_template_id else {
                        return Err(QueueReplaceError::BadTemplate {
                            template_source: "general".into(),
                            template_id: 0,
                        });
                    };
                    let got = self
                        .get_general_template(template_id)
                        .await
                        .map_err(QueueReplaceError::Db)?;
                    let Some(template) = got else {
                        return Err(QueueReplaceError::BadTemplate {
                            template_source: "general".into(),
                            template_id,
                        });
                    };
                    normalized_items.push(ViRunQueueReplaceItem {
                        template_source: "general".into(),
                        inputs_json: Some(
                            item.inputs_json
                                .clone()
                                .unwrap_or_else(|| template.inputs_json.clone()),
                        ),
                        title: String::new(),
                        collapsed: false,
                        ..item.clone()
                    });
                }
                _ => {
                    let Some(template_id) = item.vi_template_id else {
                        return Err(QueueReplaceError::BadTemplate {
                            template_source: "labview".into(),
                            template_id: 0,
                        });
                    };
                    let template = self
                        .get_vi_template(template_id)
                        .await
                        .map_err(QueueReplaceError::Db)?;
                    let Some(template) = template else {
                        return Err(QueueReplaceError::BadTemplate {
                            template_source: "labview".into(),
                            template_id,
                        });
                    };
                    normalized_items.push(ViRunQueueReplaceItem {
                        template_source: "labview".into(),
                        inputs_json: Some(
                            item.inputs_json
                                .clone()
                                .unwrap_or_else(|| template.inputs_json.clone()),
                        ),
                        title: String::new(),
                        collapsed: false,
                        ..item.clone()
                    });
                }
            }
        }

        let mut tx = self.pool.begin().await.map_err(QueueReplaceError::Db)?;

        sqlx::query("DELETE FROM vi_run_queue_items WHERE agent_id = $1")
            .bind(agent_id)
            .execute(&mut *tx)
            .await
            .map_err(QueueReplaceError::Db)?;

        let now = Utc::now().to_rfc3339();
        for (position, item) in normalized_items.iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            let fail_policy = normalize_fail_policy(&item.fail_policy);
            sqlx::query(
                r#"
                INSERT INTO vi_run_queue_items
                  (id, agent_id, vi_template_id, general_template_id, inputs_json, position, created_at,
                   enabled, breakpoint, fail_policy, limits_json, note, title, collapsed, template_source)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                "#,
            )
            .bind(&id)
            .bind(agent_id)
            .bind(item.vi_template_id)
            .bind(item.general_template_id)
            .bind(item.inputs_json.as_deref().unwrap_or("[]"))
            .bind(position as i64)
            .bind(&now)
            .bind(item.enabled)
            .bind(false) // breakpoints removed; column kept for migration
            .bind(fail_policy)
            .bind(&item.limits_json)
            .bind(&item.note)
            .bind(&item.title)
            .bind(item.collapsed)
            .bind(&item.template_source)
            .execute(&mut *tx)
            .await
            .map_err(QueueReplaceError::Db)?;
        }

        tx.commit().await.map_err(QueueReplaceError::Db)?;

        self.list_vi_run_queue(agent_id)
            .await
            .map_err(QueueReplaceError::Db)
    }

    pub async fn delete_vi_template(&self, id: i64) -> Result<bool, sqlx::Error> {
        sqlx::query("DELETE FROM vi_run_queue_items WHERE vi_template_id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        let result = sqlx::query("DELETE FROM vi_templates WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }
}

#[derive(sqlx::FromRow)]
struct AgentRow {
    id: String,
    name: String,
    ip: String,
    port: i64,
    status: String,
    cpu_percent: f32,
    memory_percent: f32,
    busy: i64,
    last_seen_at: Option<String>,
    created_at: String,
}

impl AgentRow {
    fn into_agent(self) -> Agent {
        Agent {
            id: self.id,
            name: self.name,
            ip: self.ip,
            port: self.port as u16,
            status: self.status,
            cpu_percent: self.cpu_percent,
            memory_percent: self.memory_percent,
            busy: self.busy != 0,
            last_seen_at: self.last_seen_at,
            created_at: self.created_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct TemplateRow {
    id: String,
    name: String,
    shell: String,
    command: String,
    workdir: Option<String>,
    timeout_secs: i64,
    created_at: String,
}

impl TemplateRow {
    fn into_template(self) -> TaskTemplate {
        TaskTemplate {
            id: self.id,
            name: self.name,
            shell: self.shell,
            command: self.command,
            workdir: self.workdir,
            timeout_secs: self.timeout_secs,
            created_at: self.created_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct TaskRow {
    id: String,
    agent_id: String,
    source: String,
    template_id: Option<String>,
    shell: String,
    command: String,
    workdir: Option<String>,
    timeout_secs: i64,
    status: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    agent_task_id: Option<String>,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
}

impl TaskRow {
    fn into_task(self) -> Task {
        Task {
            id: self.id,
            agent_id: self.agent_id,
            source: self.source,
            template_id: self.template_id,
            shell: self.shell,
            command: self.command,
            workdir: self.workdir,
            timeout_secs: self.timeout_secs,
            status: self.status,
            exit_code: self.exit_code,
            stdout: self.stdout,
            stderr: self.stderr,
            agent_task_id: self.agent_task_id,
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct ScreenshotRow {
    id: String,
    agent_id: String,
    file_path: String,
    content_type: String,
    byte_size: i64,
    width: Option<i32>,
    height: Option<i32>,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct ViTemplateRow {
    id: i64,
    name: String,
    origin_agent_id: String,
    kind: String,
    vi_path: String,
    cli_path: String,
    getinfo_path: String,
    inputs_json: String,
    outputs_json: String,
    show_front_panel: i64,
    timeout_secs: Option<i64>,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct GeneralTemplateRow {
    id: i64,
    name: String,
    origin_agent_id: String,
    kind: String,
    inputs_json: String,
    outputs_json: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct ViRunQueueItemRow {
    id: String,
    agent_id: String,
    template_source: String,
    vi_template_id: Option<i64>,
    general_template_id: Option<i64>,
    position: i64,
    created_at: String,
    template_name: String,
    kind: String,
    vi_path: String,
    inputs_json: String,
    outputs_json: String,
    show_front_panel: i64,
    timeout_secs: Option<i64>,
    enabled: bool,
    breakpoint: bool,
    fail_policy: String,
    limits_json: String,
    note: String,
    title: String,
    collapsed: bool,
}

impl ViRunQueueItemRow {
    fn into_item(self) -> ViRunQueueItem {
        ViRunQueueItem {
            id: self.id,
            agent_id: self.agent_id,
            template_source: self.template_source,
            vi_template_id: self.vi_template_id,
            general_template_id: self.general_template_id,
            position: self.position,
            created_at: self.created_at,
            template_name: self.template_name,
            kind: self.kind,
            vi_path: self.vi_path,
            inputs_json: self.inputs_json,
            outputs_json: self.outputs_json,
            show_front_panel: self.show_front_panel != 0,
            timeout_secs: self.timeout_secs,
            enabled: self.enabled,
            breakpoint: self.breakpoint,
            fail_policy: self.fail_policy,
            limits_json: self.limits_json,
            note: self.note,
            title: self.title,
            collapsed: self.collapsed,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SequenceTemplateRow {
    id: i64,
    name: String,
    note: String,
    created_by_agent_id: String,
    created_at: String,
    updated_at: String,
}

impl SequenceTemplateRow {
    fn into_sequence_template(self) -> SequenceTemplate {
        SequenceTemplate {
            id: self.id,
            name: self.name,
            note: self.note,
            created_by_agent_id: self.created_by_agent_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SequenceTemplateStepRow {
    id: i64,
    sequence_template_id: i64,
    position: i64,
    template_source: String,
    vi_template_id: Option<i64>,
    general_template_id: Option<i64>,
    inputs_json: String,
    enabled: bool,
    breakpoint: bool,
    fail_policy: String,
    limits_json: String,
    note: String,
    title: String,
    collapsed: bool,
}

impl SequenceTemplateStepRow {
    fn into_step(self) -> SequenceTemplateStep {
        SequenceTemplateStep {
            id: self.id,
            sequence_template_id: self.sequence_template_id,
            position: self.position,
            template_source: self.template_source,
            vi_template_id: self.vi_template_id,
            general_template_id: self.general_template_id,
            inputs_json: self.inputs_json,
            enabled: self.enabled,
            breakpoint: self.breakpoint,
            fail_policy: self.fail_policy,
            limits_json: self.limits_json,
            note: self.note,
            title: self.title,
            collapsed: self.collapsed,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SequenceTemplateEnrichedRow {
    id: i64,
    name: String,
    note: String,
    created_by_agent_id: String,
    created_at: String,
    updated_at: String,
    created_by_agent_name: Option<String>,
    step_count: i64,
}

impl SequenceTemplateEnrichedRow {
    fn into_enriched(self) -> SequenceTemplateEnriched {
        SequenceTemplateEnriched {
            template: SequenceTemplate {
                id: self.id,
                name: self.name,
                note: self.note,
                created_by_agent_id: self.created_by_agent_id,
                created_at: self.created_at,
                updated_at: self.updated_at,
            },
            created_by_agent_name: self.created_by_agent_name,
            step_count: self.step_count,
        }
    }
}

#[derive(sqlx::FromRow)]
struct ViTemplateEnrichedRow {
    id: i64,
    name: String,
    origin_agent_id: String,
    kind: String,
    vi_path: String,
    cli_path: String,
    getinfo_path: String,
    inputs_json: String,
    outputs_json: String,
    show_front_panel: i64,
    timeout_secs: Option<i64>,
    created_at: String,
    origin_agent_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct GeneralTemplateEnrichedRow {
    id: i64,
    name: String,
    origin_agent_id: String,
    kind: String,
    inputs_json: String,
    outputs_json: String,
    created_at: String,
    origin_agent_name: Option<String>,
}

impl ViTemplateRow {
    fn into_vi_template(self) -> ViTemplate {
        ViTemplate {
            id: self.id,
            name: self.name,
            origin_agent_id: self.origin_agent_id,
            kind: self.kind,
            vi_path: self.vi_path,
            cli_path: self.cli_path,
            getinfo_path: self.getinfo_path,
            inputs_json: self.inputs_json,
            outputs_json: self.outputs_json,
            show_front_panel: self.show_front_panel != 0,
            timeout_secs: self.timeout_secs,
            created_at: self.created_at,
        }
    }
}

impl GeneralTemplateRow {
    fn into_general_template(self) -> GeneralTemplate {
        GeneralTemplate {
            id: self.id,
            name: self.name,
            origin_agent_id: self.origin_agent_id,
            kind: self.kind,
            inputs_json: self.inputs_json,
            outputs_json: self.outputs_json,
            created_at: self.created_at,
        }
    }
}

impl ViTemplateEnrichedRow {
    fn into_enriched(self) -> ViTemplateEnriched {
        ViTemplateEnriched {
            template: ViTemplate {
                id: self.id,
                name: self.name,
                origin_agent_id: self.origin_agent_id,
                kind: self.kind,
                vi_path: self.vi_path,
                cli_path: self.cli_path,
                getinfo_path: self.getinfo_path,
                inputs_json: self.inputs_json,
                outputs_json: self.outputs_json,
                show_front_panel: self.show_front_panel != 0,
                timeout_secs: self.timeout_secs,
                created_at: self.created_at,
            },
            origin_agent_name: self.origin_agent_name,
        }
    }
}

impl GeneralTemplateEnrichedRow {
    fn into_enriched(self) -> GeneralTemplateEnriched {
        GeneralTemplateEnriched {
            template: GeneralTemplate {
                id: self.id,
                name: self.name,
                origin_agent_id: self.origin_agent_id,
                kind: self.kind,
                inputs_json: self.inputs_json,
                outputs_json: self.outputs_json,
                created_at: self.created_at,
            },
            origin_agent_name: self.origin_agent_name,
        }
    }
}

impl ScreenshotRow {
    fn into_screenshot(self) -> Screenshot {
        Screenshot {
            id: self.id,
            agent_id: self.agent_id,
            file_path: self.file_path,
            content_type: self.content_type,
            byte_size: self.byte_size,
            width: self.width,
            height: self.height,
            created_at: self.created_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> crate::db::GuardedStore {
        crate::db::GuardedStore::new().await
    }

    #[tokio::test]
    async fn upsert_agent_is_idempotent() {
        let store = test_store().await;
        let a = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let b = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        assert_eq!(a.id, b.id);
    }

    #[tokio::test]
    async fn create_task_starts_as_queued() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let task = store
            .create_task(CreateTaskParams {
                agent_id: agent.id,
                source: "ad_hoc".into(),
                template_id: None,
                shell: "cmd".into(),
                command: "echo hi".into(),
                workdir: None,
                timeout_secs: 300,
            })
            .await
            .unwrap();
        assert_eq!(task.status, "queued");
    }

    #[tokio::test]
    async fn update_task_can_set_succeeded() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let task = store
            .create_task(CreateTaskParams {
                agent_id: agent.id,
                source: "ad_hoc".into(),
                template_id: None,
                shell: "cmd".into(),
                command: "echo hi".into(),
                workdir: None,
                timeout_secs: 300,
            })
            .await
            .unwrap();
        let finished_at = Utc::now().to_rfc3339();
        store
            .update_task(
                &task.id,
                TaskUpdate {
                    status: Some("succeeded".into()),
                    exit_code: Some(Some(0)),
                    stdout: Some("hi".into()),
                    finished_at: Some(Some(finished_at.clone())),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let got = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(got.status, "succeeded");
        assert_eq!(got.exit_code, Some(0));
        assert_eq!(got.stdout, "hi");
        assert_eq!(got.finished_at, Some(finished_at));
    }

    #[tokio::test]
    async fn insert_and_list_screenshots() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let meta = store
            .insert_screenshot(
                &agent.id,
                "data/screenshots/x/y.png",
                "image/png",
                12,
                Some(1),
                Some(1),
            )
            .await
            .unwrap();
        let total = store.count_screenshots(&agent.id).await.unwrap();
        assert_eq!(total, 1);
        let page = store.list_screenshots(&agent.id, 50, 0).await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, meta.id);
        assert!(store.get_screenshot(&meta.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn vi_template_crud_round_trips_fields() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([{"name":"a","className":"Digital","value":3.0}]);
        let tpl = store
            .create_vi_template(
                "Add",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\labview-runner-cli\labview-runner-cli.exe",
                r"C:\labview-runner-cli\getinfo.vi",
                &inputs,
                true,
                Some(30),
            )
            .await
            .unwrap();
        assert_eq!(tpl.name, "Add");
        assert_eq!(tpl.origin_agent_id, agent.id);
        assert_eq!(tpl.vi_path, r"C:\x\Add.vi");
        assert_eq!(tpl.cli_path, r"C:\labview-runner-cli\labview-runner-cli.exe");
        assert_eq!(tpl.getinfo_path, r"C:\labview-runner-cli\getinfo.vi");
        assert_eq!(tpl.inputs_json, inputs.to_string());
        assert!(tpl.show_front_panel);
        assert_eq!(tpl.timeout_secs, Some(30));
        assert!(!tpl.created_at.is_empty());

        assert_eq!(tpl.origin_agent_id, agent.id);

        let listed = store.list_vi_templates(None, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, tpl.id);

        let got = store.get_vi_template(tpl.id).await.unwrap().unwrap();
        assert_eq!(got.id, tpl.id);
        assert!(got.show_front_panel);

        assert!(store.delete_vi_template(tpl.id).await.unwrap());
        assert!(store.get_vi_template(tpl.id).await.unwrap().is_none());
        assert!(!store.delete_vi_template(tpl.id).await.unwrap());
    }

    #[tokio::test]
    async fn vi_template_show_front_panel_defaults_false() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let tpl = store
            .create_vi_template(
                "NoPanel",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();
        assert!(!tpl.show_front_panel);
        assert_eq!(tpl.timeout_secs, None);
    }

    #[tokio::test]
    async fn vi_template_origin_defaults_to_agent_on_create() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let got = store
            .insert_vi_template(
                "Add",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                &serde_json::json!([]),
                false,
                None,
            )
            .await
            .unwrap();
        assert_eq!(got.origin_agent_id, agent.id);
    }

    #[tokio::test]
    async fn insert_allows_same_path_twice() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let first = store
            .insert_vi_template(
                "First",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                &serde_json::json!([]),
                false,
                None,
            )
            .await
            .unwrap();
        let second = store
            .insert_vi_template(
                "Second",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli2.exe",
                r"C:\getinfo2.vi",
                &inputs,
                &serde_json::json!([]),
                true,
                Some(10),
            )
            .await
            .unwrap();

        assert_ne!(first.id, second.id);
        let listed = store.list_vi_templates(Some(&agent.id), None).await.unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[tokio::test]
    async fn patch_renames_template() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let tpl = store
            .create_vi_template(
                "OldName",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();

        let patched = store
            .patch_vi_template(
                tpl.id,
                ViTemplatePatch {
                    name: Some("NewName".into()),
                    ..ViTemplatePatch::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(patched.name, "NewName");

        let got = store.get_vi_template(tpl.id).await.unwrap().unwrap();
        assert_eq!(got.name, "NewName");
    }

    #[tokio::test]
    async fn copy_vi_template_keeps_source() {
        let store = test_store().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store.upsert_agent("b", "1.2.3.5", 26632).await.unwrap();
        let inputs = serde_json::json!([]);
        let source = store
            .create_vi_template(
                "CopyMe",
                &agent_a.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();

        let copied = store
            .copy_vi_template(
                source.id,
                &agent_b.id,
                r"C:\cli-b.exe",
                r"C:\getinfo-b.vi",
                None,
            )
            .await
            .unwrap();

        assert_ne!(copied.id, source.id);
        assert_eq!(copied.origin_agent_id, agent_a.id);
        assert_eq!(copied.vi_path, source.vi_path);

        // Filter is by origin: both source and copy belong to agent_a.
        let on_a = store.list_vi_templates(Some(&agent_a.id), None).await.unwrap();
        assert_eq!(on_a.len(), 2);

        let on_b = store.list_vi_templates(Some(&agent_b.id), None).await.unwrap();
        assert!(on_b.is_empty());
    }

    #[tokio::test]
    async fn transfer_updates_paths_and_clears_queue() {
        let store = test_store().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store.upsert_agent("b", "1.2.3.5", 26632).await.unwrap();
        let inputs = serde_json::json!([]);
        let tpl = store
            .create_vi_template(
                "MoveMe",
                &agent_a.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();
        let template_id = tpl.id;

        store
            .replace_vi_run_queue(&agent_a.id, &default_queue_items(&[template_id]))
            .await
            .unwrap();
        assert_eq!(store.list_vi_run_queue(&agent_a.id).await.unwrap().len(), 1);

        let transferred = store
            .transfer_vi_template(
                template_id,
                &agent_b.id,
                r"C:\cli-b.exe",
                r"C:\getinfo-b.vi",
                None,
            )
            .await
            .unwrap();

        assert_eq!(transferred.id, template_id);
        assert_eq!(transferred.origin_agent_id, agent_a.id);
        assert_eq!(transferred.cli_path, r"C:\cli-b.exe");
        assert_eq!(transferred.getinfo_path, r"C:\getinfo-b.vi");

        // Origin unchanged; filter by agent_a still finds the row.
        let on_a = store.list_vi_templates(Some(&agent_a.id), None).await.unwrap();
        assert_eq!(on_a.len(), 1);
        assert_eq!(on_a[0].id, template_id);
        assert!(store.list_vi_run_queue(&agent_a.id).await.unwrap().is_empty());

        let on_b = store.list_vi_templates(Some(&agent_b.id), None).await.unwrap();
        assert!(on_b.is_empty());
    }

    #[tokio::test]
    async fn transfer_to_self_updates_paths() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let inputs = serde_json::json!([]);
        let tpl = store
            .create_vi_template(
                "Stay",
                &agent.id,
                "labview",
                r"C:\x\Add.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap();

        let updated = store
            .transfer_vi_template(
                tpl.id,
                &agent.id,
                r"C:\cli-new.exe",
                r"C:\getinfo-new.vi",
                None,
            )
            .await
            .unwrap();
        assert_eq!(updated.origin_agent_id, agent.id);
        assert_eq!(updated.cli_path, r"C:\cli-new.exe");
        assert_eq!(updated.getinfo_path, r"C:\getinfo-new.vi");
    }

    #[tokio::test]
    async fn vi_template_list_filters_by_agent() {
        let store = test_store().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store.upsert_agent("b", "1.2.3.5", 26632).await.unwrap();
        let inputs = serde_json::json!([]);
        store
            .insert_vi_template(
                "A",
                &agent_a.id,
                "labview",
                r"C:\a.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                &serde_json::json!([]),
                false,
                None,
            )
            .await
            .unwrap();
        store
            .insert_vi_template(
                "B",
                &agent_b.id,
                "labview",
                r"C:\b.vi",
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                &serde_json::json!([]),
                false,
                None,
            )
            .await
            .unwrap();

        let for_a = store.list_vi_templates(Some(&agent_a.id), None).await.unwrap();
        assert_eq!(for_a.len(), 1);
        assert_eq!(for_a[0].name, "A");

        let for_b = store.list_vi_templates(Some(&agent_b.id), None).await.unwrap();
        assert_eq!(for_b.len(), 1);
        assert_eq!(for_b[0].name, "B");

        let all = store.list_vi_templates(None, None).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn insert_screenshot_with_id_uses_given_id() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let id = Uuid::new_v4().to_string();
        let meta = store
            .insert_screenshot_with_id(
                &id,
                &agent.id,
                "data/screenshots/x/y.png",
                "image/png",
                12,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(meta.id, id);
    }

    async fn vi_template_for_agent(store: &Store, agent_id: &str, name: &str, vi_path: &str) -> ViTemplate {
        let inputs = serde_json::json!([]);
        store
            .create_vi_template(
                name,
                agent_id,
                "labview",
                vi_path,
                r"C:\cli.exe",
                r"C:\getinfo.vi",
                &inputs,
                false,
                None,
            )
            .await
            .unwrap()
    }

    fn default_queue_items(template_ids: &[i64]) -> Vec<ViRunQueueReplaceItem> {
        template_ids
            .iter()
            .map(|&vi_template_id| ViRunQueueReplaceItem {
                template_source: "labview".into(),
                vi_template_id: Some(vi_template_id),
                general_template_id: None,
                inputs_json: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits_json: "[]".into(),
                note: "".into(),
                title: "".into(),
                collapsed: false,
            })
            .collect()
    }

    #[tokio::test]
    async fn vi_run_queue_replace_and_list_order() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let tpl_a = vi_template_for_agent(&store, &agent.id, "A", r"C:\a.vi").await;
        let tpl_b = vi_template_for_agent(&store, &agent.id, "B", r"C:\b.vi").await;

        let replaced = store
            .replace_vi_run_queue(
                &agent.id,
                &default_queue_items(&[tpl_b.id, tpl_a.id, tpl_b.id]),
            )
            .await
            .unwrap();
        assert_eq!(replaced.len(), 3);
        assert_eq!(replaced[0].position, 0);
        assert_eq!(replaced[0].vi_template_id, Some(tpl_b.id));
        assert_eq!(replaced[0].template_name, "B");
        assert_eq!(replaced[1].position, 1);
        assert_eq!(replaced[1].vi_template_id, Some(tpl_a.id));
        assert_eq!(replaced[1].template_name, "A");
        assert_eq!(replaced[2].position, 2);
        assert_eq!(replaced[2].vi_template_id, Some(tpl_b.id));

        let listed = store.list_vi_run_queue(&agent.id).await.unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].position, 0);
        assert_eq!(listed[0].vi_template_id, Some(tpl_b.id));
        assert_eq!(listed[1].position, 1);
        assert_eq!(listed[1].vi_template_id, Some(tpl_a.id));
        assert_eq!(listed[2].position, 2);
        assert_eq!(listed[2].vi_template_id, Some(tpl_b.id));
    }

    #[tokio::test]
    async fn vi_run_queue_allows_foreign_template() {
        let store = test_store().await;
        let agent_a = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();
        let agent_b = store.upsert_agent("b", "1.2.3.5", 26632).await.unwrap();
        let tpl_b = vi_template_for_agent(&store, &agent_b.id, "B", r"C:\b.vi").await;

        let replaced = store
            .replace_vi_run_queue(&agent_a.id, &default_queue_items(&[tpl_b.id]))
            .await
            .unwrap();
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].vi_template_id, Some(tpl_b.id));

        let listed = store.list_vi_run_queue(&agent_a.id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].vi_template_id, Some(tpl_b.id));
    }

    #[tokio::test]
    async fn vi_run_queue_rejects_unknown_template() {
        let store = test_store().await;
        let agent = store.upsert_agent("a", "1.2.3.4", 26631).await.unwrap();

        let err = store
            .replace_vi_run_queue(&agent.id, &default_queue_items(&[999_999_999]))
            .await
            .unwrap_err();
        assert!(matches!(err, QueueReplaceError::BadTemplate { .. }));
        assert!(store.list_vi_run_queue(&agent.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_vi_template_cascades_queue_rows() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let tpl = vi_template_for_agent(&store, &agent.id, "T", r"C:\t.vi").await;

        store
            .replace_vi_run_queue(&agent.id, &default_queue_items(&[tpl.id]))
            .await
            .unwrap();
        assert_eq!(store.list_vi_run_queue(&agent.id).await.unwrap().len(), 1);

        assert!(store.delete_vi_template(tpl.id).await.unwrap());
        assert!(store.get_vi_template(tpl.id).await.unwrap().is_none());
        assert!(store.list_vi_run_queue(&agent.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn vi_run_queue_persists_step_meta() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let tpl = vi_template_for_agent(&store, &agent.id, "A", r"C:\a.vi").await;

        let items = vec![ViRunQueueReplaceItem {
            template_source: "labview".into(),
            vi_template_id: Some(tpl.id),
            general_template_id: None,
            inputs_json: Some(r#"[{"name":"Channel","className":"I32","value":2}]"#.into()),
            enabled: false,
            breakpoint: true, // accepted but ignored / forced false
            fail_policy: "continue".into(),
            limits_json: r#"[{"output":"Power_dBm","min":-5.0,"max":3.0,"unit":"dBm"}]"#.into(),
            note: "ch1".into(),
            title: "".into(),
            collapsed: false,
        }];
        let listed = store.replace_vi_run_queue(&agent.id, &items).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert!(!listed[0].breakpoint);
        assert_eq!(listed[0].fail_policy, "continue");
        assert!(listed[0].inputs_json.contains("\"Channel\""));
        assert!(listed[0].limits_json.contains("Power_dBm"));
        assert_eq!(listed[0].note, "ch1");
    }

    #[tokio::test]
    async fn vi_run_queue_accepts_group_headers() {
        let store = test_store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
        let tpl = vi_template_for_agent(&store, &agent.id, "A", r"C:\a.vi").await;

        let items = vec![
            ViRunQueueReplaceItem {
                template_source: "group".into(),
                vi_template_id: None,
                general_template_id: None,
                inputs_json: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits_json: "[]".into(),
                note: "".into(),
                title: "预处理".into(),
                collapsed: true,
            },
            ViRunQueueReplaceItem {
                template_source: "labview".into(),
                vi_template_id: Some(tpl.id),
                general_template_id: None,
                inputs_json: None,
                enabled: true,
                breakpoint: false,
                fail_policy: "stop".into(),
                limits_json: "[]".into(),
                note: "".into(),
                title: "".into(),
                collapsed: false,
            },
        ];
        let listed = store.replace_vi_run_queue(&agent.id, &items).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].template_source, "group");
        assert_eq!(listed[0].template_name, "预处理");
        assert!(listed[0].collapsed);
        assert!(listed[0].vi_template_id.is_none());
        assert_eq!(listed[1].template_source, "labview");
        assert_eq!(listed[1].vi_template_id, Some(tpl.id));

        let tpl_seq = store
            .create_sequence_template_from_queue(&agent.id, "seq1", "", &listed)
            .await
            .unwrap();
        let steps = store
            .get_sequence_template_steps(tpl_seq.id)
            .await
            .unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].template_source, "group");
        assert_eq!(steps[0].title, "预处理");
        assert!(steps[0].collapsed);

        store
            .replace_vi_run_queue(&agent.id, &[])
            .await
            .unwrap();
        let reloaded = store
            .load_sequence_template_to_agent(tpl_seq.id, &agent.id)
            .await
            .unwrap();
        assert_eq!(reloaded.len(), 2);
        assert_eq!(reloaded[0].template_source, "group");
        assert_eq!(reloaded[0].template_name, "预处理");
    }
}
