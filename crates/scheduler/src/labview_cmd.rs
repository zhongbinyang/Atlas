/// Strip whitespace and a single layer of surrounding quotes (`"` or `'`).
pub fn normalize_fs_path(raw: &str) -> String {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return s[1..s.len() - 1].trim().to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_fs_path_strips_quotes() {
        assert_eq!(
            normalize_fs_path(r#"  "C:\Users\zhong\test08\Add.vi"  "#),
            r"C:\Users\zhong\test08\Add.vi"
        );
        assert_eq!(normalize_fs_path(r"C:\x\Add.vi"), r"C:\x\Add.vi");
    }
}
