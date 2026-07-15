use std::path::{Path, PathBuf};

pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilesError {
    NotConfigured,
    RootMissing,
    BadPath,
    NotFound,
    NotDir,
    ForbiddenExt,
    TooLarge,
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub ext: Option<String>,
}

fn io_err(e: std::io::Error) -> FilesError {
    FilesError::Io(e.to_string())
}

fn normalize_rel(rel: &str) -> Result<String, FilesError> {
    let mut normalized = rel.replace('\\', "/");
    while normalized.starts_with('/') {
        normalized.remove(0);
    }
    while normalized.ends_with('/') {
        normalized.pop();
    }

    if normalized.contains(':') {
        return Err(FilesError::BadPath);
    }

    if !normalized.is_empty() && Path::new(&normalized).is_absolute() {
        return Err(FilesError::BadPath);
    }

    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(FilesError::BadPath);
        }
        segments.push(segment);
    }

    Ok(segments.join("/"))
}

fn canonical_root(root: &Path) -> Result<PathBuf, FilesError> {
    if !root.exists() {
        return Err(FilesError::RootMissing);
    }
    root.canonicalize().map_err(io_err)
}

pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, FilesError> {
    let canonical_root = canonical_root(root)?;
    let normalized = normalize_rel(rel)?;
    let joined = if normalized.is_empty() {
        canonical_root.clone()
    } else {
        canonical_root.join(&normalized)
    };
    let canonical = joined.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FilesError::NotFound
        } else {
            io_err(e)
        }
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(FilesError::BadPath);
    }
    Ok(canonical)
}

fn file_ext(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

fn content_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "txt" => Some("text/plain; charset=utf-8"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

pub fn list_dir(root: &Path, rel: &str) -> Result<(String, Vec<FileEntry>), FilesError> {
    let normalized = normalize_rel(rel)?;
    let path = resolve(root, rel)?;
    let meta = path.metadata().map_err(io_err)?;
    if !meta.is_dir() {
        return Err(FilesError::NotDir);
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().into_owned();
        let entry_meta = entry.metadata().map_err(io_err)?;
        if entry_meta.is_dir() {
            entries.push(FileEntry {
                name,
                kind: EntryKind::Dir,
                size: None,
                ext: None,
            });
        } else {
            let ext = file_ext(&name);
            entries.push(FileEntry {
                name,
                kind: EntryKind::File,
                size: Some(entry_meta.len()),
                ext,
            });
        }
    }

    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir;
        let b_dir = b.kind == EntryKind::Dir;
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
        }
    });

    Ok((normalized, entries))
}

pub fn read_file(root: &Path, rel: &str) -> Result<(String, String, Vec<u8>), FilesError> {
    let path = resolve(root, rel)?;
    let meta = path.metadata().map_err(io_err)?;
    if meta.is_dir() {
        return Err(FilesError::NotDir);
    }

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let ext = file_ext(&filename).ok_or(FilesError::ForbiddenExt)?;
    let content_type = content_type_for_ext(&ext).ok_or(FilesError::ForbiddenExt)?;

    if meta.len() > MAX_FILE_BYTES {
        return Err(FilesError::TooLarge);
    }

    let bytes = std::fs::read(&path).map_err(io_err)?;
    Ok((filename, content_type.to_string(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_segments() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "../x").unwrap_err();
        assert!(matches!(err, FilesError::BadPath));
    }

    #[test]
    fn lists_nested_eye_diagram_style() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("EyeDiagram/35")).unwrap();
        std::fs::write(dir.path().join("Log.txt"), b"hello").unwrap();
        std::fs::write(dir.path().join("EyeDiagram/35/CH1.gif"), b"GIF89a").unwrap();
        let (_p, entries) = list_dir(dir.path(), "").unwrap();
        assert!(entries.iter().any(|e| e.name == "Log.txt"));
        let (_p, sub) = list_dir(dir.path(), "EyeDiagram/35").unwrap();
        assert!(sub.iter().any(|e| e.name == "CH1.gif" && e.ext.as_deref() == Some("gif")));
    }

    #[test]
    fn content_rejects_pdf() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.pdf"), b"%PDF").unwrap();
        let err = read_file(dir.path(), "a.pdf").unwrap_err();
        assert!(matches!(err, FilesError::ForbiddenExt));
    }

    #[test]
    fn content_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.txt");
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_FILE_BYTES + 1).unwrap();
        let err = read_file(dir.path(), "big.txt").unwrap_err();
        assert!(matches!(err, FilesError::TooLarge));
    }
}
