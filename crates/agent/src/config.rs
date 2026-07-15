#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub bind: String,
    pub port: u16,
    pub center_url: String,
    pub advertise_ip: Option<String>,
    pub hostname: Option<String>,
    pub files_root: Option<std::path::PathBuf>,
}

impl AgentConfig {
    pub fn load_from_env() -> Result<Self, String> {
        let center_url = std::env::var("AGENT_CENTER_URL")
            .map_err(|_| "AGENT_CENTER_URL is required".to_string())?;
        let bind = std::env::var("AGENT_BIND").unwrap_or_else(|_| "0.0.0.0".into());
        let port = std::env::var("AGENT_PORT")
            .ok()
            .map(|s| s.parse::<u16>().map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(26631);
        let advertise_ip = std::env::var("AGENT_ADVERTISE_IP").ok();
        let hostname = std::env::var("AGENT_HOSTNAME").ok();
        let files_root = std::env::var("AGENT_FILES_ROOT")
            .ok()
            .map(std::path::PathBuf::from);
        Ok(Self {
            bind,
            port,
            center_url,
            advertise_ip,
            hostname,
            files_root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_port_is_26631() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::remove_var("AGENT_PORT");
        std::env::set_var("AGENT_CENTER_URL", "http://127.0.0.1:26630");
        let cfg = AgentConfig::load_from_env().unwrap();
        assert_eq!(cfg.port, 26631);
        std::env::remove_var("AGENT_CENTER_URL");
    }

    #[test]
    fn missing_center_url_errors() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::remove_var("AGENT_CENTER_URL");
        assert!(AgentConfig::load_from_env().is_err());
    }
}
