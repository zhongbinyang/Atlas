use chrono::Utc;
use sqlx::SqlitePool;
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
    pool: SqlitePool,
}

impl Store {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
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
            VALUES (?, ?, ?, ?, 'offline', 0, 0, 0, ?)
            ON CONFLICT(name, ip, port) DO UPDATE SET name = excluded.name
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
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_agent()))
    }

    pub async fn update_agent_status(&self, id: &str, status: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agents SET status = ? WHERE id = ?")
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
            SET status = ?, cpu_percent = ?, memory_percent = ?, busy = ?, last_seen_at = ?
            WHERE id = ?
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
            VALUES (?, ?, ?, ?, ?, ?, ?)
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
            WHERE id = ?
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
            SET name = ?, shell = ?, command = ?, workdir = ?, timeout_secs = ?
            WHERE id = ?
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
        let result = sqlx::query("DELETE FROM task_templates WHERE id = ?")
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, '', '', NULL, ?, NULL, NULL)
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
            WHERE id = ?
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
            SET status = ?, exit_code = ?, stdout = ?, stderr = ?, agent_task_id = ?,
                started_at = ?, finished_at = ?
            WHERE id = ?
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
            sqlx::query_as("SELECT COUNT(*) FROM screenshots WHERE agent_id = ?")
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
            WHERE agent_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
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
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_screenshot()))
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

    async fn test_store() -> Store {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        Store::new(pool)
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
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        let store = Store::new(pool);
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
}
