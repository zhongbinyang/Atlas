use common::{ShellKind, TaskStatus};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug)]
pub struct ExecuteResult {
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_command(
    shell: ShellKind,
    command: &str,
    workdir: Option<&str>,
    timeout_secs: u64,
) -> ExecuteResult {
    let mut cmd = match shell {
        ShellKind::Cmd => {
            let mut c = Command::new("cmd");
            c.args(["/C", command]);
            c
        }
        ShellKind::Powershell => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            c
        }
    };
    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }
    cmd.kill_on_drop(true);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecuteResult {
                status: TaskStatus::Failed,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("failed to spawn: {e}"),
            };
        }
    };

    match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let code = output.status.code();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let status = if output.status.success() {
                TaskStatus::Succeeded
            } else {
                TaskStatus::Failed
            };
            ExecuteResult {
                status,
                exit_code: code,
                stdout,
                stderr,
            }
        }
        Ok(Err(e)) => ExecuteResult {
            status: TaskStatus::Failed,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("wait error: {e}"),
        },
        Err(_) => ExecuteResult {
            status: TaskStatus::Timeout,
            exit_code: None,
            stdout: String::new(),
            stderr: "timeout".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_succeeds() {
        let r = run_command(ShellKind::Cmd, "echo hello", None, 30).await;
        assert_eq!(r.status, TaskStatus::Succeeded);
        assert!(r.stdout.to_lowercase().contains("hello"));
    }

    #[tokio::test]
    async fn nonzero_fails() {
        let r = run_command(ShellKind::Cmd, "exit /B 7", None, 30).await;
        assert_eq!(r.status, TaskStatus::Failed);
        assert_eq!(r.exit_code, Some(7));
    }

    #[tokio::test]
    async fn timeout_kills() {
        let r = run_command(ShellKind::Cmd, "ping -n 10 127.0.0.1", None, 1).await;
        assert_eq!(r.status, TaskStatus::Timeout);
    }
}
