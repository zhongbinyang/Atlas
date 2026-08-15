//! Resolve the IP address the agent should advertise to the center.
//!
//! Prefers the local address used for routing toward the center (UDP connect trick),
//! then RFC1918 LAN addresses, while skipping proxy/VPN/virtual adapters such as
//! Mihomo's 198.18.0.0/15 fake-ip range.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

pub fn resolve_advertise_ip(override_ip: Option<&str>, center_url: &str) -> String {
    if let Some(ip) = override_ip.map(str::trim).filter(|s| !s.is_empty()) {
        return ip.to_string();
    }
    if let Some(ip) = ip_routed_toward_center(center_url) {
        if !should_skip_ip(ip) {
            return ip.to_string();
        }
    }
    if let Some(ip) = best_local_ipv4() {
        return ip.to_string();
    }
    local_ip_address::local_ip()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn host_from_center_url(url: &str) -> Option<String> {
    let rest = url
        .trim()
        .strip_prefix("http://")
        .or_else(|| url.trim().strip_prefix("https://"))?;
    let hostport = rest.split('/').next()?.trim();
    if hostport.is_empty() {
        return None;
    }
    // [ipv6]:port or host:port or host
    if let Some(rest) = hostport.strip_prefix('[') {
        let end = rest.find(']')?;
        return Some(rest[..end].to_string());
    }
    let host = hostport.split(':').next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn ip_routed_toward_center(center_url: &str) -> Option<IpAddr> {
    let host = host_from_center_url(center_url)?;
    // Port 9 (discard) — connect does not send traffic; OS picks the egress NIC.
    let target: SocketAddr = format!("{host}:9").parse().ok()?;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(target).ok()?;
    let local = sock.local_addr().ok()?.ip();
    match local {
        IpAddr::V4(v4) if !v4.is_unspecified() && !v4.is_loopback() => Some(IpAddr::V4(v4)),
        _ => None,
    }
}

fn should_skip_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => should_skip_ipv4(v4),
        IpAddr::V6(_) => true,
    }
}

fn should_skip_ipv4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_link_local() || ip.is_multicast() {
        return true;
    }
    let o = ip.octets();
    // 198.18.0.0/15 — RFC 2544 / Clash·Mihomo fake-ip
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return true;
    }
    false
}

fn interface_name_penalty(name: &str) -> i32 {
    let n = name.to_ascii_lowercase();
    let mut score = 0;
    const BAD: &[&str] = &[
        "mihomo",
        "clash",
        "meta",
        "tun",
        "tap",
        "vpn",
        "wsl",
        "hyper-v",
        "vethernet",
        "virtual",
        "bluetooth",
        "vmware",
        "vbox",
        "docker",
        "loopback",
        "isatap",
        "teredo",
    ];
    for b in BAD {
        if n.contains(b) {
            score -= 100;
        }
    }
    // Windows Chinese "以太网"
    if n.contains("以太网") || n.contains("ethernet") || n.contains("eth") {
        score += 50;
    }
    if n.contains("wlan") || n.contains("wi-fi") || n.contains("wifi") || n.contains("无线") {
        score += 10;
    }
    score
}

fn ipv4_preference(ip: Ipv4Addr) -> i32 {
    if should_skip_ipv4(ip) {
        return -1000;
    }
    let o = ip.octets();
    // Prefer corporate 10/8, then 192.168/16, then other RFC1918 172.16/12
    if o[0] == 10 {
        return 300;
    }
    if o[0] == 192 && o[1] == 168 {
        return 250;
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return 150; // often Hyper-V/WSL; still better than public/fake
    }
    0
}

fn best_local_ipv4() -> Option<Ipv4Addr> {
    let list = local_ip_address::list_afinet_netifas().ok()?;
    let mut best: Option<(i32, Ipv4Addr)> = None;
    for (name, ip) in list {
        let IpAddr::V4(v4) = ip else { continue };
        if should_skip_ipv4(v4) {
            continue;
        }
        let score = ipv4_preference(v4) + interface_name_penalty(&name);
        match best {
            None => best = Some((score, v4)),
            Some((best_score, _)) if score > best_score => best = Some((score, v4)),
            _ => {}
        }
    }
    best.map(|(_, ip)| ip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_center_host() {
        assert_eq!(
            host_from_center_url("http://10.102.30.18:9080").as_deref(),
            Some("10.102.30.18")
        );
        assert_eq!(
            host_from_center_url("http://10.102.30.18:9080/api").as_deref(),
            Some("10.102.30.18")
        );
    }

    #[test]
    fn skips_mihomo_fake_ip() {
        assert!(should_skip_ipv4(Ipv4Addr::new(198, 18, 0, 1)));
        assert!(should_skip_ipv4(Ipv4Addr::new(198, 19, 1, 2)));
        assert!(!should_skip_ipv4(Ipv4Addr::new(10, 102, 30, 10)));
    }

    #[test]
    fn prefers_ethernet_name_and_10_net() {
        assert!(interface_name_penalty("以太网") > interface_name_penalty("Mihomo"));
        assert!(ipv4_preference(Ipv4Addr::new(10, 102, 30, 10))
            > ipv4_preference(Ipv4Addr::new(172, 25, 32, 1)));
    }

    #[test]
    fn override_wins() {
        assert_eq!(
            resolve_advertise_ip(Some("10.102.30.10"), "http://10.102.30.18:9080"),
            "10.102.30.10"
        );
    }
}
