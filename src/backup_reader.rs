//! Backup-specific reader: unlike confined repository readers, parent links and
//! hard links are allowed. The leaf and the opened file must be the same regular file.
use crate::backup_json::FILE_ERROR;
use std::{fs::OpenOptions, io::Read, path::Path};
pub const MAXIMUM: usize = 2 * 1024 * 1024;

pub fn read(path: &Path) -> Result<String, &'static str> {
    read_inner(path).ok_or(FILE_ERROR)
}
#[cfg(not(any(unix, windows)))]
fn read_inner(_path: &Path) -> Option<String> {
    None
}

#[cfg(unix)]
type Identity = (u64, u64);
#[cfg(windows)]
type Identity = (u32, u64);

#[cfg(any(unix, windows))]
fn read_inner(path: &Path) -> Option<String> {
    let (before, identity) = snapshot(path)?;
    read_snapshot(path, before, identity)
}

#[cfg(any(unix, windows))]
fn snapshot(path: &Path) -> Option<(std::fs::Metadata, Identity)> {
    #[cfg(unix)]
    let (before, identity) = {
        use std::os::unix::fs::MetadataExt;
        let before = std::fs::symlink_metadata(path).ok()?;
        let identity = (before.dev(), before.ino());
        (before, identity)
    };
    #[cfg(windows)]
    let (before, identity) = {
        use std::os::windows::fs::OpenOptionsExt;
        // A no-follow, metadata-only handle is the lstat snapshot on Windows.
        // Capture size/type and volume/file index from that same handle.
        let probe = OpenOptions::new()
            .access_mode(0)
            .custom_flags(0x0020_0000)
            .open(path)
            .ok()?;
        (probe.metadata().ok()?, windows_identity(&probe)?)
    };
    Some((before, identity))
}

#[cfg(any(unix, windows))]
fn read_snapshot(path: &Path, before: std::fs::Metadata, identity: Identity) -> Option<String> {
    if !before.is_file() || before.len() > MAXIMUM as u64 {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || opened.len() > MAXIMUM as u64 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if identity != (opened.dev(), opened.ino()) {
            return None;
        }
    }
    #[cfg(windows)]
    if identity != windows_identity(&file)? {
        return None;
    }
    read_handle(file)
}

#[cfg(any(unix, windows))]
fn read_handle(mut file: std::fs::File) -> Option<String> {
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAXIMUM as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAXIMUM {
        return None;
    }
    // TextDecoder(fatal) strips only an initial UTF-8 BOM.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).ok()
}

#[cfg(windows)]
fn windows_identity(file: &std::fs::File) -> Option<(u32, u64)> {
    let (attributes, volume, index) = crate::file_security::windows_file_identity(file)?;
    (attributes & (0x400 | 0x10) == 0).then_some((volume, index))
}

#[cfg(all(test, any(unix, windows)))]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/backup-reader-tests");
        std::fs::create_dir_all(&root).unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = root.join(format!("{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn replacement_between_lstat_snapshot_and_open_is_rejected() {
        let dir = directory();
        let path = dir.join("archive.json");
        std::fs::write(&path, "original").unwrap();
        let (before, identity) = snapshot(&path).unwrap();
        std::fs::rename(&path, dir.join("original.json")).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        assert!(read_snapshot(&path, before, identity).is_none());
        assert_eq!(read(&path).unwrap(), "replacement");
    }
    #[test]
    fn replaced_path_does_not_redirect_an_already_open_read_handle() {
        let dir = directory();
        let path = dir.join("archive.json");
        std::fs::write(&path, "original").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        std::fs::rename(&path, dir.join("original.json")).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        assert_eq!(read_handle(file).unwrap(), "original");
    }
    #[test]
    fn growth_after_metadata_check_is_bounded_by_the_same_handle_read() {
        let dir = directory();
        let path = dir.join("archive.json");
        std::fs::write(&path, "{}").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 2);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAXIMUM as u64 + 1)
            .unwrap();
        assert!(read_handle(file).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn fifo_is_rejected_before_any_potentially_blocking_read() {
        use std::os::unix::ffi::OsStrExt;
        let path = directory().join("archive.fifo");
        let raw = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: raw is a live NUL-terminated owned test path.
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        assert_eq!(read(&path), Err(FILE_ERROR));
    }
}
