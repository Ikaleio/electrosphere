use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use pcre2_sys::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::cfs;

const MAX_FILE_CHUNK_BYTES: usize = 384 * 1024;
const MAX_FILE_WRITE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EDIT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EDIT_CONTENT_BYTES: usize = 768 * 1024;
const MAX_READ_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_SEARCH_RESPONSE_BYTES: usize = 1_500_000;
const MAX_CROSS_LINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024 * 1024;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;

static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub kind: String,
    pub start_line: usize,
    pub end_line: Option<usize>,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_after: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub mode: u32,
    pub modified_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_digest: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<Entry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<GrepMatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stat_result: Option<StatResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_matches: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_directory: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eof: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_after: Option<usize>,
}

#[derive(Debug)]
pub struct FileFailure {
    pub code: Option<&'static str>,
    pub message: String,
    pub details: Option<FailureDetails>,
}

impl FileFailure {
    fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
            details: None,
        }
    }

    fn backend(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
            details: None,
        }
    }

    fn stale(current_digest: String) -> Self {
        Self {
            code: Some("INVALID_EDIT"),
            message: "File digest changed".to_owned(),
            details: Some(FailureDetails {
                current_digest: Some(current_digest),
            }),
        }
    }
}

type FileResult<T> = std::result::Result<T, FileFailure>;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

fn unique_suffix() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp:x}-{counter:x}", std::process::id())
}

fn io_failure(error: std::io::Error, context: impl Into<String>) -> FileFailure {
    let context = context.into();
    match error.raw_os_error() {
        Some(libc::ENOENT) => FileFailure::coded("FILE_NOT_FOUND", context),
        Some(libc::ENOSPC) | Some(libc::EDQUOT) => FileFailure::coded("STORAGE_EXHAUSTED", context),
        Some(libc::ENOSYS) => FileFailure::coded(
            "BACKEND_UNAVAILABLE",
            "openat2 is unavailable on this guest kernel",
        ),
        _ => FileFailure::backend(format!("{context}: {error}")),
    }
}

fn validate_relative(path: &str, allow_root: bool) -> FileResult<()> {
    if path.is_empty() {
        return if allow_root {
            Ok(())
        } else {
            Err(FileFailure::coded(
                "PATH_OUTSIDE_WORKSPACE",
                "Workspace root is not valid for this operation",
            ))
        };
    }
    if path.as_bytes().contains(&0) || path.starts_with('/') {
        return Err(FileFailure::coded(
            "PATH_OUTSIDE_WORKSPACE",
            "Path must be workspace-relative",
        ));
    }
    if path
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(FileFailure::coded(
            "PATH_OUTSIDE_WORKSPACE",
            "Path contains an unsafe component",
        ));
    }
    Ok(())
}

fn validate_pattern(pattern: &str) -> FileResult<()> {
    if pattern.is_empty() || pattern.starts_with('/') || pattern.as_bytes().contains(&0) {
        return Err(FileFailure::coded(
            "PATH_OUTSIDE_WORKSPACE",
            "Pattern must be workspace-relative",
        ));
    }
    if pattern
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(FileFailure::coded(
            "PATH_OUTSIDE_WORKSPACE",
            "Pattern contains an unsafe component",
        ));
    }
    Ok(())
}

fn valid_transfer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn cstring(value: &str) -> FileResult<CString> {
    CString::new(value)
        .map_err(|_| FileFailure::coded("PATH_OUTSIDE_WORKSPACE", "Path contains a NUL byte"))
}

fn duplicate_fd(fd: RawFd) -> FileResult<OwnedFd> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicated < 0 {
        return Err(io_failure(
            std::io::Error::last_os_error(),
            "Duplicate workspace directory",
        ));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn openat2_fd(
    dirfd: RawFd,
    path: &str,
    flags: i32,
    mode: u32,
    no_symlinks: bool,
) -> FileResult<OwnedFd> {
    let path = cstring(path)?;
    let how = OpenHow {
        flags: flags as u64,
        mode: mode as u64,
        resolve: RESOLVE_BENEATH
            | RESOLVE_NO_MAGICLINKS
            | if no_symlinks { RESOLVE_NO_SYMLINKS } else { 0 },
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dirfd,
            path.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::EXDEV) | Some(libc::ELOOP)) {
            return Err(FileFailure::coded(
                "PATH_OUTSIDE_WORKSPACE",
                "Path resolves outside the workspace or through an unsafe symlink",
            ));
        }
        return Err(io_failure(error, format!("Open workspace path {path:?}")));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn fstat(fd: RawFd) -> FileResult<libc::stat> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(io_failure(
            std::io::Error::last_os_error(),
            "Read file metadata",
        ));
    }
    Ok(stat)
}

fn fstatat(parent: RawFd, name: &str) -> FileResult<libc::stat> {
    let name = cstring(name)?;
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstatat(parent, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io_failure(
            std::io::Error::last_os_error(),
            "Read workspace entry metadata",
        ));
    }
    Ok(stat)
}

fn renameat2_entry(
    source_parent: RawFd,
    source: &CString,
    destination_parent: RawFd,
    destination: &CString,
    flags: u32,
    context: &str,
) -> FileResult<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent,
            source.as_ptr(),
            destination_parent,
            destination.as_ptr(),
            flags,
        ) as i32
    };
    if result != 0 {
        return Err(io_failure(std::io::Error::last_os_error(), context));
    }
    Ok(())
}

fn mode_kind(mode: libc::mode_t) -> &'static str {
    match mode & libc::S_IFMT {
        libc::S_IFREG => "file",
        libc::S_IFDIR => "directory",
        libc::S_IFLNK => "symlink",
        _ => "other",
    }
}

fn modified_millis(stat: &libc::stat) -> u64 {
    let seconds = stat.st_mtime.max(0) as u64;
    let nanos = stat.st_mtime_nsec.max(0) as u64;
    seconds
        .saturating_mul(1_000)
        .saturating_add(nanos / 1_000_000)
}

fn split_parent(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

fn encode_cursor<T: Serialize>(value: &T) -> FileResult<String> {
    serde_json::to_vec(value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|error| FileFailure::backend(format!("Encode cursor: {error}")))
}

fn decode_cursor<T: for<'de> Deserialize<'de>>(value: &str) -> FileResult<T> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| FileFailure::coded("INVALID_ARGUMENT", "Cursor is invalid"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| FileFailure::coded("INVALID_ARGUMENT", "Cursor is invalid"))
}

fn file_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

struct PendingFileWrite {
    file: File,
    parent: OwnedFd,
    temporary_name: String,
    target_name: String,
    bytes: u64,
    hasher: Sha256,
}

struct PendingSnapshot {
    id: String,
    path: PathBuf,
    file: File,
    size: u64,
    digest: String,
    next_offset: u64,
}

pub struct FileService {
    root: File,
    root_path: PathBuf,
    writes: HashMap<String, PendingFileWrite>,
    snapshot: Option<PendingSnapshot>,
}

impl FileService {
    pub fn open(root: impl AsRef<Path>) -> FileResult<Self> {
        let root_path = root.as_ref().to_path_buf();
        let root = OpenOptions::new()
            .read(true)
            .open(&root_path)
            .map_err(|error| io_failure(error, "Open workspace root"))?;
        let stat = fstat(root.as_raw_fd())?;
        if mode_kind(stat.st_mode) != "directory" {
            return Err(FileFailure::backend("Workspace root is not a directory"));
        }
        Ok(Self {
            root,
            root_path,
            writes: HashMap::new(),
            snapshot: None,
        })
    }

    fn open_existing(&self, path: &str, flags: i32) -> FileResult<OwnedFd> {
        validate_relative(path, true)?;
        if path.is_empty() {
            return duplicate_fd(self.root.as_raw_fd());
        }
        openat2_fd(
            self.root.as_raw_fd(),
            path,
            flags | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0,
            false,
        )
    }

    fn open_parent(&self, path: &str, create_parents: bool) -> FileResult<(OwnedFd, String)> {
        validate_relative(path, false)?;
        let (parent_path, name) = split_parent(path);
        if parent_path.is_empty() {
            return Ok((duplicate_fd(self.root.as_raw_fd())?, name.to_owned()));
        }
        if !create_parents {
            return Ok((
                openat2_fd(
                    self.root.as_raw_fd(),
                    parent_path,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                    0,
                    true,
                )?,
                name.to_owned(),
            ));
        }
        let mut current = duplicate_fd(self.root.as_raw_fd())?;
        for component in parent_path.split('/') {
            let component_c = cstring(component)?;
            let created =
                unsafe { libc::mkdirat(current.as_raw_fd(), component_c.as_ptr(), 0o755) };
            if created != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EEXIST) {
                    return Err(io_failure(error, "Create workspace parent directory"));
                }
            }
            current = openat2_fd(
                current.as_raw_fd(),
                component,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                0,
                true,
            )?;
        }
        Ok((current, name.to_owned()))
    }

    fn reject_symlink_target(parent: RawFd, name: &str) -> FileResult<()> {
        match fstatat(parent, name) {
            Ok(stat) if mode_kind(stat.st_mode) == "symlink" => Err(FileFailure::coded(
                "PATH_OUTSIDE_WORKSPACE",
                "Destination cannot be a symlink",
            )),
            Ok(_) => Ok(()),
            Err(error) if error.code == Some("FILE_NOT_FOUND") => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn file_read(
        &self,
        path: &str,
        offset: Option<usize>,
        limit: Option<usize>,
        ranges: Option<Vec<(usize, usize)>>,
        cursor: Option<&str>,
    ) -> FileResult<FileResponse> {
        validate_relative(path, true)?;
        if ranges.is_some() && (offset.is_some() || limit.is_some()) {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "ranges cannot be combined with offset or limit",
            ));
        }
        let fd = self.open_existing(path, libc::O_RDONLY)?;
        let stat = fstat(fd.as_raw_fd())?;
        if mode_kind(stat.st_mode) == "directory" {
            if ranges.is_some() || offset.is_some() {
                return Err(FileFailure::coded(
                    "INVALID_ARGUMENT",
                    "Directory reads do not accept line offsets or ranges",
                ));
            }
            return self.read_directory(path, fd, limit.unwrap_or(1_000), cursor);
        }
        if mode_kind(stat.st_mode) != "file" {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "FileRead requires a regular file or directory",
            ));
        }
        let mut requested_ranges = ranges.unwrap_or_default();
        for (start, end) in &requested_ranges {
            if *start == 0 || end < start {
                return Err(FileFailure::coded(
                    "INVALID_ARGUMENT",
                    "Line range is invalid",
                ));
            }
        }
        requested_ranges.sort_unstable();
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ReadCursor {
            next_line: usize,
        }
        let cursor_line = cursor
            .map(decode_cursor::<ReadCursor>)
            .transpose()?
            .map(|value| value.next_line);
        let first_line = cursor_line.unwrap_or_else(|| {
            if requested_ranges.is_empty() {
                offset.unwrap_or(1)
            } else {
                requested_ranges.first().map_or(1, |range| range.0)
            }
        });
        if first_line == 0 {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Line offset must be positive",
            ));
        }
        let maximum_lines = if requested_ranges.is_empty() {
            limit.unwrap_or(200)
        } else {
            usize::MAX
        };
        if maximum_lines == 0 {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Line limit must be positive",
            ));
        }
        let file = File::from(fd);
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut total_size = 0u64;
        let mut line_number = 0usize;
        let mut returned = Vec::new();
        let mut next_line = None;
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let count = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| io_failure(error, "Read workspace file"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer);
            total_size = total_size.saturating_add(count as u64);
            line_number += 1;
            if line_number < first_line {
                continue;
            }
            let selected = if requested_ranges.is_empty() {
                true
            } else {
                requested_ranges
                    .iter()
                    .any(|(start, end)| line_number >= *start && line_number <= *end)
            };
            if !selected {
                continue;
            }
            if returned.len() >= maximum_lines {
                next_line.get_or_insert(line_number);
                continue;
            }
            let line = String::from_utf8(buffer.clone())
                .map_err(|_| FileFailure::coded("INVALID_ARGUMENT", "File is not valid UTF-8"))?;
            let mut candidate = FileResponse {
                lines: Some({
                    let mut values = returned.clone();
                    values.push(line.clone());
                    values
                }),
                size: Some(stat.st_size.max(0) as u64),
                truncated: Some(false),
                ..FileResponse::default()
            };
            if serde_json::to_vec(&candidate)
                .map_err(|error| FileFailure::backend(format!("Encode read response: {error}")))?
                .len()
                > MAX_READ_RESPONSE_BYTES
            {
                next_line.get_or_insert(line_number);
                continue;
            }
            returned.push(line);
            candidate.lines = None;
        }
        if total_size != stat.st_size.max(0) as u64 {
            return Err(FileFailure::backend("File changed while it was being read"));
        }
        let digest = format!("sha256:{:x}", hasher.finalize());
        let next_cursor = next_line
            .map(|value| encode_cursor(&ReadCursor { next_line: value }))
            .transpose()?;
        Ok(FileResponse {
            lines: Some(returned),
            size: Some(total_size),
            digest: Some(digest),
            next_offset: if requested_ranges.is_empty() {
                next_line
            } else {
                None
            },
            truncated: Some(next_line.is_some()),
            next_cursor: if requested_ranges.is_empty() {
                None
            } else {
                next_cursor
            },
            ..FileResponse::default()
        })
    }

    fn read_directory(
        &self,
        path: &str,
        fd: OwnedFd,
        limit: usize,
        cursor: Option<&str>,
    ) -> FileResult<FileResponse> {
        if limit == 0 || limit > 10_000 {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Directory read limit is invalid",
            ));
        }
        #[derive(Deserialize, Serialize)]
        struct DirectoryCursor {
            path: String,
        }
        let cursor = cursor.map(decode_cursor::<DirectoryCursor>).transpose()?;
        let directory_path = format!("/proc/self/fd/{}", fd.as_raw_fd());
        let mut all = Vec::new();
        let directory = fs::read_dir(directory_path)
            .map_err(|error| io_failure(error, "Read workspace directory"))?;
        for item in directory {
            let item = item.map_err(|error| io_failure(error, "Read workspace directory entry"))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let metadata = fs::symlink_metadata(item.path())
                .map_err(|error| io_failure(error, "Read workspace directory metadata"))?;
            let kind = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else {
                "file"
            };
            let relative = if path.is_empty() {
                name
            } else {
                format!("{path}/{name}")
            };
            all.push(Entry {
                path: if kind == "directory" {
                    format!("{relative}/")
                } else {
                    relative
                },
                kind: kind.to_owned(),
                size: (kind == "file").then_some(metadata.len()),
                modified_at: Some(
                    metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |value| value.as_millis() as u64),
                ),
            });
        }
        all.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
        let remaining = all
            .into_iter()
            .filter(|entry| {
                cursor
                    .as_ref()
                    .is_none_or(|value| entry.path.as_bytes() > value.path.as_bytes())
            })
            .collect::<Vec<_>>();
        let mut entries = Vec::new();
        for entry in &remaining {
            if entries.len() >= limit {
                break;
            }
            let mut candidate = entries.clone();
            candidate.push(entry.clone());
            let response = FileResponse {
                entries: Some(candidate),
                is_directory: Some(true),
                truncated: Some(false),
                ..FileResponse::default()
            };
            if serde_json::to_vec(&response)
                .map_err(|error| {
                    FileFailure::backend(format!("Encode directory response: {error}"))
                })?
                .len()
                > MAX_READ_RESPONSE_BYTES
            {
                break;
            }
            entries.push(entry.clone());
        }
        let truncated = entries.len() < remaining.len();
        let next_cursor = if truncated {
            entries
                .last()
                .map(|entry| {
                    encode_cursor(&DirectoryCursor {
                        path: entry.path.clone(),
                    })
                })
                .transpose()?
        } else {
            None
        };
        Ok(FileResponse {
            entries: Some(entries),
            is_directory: Some(true),
            truncated: Some(truncated),
            next_cursor,
            ..FileResponse::default()
        })
    }

    pub fn file_read_bytes(
        &self,
        path: &str,
        offset: u64,
        limit: usize,
    ) -> FileResult<FileResponse> {
        validate_relative(path, false)?;
        if limit == 0 || limit > MAX_FILE_CHUNK_BYTES {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Byte read limit is invalid",
            ));
        }
        let fd = self.open_existing(path, libc::O_RDONLY)?;
        let stat = fstat(fd.as_raw_fd())?;
        if mode_kind(stat.st_mode) != "file" {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "FileReadBytes requires a regular file",
            ));
        }
        let size = stat.st_size.max(0) as u64;
        if offset > size {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Byte offset exceeds file size",
            ));
        }
        let file = File::from(fd);
        let requested = limit.min((size - offset) as usize);
        let mut buffer = vec![0u8; requested];
        let mut read = 0usize;
        while read < requested {
            let count = file
                .read_at(&mut buffer[read..], offset + read as u64)
                .map_err(|error| io_failure(error, "Read workspace file bytes"))?;
            if count == 0 {
                break;
            }
            read += count;
        }
        buffer.truncate(read);
        Ok(FileResponse {
            data: Some(STANDARD.encode(buffer)),
            size: Some(size),
            eof: Some(offset + read as u64 >= size),
            ..FileResponse::default()
        })
    }

    pub fn file_write_begin(
        &mut self,
        transfer_id: String,
        path: String,
        create_parents: bool,
    ) -> FileResult<FileResponse> {
        if !valid_transfer_id(&transfer_id) {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Transfer ID is invalid",
            ));
        }
        if self.writes.contains_key(&transfer_id) {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Transfer ID already exists",
            ));
        }
        if self.writes.len() >= 8 {
            return Err(FileFailure::coded(
                "TRANSFER_CAPACITY",
                "Pending file write capacity reached",
            ));
        }
        let (parent, target_name) = self.open_parent(&path, create_parents)?;
        Self::reject_symlink_target(parent.as_raw_fd(), &target_name)?;
        let temporary_name = format!(".electrosphere-{transfer_id}.tmp");
        let temporary = cstring(&temporary_name)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Create temporary workspace file",
            ));
        }
        self.writes.insert(
            transfer_id,
            PendingFileWrite {
                file: unsafe { File::from_raw_fd(fd) },
                parent,
                temporary_name,
                target_name,
                bytes: 0,
                hasher: Sha256::new(),
            },
        );
        Ok(FileResponse::default())
    }

    pub fn file_write_chunk(&mut self, transfer_id: &str, data: &str) -> FileResult<FileResponse> {
        let decoded = STANDARD.decode(data).map_err(|_| {
            FileFailure::coded("INVALID_ARGUMENT", "File write chunk is not valid base64")
        })?;
        if decoded.len() > MAX_FILE_CHUNK_BYTES {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "File write chunk exceeds protocol limit",
            ));
        }
        let next = self
            .writes
            .get(transfer_id)
            .ok_or_else(|| {
                FileFailure::coded("TRANSFER_NOT_FOUND", "File write transfer not found")
            })?
            .bytes
            .saturating_add(decoded.len() as u64);
        if next > MAX_FILE_WRITE_BYTES {
            let _ = self.abort_write(transfer_id);
            return Err(FileFailure::coded(
                "FILE_TOO_LARGE",
                "File write exceeds size limit",
            ));
        }
        let pending = self
            .writes
            .get_mut(transfer_id)
            .expect("pending write exists");
        pending
            .file
            .write_all(&decoded)
            .map_err(|error| io_failure(error, "Write workspace file chunk"))?;
        pending.hasher.update(&decoded);
        pending.bytes = next;
        Ok(FileResponse::default())
    }

    pub fn file_write_commit(&mut self, transfer_id: &str) -> FileResult<FileResponse> {
        let mut pending = self.writes.remove(transfer_id).ok_or_else(|| {
            FileFailure::coded("TRANSFER_NOT_FOUND", "File write transfer not found")
        })?;
        let temporary = cstring(&pending.temporary_name)?;
        let target = cstring(&pending.target_name)?;
        let result = (|| {
            pending
                .file
                .flush()
                .map_err(|error| io_failure(error, "Flush workspace file"))?;
            pending
                .file
                .sync_all()
                .map_err(|error| io_failure(error, "Sync workspace file"))?;
            drop(pending.file);
            renameat2_entry(
                pending.parent.as_raw_fd(),
                &temporary,
                pending.parent.as_raw_fd(),
                &target,
                0,
                "Publish workspace file",
            )?;
            if unsafe { libc::fsync(pending.parent.as_raw_fd()) } != 0 {
                return Err(io_failure(
                    std::io::Error::last_os_error(),
                    "Sync workspace directory",
                ));
            }
            let digest = format!("sha256:{:x}", pending.hasher.finalize());
            Ok(FileResponse {
                size: Some(pending.bytes),
                digest: Some(digest),
                ..FileResponse::default()
            })
        })();
        if result.is_err() {
            let _ = unsafe { libc::unlinkat(pending.parent.as_raw_fd(), temporary.as_ptr(), 0) };
        }
        result
    }

    fn abort_write(&mut self, transfer_id: &str) -> FileResult<()> {
        let Some(pending) = self.writes.remove(transfer_id) else {
            return Ok(());
        };
        let temporary = cstring(&pending.temporary_name)?;
        drop(pending.file);
        let result = unsafe { libc::unlinkat(pending.parent.as_raw_fd(), temporary.as_ptr(), 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Abort workspace file write",
            ));
        }
        Ok(())
    }

    pub fn file_write_abort(&mut self, transfer_id: &str) -> FileResult<FileResponse> {
        self.abort_write(transfer_id)?;
        Ok(FileResponse::default())
    }

    pub fn file_edit(
        &self,
        path: &str,
        expected_digest: &str,
        mut edits: Vec<EditSpec>,
    ) -> FileResult<FileResponse> {
        validate_relative(path, false)?;
        let fd = self.open_existing(path, libc::O_RDONLY)?;
        let stat = fstat(fd.as_raw_fd())?;
        if mode_kind(stat.st_mode) != "file" {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "FileEdit requires a regular file",
            ));
        }
        if stat.st_size.max(0) as u64 > MAX_EDIT_FILE_BYTES {
            return Err(FileFailure::coded(
                "FILE_TOO_LARGE",
                "File exceeds edit size limit",
            ));
        }
        let mut bytes = Vec::with_capacity(stat.st_size.max(0) as usize);
        File::from(fd)
            .read_to_end(&mut bytes)
            .map_err(|error| io_failure(error, "Read workspace file for edit"))?;
        let current_digest = file_digest(&bytes);
        if current_digest != expected_digest {
            return Err(FileFailure::stale(current_digest));
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| FileFailure::coded("INVALID_ARGUMENT", "File is not valid UTF-8"))?;
        let content_bytes = edits
            .iter()
            .filter_map(|edit| edit.content.as_ref())
            .map(|content| content.len())
            .sum::<usize>();
        if content_bytes > MAX_EDIT_CONTENT_BYTES {
            return Err(FileFailure::coded(
                "FILE_TOO_LARGE",
                "Edit content exceeds size limit",
            ));
        }
        let mut starts = vec![0usize];
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\n' && index + 1 < bytes.len() {
                starts.push(index + 1);
            }
        }
        if bytes.is_empty() {
            starts.clear();
        }
        let line_count = starts.len();
        edits.sort_by_key(|edit| (edit.start_line, edit.end_line.unwrap_or(edit.start_line)));
        let mut previous_end = 0usize;
        for edit in &edits {
            if edit.start_line == 0 || edit.start_line > line_count {
                return Err(FileFailure::coded(
                    "INVALID_ARGUMENT",
                    "Edit line is out of range",
                ));
            }
            let end_line = edit.end_line.unwrap_or(edit.start_line);
            if end_line < edit.start_line
                || end_line > line_count
                || edit.start_line <= previous_end
            {
                return Err(FileFailure::coded(
                    "INVALID_ARGUMENT",
                    "Edit ranges overlap or are invalid",
                ));
            }
            match edit.kind.as_str() {
                "replace" => {
                    if edit.end_line.is_none() || edit.content.is_none() {
                        return Err(FileFailure::coded(
                            "INVALID_ARGUMENT",
                            "replace requires endLine and content",
                        ));
                    }
                }
                "delete" => {
                    if edit.end_line.is_none() || edit.content.is_some() {
                        return Err(FileFailure::coded(
                            "INVALID_ARGUMENT",
                            "delete requires endLine and no content",
                        ));
                    }
                }
                "insert_before" | "insert_after" => {
                    if edit.end_line.is_some() || edit.content.is_none() {
                        return Err(FileFailure::coded(
                            "INVALID_ARGUMENT",
                            "insert requires content and no endLine",
                        ));
                    }
                }
                _ => {
                    return Err(FileFailure::coded(
                        "INVALID_ARGUMENT",
                        "Edit kind is invalid",
                    ));
                }
            }
            previous_end = end_line;
        }
        for edit in edits.iter().rev() {
            let line_start = starts[edit.start_line - 1];
            let line_end = |line: usize| {
                if line < line_count {
                    starts[line]
                } else {
                    bytes.len()
                }
            };
            let (start, end, replacement) = match edit.kind.as_str() {
                "replace" => (
                    line_start,
                    line_end(edit.end_line.expect("validated end line")),
                    edit.content.as_deref().unwrap_or_default(),
                ),
                "delete" => (
                    line_start,
                    line_end(edit.end_line.expect("validated end line")),
                    "",
                ),
                "insert_before" => (
                    line_start,
                    line_start,
                    edit.content.as_deref().unwrap_or_default(),
                ),
                "insert_after" => {
                    let end = line_end(edit.start_line);
                    (end, end, edit.content.as_deref().unwrap_or_default())
                }
                _ => unreachable!(),
            };
            bytes.splice(start..end, replacement.as_bytes().iter().copied());
        }
        if bytes.len() as u64 > MAX_EDIT_FILE_BYTES {
            return Err(FileFailure::coded(
                "FILE_TOO_LARGE",
                "Edited file exceeds size limit",
            ));
        }
        let lines_after = if bytes.is_empty() {
            0
        } else {
            1 + bytes.iter().filter(|byte| **byte == b'\n').count()
                - usize::from(bytes.last() == Some(&b'\n'))
        };
        let digest = file_digest(&bytes);
        self.atomic_replace(path, &bytes, stat.st_mode & 0o0777)?;
        Ok(FileResponse {
            digest: Some(digest),
            lines_before: Some(line_count),
            lines_after: Some(lines_after),
            ..FileResponse::default()
        })
    }

    fn atomic_replace(&self, path: &str, bytes: &[u8], mode: libc::mode_t) -> FileResult<()> {
        let (parent, target_name) = self.open_parent(path, false)?;
        Self::reject_symlink_target(parent.as_raw_fd(), &target_name)?;
        let temporary_name = format!(".electrosphere-edit-{}.tmp", unique_suffix());
        let temporary = cstring(&temporary_name)?;
        let target = cstring(&target_name)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Create edit staging file",
            ));
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
                return Err(io_failure(
                    std::io::Error::last_os_error(),
                    "Preserve edited file mode",
                ));
            }
            file.write_all(bytes)
                .map_err(|error| io_failure(error, "Write edited file"))?;
            file.flush()
                .map_err(|error| io_failure(error, "Flush edited file"))?;
            file.sync_all()
                .map_err(|error| io_failure(error, "Sync edited file"))?;
            drop(file);
            renameat2_entry(
                parent.as_raw_fd(),
                &temporary,
                parent.as_raw_fd(),
                &target,
                0,
                "Publish edited file",
            )?;
            if unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
                return Err(io_failure(
                    std::io::Error::last_os_error(),
                    "Sync edited file directory",
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = unsafe { libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0) };
        }
        result
    }

    pub fn file_glob(
        &self,
        patterns: Vec<String>,
        limit: usize,
        cursor: Option<&str>,
        gitignore: bool,
        hidden: bool,
        sort: &str,
    ) -> FileResult<FileResponse> {
        if patterns.is_empty() || limit == 0 || limit > 10_000 {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Glob request is invalid",
            ));
        }
        let mut builder = GlobSetBuilder::new();
        for pattern in &patterns {
            validate_pattern(pattern)?;
            builder.add(
                GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| {
                        FileFailure::coded("INVALID_ARGUMENT", format!("Invalid glob: {error}"))
                    })?,
            );
        }
        let matcher = builder.build().map_err(|error| {
            FileFailure::coded("INVALID_ARGUMENT", format!("Invalid glob set: {error}"))
        })?;
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct GlobCursor {
            sort: String,
            path: String,
            modified_at: Option<u64>,
        }
        let cursor = cursor.map(decode_cursor::<GlobCursor>).transpose()?;
        if cursor.as_ref().is_some_and(|value| value.sort != sort) {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Glob cursor sort does not match request",
            ));
        }
        if sort != "name" && sort != "modified" {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Glob sort is invalid",
            ));
        }
        let mut walker = WalkBuilder::new(&self.root_path);
        walker
            .follow_links(false)
            .hidden(!hidden)
            .git_ignore(gitignore)
            .ignore(gitignore)
            .git_global(false)
            .git_exclude(false)
            .parents(false)
            .require_git(false);
        let mut all = Vec::new();
        for result in walker.build() {
            let Ok(item) = result else { continue };
            if item.path() == self.root_path {
                continue;
            }
            let Ok(relative) = item.path().strip_prefix(&self.root_path) else {
                continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");
            let metadata = match fs::symlink_metadata(item.path()) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let kind = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                continue;
            };
            let matched = matcher.is_match(&path)
                || (kind == "directory" && matcher.is_match(format!("{path}/")));
            if !matched {
                continue;
            }
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |value| value.as_millis() as u64);
            all.push(Entry {
                path: if kind == "directory" {
                    format!("{path}/")
                } else {
                    path
                },
                kind: kind.to_owned(),
                size: (kind == "file").then_some(metadata.len()),
                modified_at: Some(modified_at),
            });
        }
        if sort == "modified" {
            all.sort_by(|left, right| {
                right
                    .modified_at
                    .cmp(&left.modified_at)
                    .then_with(|| left.path.as_bytes().cmp(right.path.as_bytes()))
            });
        } else {
            all.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
        }
        let after_cursor = |entry: &Entry| match cursor.as_ref() {
            None => true,
            Some(value) if sort == "name" => entry.path.as_bytes() > value.path.as_bytes(),
            Some(value) => {
                let entry_key = (
                    std::cmp::Reverse(entry.modified_at.unwrap_or(0)),
                    entry.path.as_str(),
                );
                let cursor_key = (
                    std::cmp::Reverse(value.modified_at.unwrap_or(0)),
                    value.path.as_str(),
                );
                entry_key > cursor_key
            }
        };
        let remaining = all.into_iter().filter(after_cursor).collect::<Vec<_>>();
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in &remaining {
            if entries.len() >= limit {
                truncated = true;
                break;
            }
            let mut candidate = entries.clone();
            candidate.push(entry.clone());
            let response = FileResponse {
                entries: Some(candidate),
                truncated: Some(false),
                ..FileResponse::default()
            };
            if serde_json::to_vec(&response)
                .map_err(|error| FileFailure::backend(format!("Encode glob response: {error}")))?
                .len()
                > MAX_SEARCH_RESPONSE_BYTES
            {
                truncated = true;
                break;
            }
            entries.push(entry.clone());
        }
        if entries.len() < remaining.len() {
            truncated = true;
        }
        let next_cursor = if truncated {
            entries
                .last()
                .map(|entry| {
                    encode_cursor(&GlobCursor {
                        sort: sort.to_owned(),
                        path: entry.path.clone(),
                        modified_at: entry.modified_at,
                    })
                })
                .transpose()?
        } else {
            None
        };
        Ok(FileResponse {
            entries: Some(entries),
            truncated: Some(truncated),
            next_cursor,
            ..FileResponse::default()
        })
    }

    pub fn file_grep(
        &self,
        pattern: &str,
        paths: Vec<String>,
        limit: usize,
        cursor: Option<&str>,
        case_sensitive: bool,
        context_before: usize,
        context_after: usize,
        gitignore: bool,
    ) -> FileResult<FileResponse> {
        if limit == 0 || limit > 10_000 || context_before > 10 || context_after > 10 {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Grep request is invalid",
            ));
        }
        let cross_line = pattern.contains('\n') || pattern.contains("\\n");
        let mut matcher = PatternMatcher::compile(pattern, case_sensitive)?;
        let path_matcher = build_path_matcher(&paths)?;
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct GrepCursor {
            path: String,
            byte_offset: u64,
        }
        let cursor = cursor.map(decode_cursor::<GrepCursor>).transpose()?;
        let mut walker = WalkBuilder::new(&self.root_path);
        walker
            .follow_links(false)
            .hidden(true)
            .git_ignore(gitignore)
            .ignore(gitignore)
            .git_global(false)
            .git_exclude(false)
            .parents(false)
            .require_git(false);
        let mut files = Vec::new();
        for result in walker.build() {
            let Ok(item) = result else { continue };
            let Ok(metadata) = fs::symlink_metadata(item.path()) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let Ok(relative) = item.path().strip_prefix(&self.root_path) else {
                continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");
            if path_matcher
                .as_ref()
                .is_some_and(|value| !value.is_match(&path))
            {
                continue;
            }
            files.push((path, item.path().to_path_buf(), metadata.len()));
        }
        files.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
        let mut accumulator =
            GrepAccumulator::new(limit, cursor.map(|value| (value.path, value.byte_offset)));
        let mut skipped_files = 0usize;
        for (relative, absolute, size) in files {
            if cross_line && size > MAX_CROSS_LINE_BYTES {
                skipped_files += 1;
                continue;
            }
            if size <= MAX_CROSS_LINE_BYTES {
                let bytes = fs::read(&absolute)
                    .map_err(|error| io_failure(error, format!("Read grep file {relative}")))?;
                scan_buffer(
                    &relative,
                    &bytes,
                    &mut matcher,
                    cross_line,
                    context_before,
                    context_after,
                    &mut accumulator,
                )?;
            } else {
                let file = File::open(&absolute)
                    .map_err(|error| io_failure(error, format!("Open grep file {relative}")))?;
                scan_stream(
                    &relative,
                    file,
                    &mut matcher,
                    context_before,
                    context_after,
                    &mut accumulator,
                )?;
            }
        }
        let next_cursor = if accumulator.truncated {
            accumulator
                .last_saved
                .as_ref()
                .map(|(path, byte_offset)| {
                    encode_cursor(&GrepCursor {
                        path: path.clone(),
                        byte_offset: *byte_offset,
                    })
                })
                .transpose()?
        } else {
            None
        };
        Ok(FileResponse {
            matches: Some(accumulator.matches),
            total_matches: Some(accumulator.total_matches),
            skipped_files: Some(skipped_files),
            truncated: Some(accumulator.truncated),
            next_cursor,
            ..FileResponse::default()
        })
    }

    pub fn file_stat(&self, path: &str) -> FileResult<FileResponse> {
        validate_relative(path, true)?;
        let stat = if path.is_empty() {
            fstat(self.root.as_raw_fd())?
        } else {
            let (parent, name) = self.open_parent(path, false)?;
            fstatat(parent.as_raw_fd(), &name)?
        };
        let kind = mode_kind(stat.st_mode);
        if kind == "other" {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Unsupported workspace entry type",
            ));
        }
        Ok(FileResponse {
            stat_result: Some(StatResult {
                kind: kind.to_owned(),
                size: stat.st_size.max(0) as u64,
                mode: stat.st_mode & 0o7777,
                modified_at: modified_millis(&stat),
            }),
            ..FileResponse::default()
        })
    }

    pub fn file_move(&self, source: &str, destination: &str) -> FileResult<FileResponse> {
        validate_relative(source, false)?;
        validate_relative(destination, false)?;
        let (source_parent, source_name) = self.open_parent(source, false)?;
        let (destination_parent, destination_name) = self.open_parent(destination, false)?;
        fstatat(source_parent.as_raw_fd(), &source_name)?;
        Self::reject_symlink_target(destination_parent.as_raw_fd(), &destination_name)?;
        let source_name = cstring(&source_name)?;
        let destination_name = cstring(&destination_name)?;
        renameat2_entry(
            source_parent.as_raw_fd(),
            &source_name,
            destination_parent.as_raw_fd(),
            &destination_name,
            0,
            "Move workspace entry",
        )?;
        if unsafe { libc::fsync(source_parent.as_raw_fd()) } != 0
            || unsafe { libc::fsync(destination_parent.as_raw_fd()) } != 0
        {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Sync moved workspace entry",
            ));
        }
        Ok(FileResponse::default())
    }

    pub fn file_remove(&self, path: &str) -> FileResult<FileResponse> {
        validate_relative(path, false)?;
        let (parent, name) = self.open_parent(path, false)?;
        fstatat(parent.as_raw_fd(), &name)?;
        let detached_name = format!(".electrosphere-remove-{}.tmp", unique_suffix());
        let name_c = cstring(&name)?;
        let detached_c = cstring(&detached_name)?;
        renameat2_entry(
            parent.as_raw_fd(),
            &name_c,
            parent.as_raw_fd(),
            &detached_c,
            libc::RENAME_NOREPLACE,
            "Detach workspace entry for removal",
        )?;
        remove_detached(parent.as_raw_fd(), &detached_name)?;
        if unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Sync removed workspace entry",
            ));
        }
        Ok(FileResponse::default())
    }

    pub fn snapshot_begin(
        &mut self,
        snapshot_id: String,
        format: &str,
    ) -> FileResult<FileResponse> {
        if format != "cfs-v1" || !valid_transfer_id(&snapshot_id) {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Snapshot request is invalid",
            ));
        }
        if self.snapshot.is_some() {
            return Err(FileFailure::coded(
                "TRANSFER_CAPACITY",
                "A snapshot transfer is already active",
            ));
        }
        let path = PathBuf::from(format!("/tmp/.electrosphere-snapshot-{snapshot_id}.cfs"));
        let (size, digest) =
            cfs::export_workspace_file(&self.root_path, &path).map_err(|error| {
                let message = error.to_string();
                if message.contains("snapshot limit") || message.contains("exceeds total limit") {
                    FileFailure::coded("SNAPSHOT_LIMIT", message)
                } else {
                    FileFailure::coded("SNAPSHOT_UNSUPPORTED_ENTRY", message)
                }
            })?;
        if size > MAX_SNAPSHOT_BYTES {
            let _ = fs::remove_file(&path);
            return Err(FileFailure::coded(
                "SNAPSHOT_LIMIT",
                "Snapshot exceeds total size limit",
            ));
        }
        let file =
            File::open(&path).map_err(|error| io_failure(error, "Open snapshot transfer"))?;
        self.snapshot = Some(PendingSnapshot {
            id: snapshot_id,
            path,
            file,
            size,
            digest: digest.clone(),
            next_offset: 0,
        });
        Ok(FileResponse {
            size: Some(size),
            digest: Some(digest),
            ..FileResponse::default()
        })
    }

    pub fn snapshot_read(
        &mut self,
        snapshot_id: &str,
        offset: u64,
        limit: usize,
    ) -> FileResult<FileResponse> {
        if limit == 0 || limit > MAX_FILE_CHUNK_BYTES {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Snapshot read limit is invalid",
            ));
        }
        let snapshot = self.snapshot.as_mut().ok_or_else(|| {
            FileFailure::coded("TRANSFER_NOT_FOUND", "Snapshot transfer not found")
        })?;
        if snapshot.id != snapshot_id {
            return Err(FileFailure::coded(
                "TRANSFER_NOT_FOUND",
                "Snapshot transfer not found",
            ));
        }
        if offset != snapshot.next_offset {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                "Snapshot reads must use consecutive offsets",
            ));
        }
        snapshot
            .file
            .seek(SeekFrom::Start(offset))
            .map_err(|error| io_failure(error, "Seek snapshot transfer"))?;
        let requested = limit.min((snapshot.size - offset) as usize);
        let mut buffer = vec![0u8; requested];
        let read = snapshot
            .file
            .read(&mut buffer)
            .map_err(|error| io_failure(error, "Read snapshot transfer"))?;
        buffer.truncate(read);
        snapshot.next_offset += read as u64;
        Ok(FileResponse {
            data: Some(STANDARD.encode(buffer)),
            size: Some(snapshot.size),
            digest: Some(snapshot.digest.clone()),
            eof: Some(snapshot.next_offset >= snapshot.size),
            ..FileResponse::default()
        })
    }

    pub fn snapshot_end(&mut self, snapshot_id: &str) -> FileResult<FileResponse> {
        if self
            .snapshot
            .as_ref()
            .is_some_and(|value| value.id != snapshot_id)
        {
            return Ok(FileResponse::default());
        }
        if let Some(snapshot) = self.snapshot.take() {
            drop(snapshot.file);
            fs::remove_file(snapshot.path)
                .map_err(|error| io_failure(error, "Remove snapshot transfer"))?;
        }
        Ok(FileResponse::default())
    }
}

impl Drop for FileService {
    fn drop(&mut self) {
        let transfer_ids = self.writes.keys().cloned().collect::<Vec<_>>();
        for transfer_id in transfer_ids {
            let _ = self.abort_write(&transfer_id);
        }
        if let Some(snapshot) = self.snapshot.take() {
            drop(snapshot.file);
            let _ = fs::remove_file(snapshot.path);
        }
    }
}

fn remove_detached(parent: RawFd, name: &str) -> FileResult<()> {
    let stat = fstatat(parent, name)?;
    let name_c = cstring(name)?;
    if mode_kind(stat.st_mode) != "directory" {
        if unsafe { libc::unlinkat(parent, name_c.as_ptr(), 0) } != 0 {
            return Err(io_failure(
                std::io::Error::last_os_error(),
                "Remove workspace file",
            ));
        }
        return Ok(());
    }
    let directory = openat2_fd(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        0,
        true,
    )?;
    let directory_path = format!("/proc/self/fd/{}", directory.as_raw_fd());
    let children = fs::read_dir(directory_path)
        .map_err(|error| io_failure(error, "Read workspace directory for removal"))?;
    for child in children {
        let child = child.map_err(|error| io_failure(error, "Read removal entry"))?;
        let child_name = child.file_name().to_string_lossy().into_owned();
        remove_detached(directory.as_raw_fd(), &child_name)?;
    }
    if unsafe { libc::unlinkat(parent, name_c.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io_failure(
            std::io::Error::last_os_error(),
            "Remove workspace directory",
        ));
    }
    Ok(())
}

fn build_path_matcher(paths: &[String]) -> FileResult<Option<GlobSet>> {
    if paths.is_empty() || paths.iter().any(String::is_empty) {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for path in paths {
        validate_pattern(path)?;
        let has_meta = path
            .bytes()
            .any(|byte| matches!(byte, b'*' | b'?' | b'[' | b'{'));
        let patterns = if has_meta {
            vec![path.clone()]
        } else {
            vec![path.clone(), format!("{path}/**")]
        };
        for pattern in patterns {
            builder.add(
                GlobBuilder::new(&pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| {
                        FileFailure::coded(
                            "INVALID_ARGUMENT",
                            format!("Invalid grep path pattern: {error}"),
                        )
                    })?,
            );
        }
    }
    builder.build().map(Some).map_err(|error| {
        FileFailure::coded("INVALID_ARGUMENT", format!("Invalid grep paths: {error}"))
    })
}

struct PcreMatcher {
    code: *mut pcre2_code_8,
    match_data: *mut pcre2_match_data_8,
    context: *mut pcre2_match_context_8,
}

impl PcreMatcher {
    fn compile(pattern: &str, case_sensitive: bool) -> FileResult<Self> {
        let mut error_code = 0;
        let mut error_offset = 0usize;
        let options = PCRE2_UTF | PCRE2_UCP | if case_sensitive { 0 } else { PCRE2_CASELESS };
        let code = unsafe {
            pcre2_compile_8(
                pattern.as_ptr(),
                pattern.len(),
                options,
                &mut error_code,
                &mut error_offset,
                ptr::null_mut(),
            )
        };
        if code.is_null() {
            return Err(FileFailure::coded(
                "INVALID_ARGUMENT",
                format!(
                    "Invalid regular expression at byte {error_offset}: PCRE2 error {error_code}"
                ),
            ));
        }
        let match_data = unsafe { pcre2_match_data_create_from_pattern_8(code, ptr::null_mut()) };
        let context = unsafe { pcre2_match_context_create_8(ptr::null_mut()) };
        if match_data.is_null() || context.is_null() {
            unsafe {
                if !match_data.is_null() {
                    pcre2_match_data_free_8(match_data);
                }
                if !context.is_null() {
                    pcre2_match_context_free_8(context);
                }
                pcre2_code_free_8(code);
            }
            return Err(FileFailure::backend("Allocate PCRE2 matcher"));
        }
        unsafe {
            pcre2_set_match_limit_8(context, 1_000_000);
            pcre2_set_depth_limit_8(context, 10_000);
        }
        Ok(Self {
            code,
            match_data,
            context,
        })
    }

    fn find_from(&mut self, subject: &str, start: usize) -> FileResult<Option<(usize, usize)>> {
        let result = unsafe {
            pcre2_match_8(
                self.code,
                subject.as_ptr(),
                subject.len(),
                start,
                0,
                self.match_data,
                self.context,
            )
        };
        if result == PCRE2_ERROR_NOMATCH {
            return Ok(None);
        }
        if result == PCRE2_ERROR_MATCHLIMIT || result == PCRE2_ERROR_DEPTHLIMIT {
            return Err(FileFailure::coded(
                "REGEX_LIMIT",
                "Regular expression resource limit exceeded",
            ));
        }
        if result <= 0 {
            return Err(FileFailure::backend(format!(
                "PCRE2 match failed with code {result}"
            )));
        }
        let vector = unsafe { pcre2_get_ovector_pointer_8(self.match_data) };
        if vector.is_null() {
            return Err(FileFailure::backend("PCRE2 returned no match vector"));
        }
        Ok(Some(unsafe { (*vector, *vector.add(1)) }))
    }
}

impl Drop for PcreMatcher {
    fn drop(&mut self) {
        unsafe {
            pcre2_match_context_free_8(self.context);
            pcre2_match_data_free_8(self.match_data);
            pcre2_code_free_8(self.code);
        }
    }
}

enum PatternMatcher {
    Rust(Regex),
    Pcre(PcreMatcher),
}

impl PatternMatcher {
    fn compile(pattern: &str, case_sensitive: bool) -> FileResult<Self> {
        match RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .multi_line(true)
            .build()
        {
            Ok(regex) => Ok(Self::Rust(regex)),
            Err(_) => PcreMatcher::compile(pattern, case_sensitive).map(Self::Pcre),
        }
    }

    fn is_match(&mut self, subject: &str) -> FileResult<bool> {
        match self {
            Self::Rust(regex) => Ok(regex.is_match(subject)),
            Self::Pcre(regex) => regex.find_from(subject, 0).map(|value| value.is_some()),
        }
    }

    fn spans(&mut self, subject: &str) -> FileResult<Vec<(usize, usize)>> {
        match self {
            Self::Rust(regex) => Ok(regex
                .find_iter(subject)
                .map(|value| (value.start(), value.end()))
                .collect()),
            Self::Pcre(regex) => {
                let mut spans = Vec::new();
                let mut offset = 0usize;
                while offset <= subject.len() {
                    let Some((start, end)) = regex.find_from(subject, offset)? else {
                        break;
                    };
                    spans.push((start, end));
                    if end > offset {
                        offset = end;
                    } else if offset < subject.len() {
                        offset += subject[offset..].chars().next().map_or(1, char::len_utf8);
                    } else {
                        break;
                    }
                }
                Ok(spans)
            }
        }
    }
}

struct GrepAccumulator {
    limit: usize,
    cursor: Option<(String, u64)>,
    matches: Vec<GrepMatch>,
    total_matches: usize,
    truncated: bool,
    last_saved: Option<(String, u64)>,
}

impl GrepAccumulator {
    fn new(limit: usize, cursor: Option<(String, u64)>) -> Self {
        Self {
            limit,
            cursor,
            matches: Vec::new(),
            total_matches: 0,
            truncated: false,
            last_saved: None,
        }
    }

    fn add(&mut self, path: &str, byte_offset: u64, value: GrepMatch) -> FileResult<()> {
        self.total_matches += 1;
        if self.cursor.as_ref().is_some_and(|cursor| {
            match path.as_bytes().cmp(cursor.0.as_bytes()) {
                CmpOrdering::Less => true,
                CmpOrdering::Equal => byte_offset <= cursor.1,
                CmpOrdering::Greater => false,
            }
        }) {
            return Ok(());
        }
        if self.matches.len() >= self.limit {
            self.truncated = true;
            return Ok(());
        }
        let mut candidate = self.matches.clone();
        candidate.push(value.clone());
        let response = FileResponse {
            matches: Some(candidate),
            total_matches: Some(self.total_matches),
            skipped_files: Some(0),
            truncated: Some(false),
            ..FileResponse::default()
        };
        if serde_json::to_vec(&response)
            .map_err(|error| FileFailure::backend(format!("Encode grep response: {error}")))?
            .len()
            > MAX_SEARCH_RESPONSE_BYTES
        {
            self.truncated = true;
            return Ok(());
        }
        self.matches.push(value);
        self.last_saved = Some((path.to_owned(), byte_offset));
        Ok(())
    }
}

fn trim_line_ending(value: &str) -> &str {
    value
        .strip_suffix('\n')
        .unwrap_or(value)
        .strip_suffix('\r')
        .unwrap_or_else(|| value.strip_suffix('\n').unwrap_or(value))
}

fn line_offsets(text: &str) -> Vec<(usize, &str)> {
    let mut offset = 0usize;
    let mut lines = Vec::new();
    for line in text.split_inclusive('\n') {
        lines.push((offset, trim_line_ending(line)));
        offset += line.len();
    }
    if text.is_empty() {
        lines.clear();
    }
    lines
}

fn scan_buffer(
    path: &str,
    bytes: &[u8],
    matcher: &mut PatternMatcher,
    cross_line: bool,
    context_before: usize,
    context_after: usize,
    accumulator: &mut GrepAccumulator,
) -> FileResult<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        FileFailure::coded(
            "INVALID_ARGUMENT",
            format!("Grep file is not UTF-8: {path}"),
        )
    })?;
    let lines = line_offsets(text);
    let matched = if cross_line {
        let spans = matcher.spans(text)?;
        let mut indexes = BTreeSet::new();
        for (start, _) in spans {
            let index = lines
                .partition_point(|(offset, _)| *offset <= start)
                .saturating_sub(1);
            if index < lines.len() {
                indexes.insert(index);
            }
        }
        indexes.into_iter().collect::<Vec<_>>()
    } else {
        let mut indexes = Vec::new();
        for (index, (_, line)) in lines.iter().enumerate() {
            if matcher.is_match(line)? {
                indexes.push(index);
            }
        }
        indexes
    };
    for index in matched {
        let before_start = index.saturating_sub(context_before);
        let after_end = (index + 1 + context_after).min(lines.len());
        let before = (context_before > 0).then(|| {
            lines[before_start..index]
                .iter()
                .map(|(_, line)| (*line).to_owned())
                .collect()
        });
        let after = (context_after > 0).then(|| {
            lines[index + 1..after_end]
                .iter()
                .map(|(_, line)| (*line).to_owned())
                .collect()
        });
        accumulator.add(
            path,
            lines[index].0 as u64,
            GrepMatch {
                path: path.to_owned(),
                line: index + 1,
                text: lines[index].1.to_owned(),
                context_before: before,
                context_after: after,
            },
        )?;
    }
    Ok(())
}

struct PendingStreamMatch {
    byte_offset: u64,
    value: GrepMatch,
    remaining_after: usize,
}

fn scan_stream(
    path: &str,
    file: File,
    matcher: &mut PatternMatcher,
    context_before: usize,
    context_after: usize,
    accumulator: &mut GrepAccumulator,
) -> FileResult<()> {
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut line_number = 0usize;
    let mut byte_offset = 0u64;
    let mut before = VecDeque::new();
    let mut pending: VecDeque<PendingStreamMatch> = VecDeque::new();
    loop {
        line.clear();
        let count = reader
            .read_line(&mut line)
            .map_err(|error| io_failure(error, format!("Read grep file {path}")))?;
        if count == 0 {
            break;
        }
        line_number += 1;
        let text = trim_line_ending(&line).to_owned();
        for pending_match in pending.iter_mut() {
            if pending_match.remaining_after > 0 {
                pending_match
                    .value
                    .context_after
                    .get_or_insert_with(Vec::new)
                    .push(text.clone());
                pending_match.remaining_after -= 1;
            }
        }
        while pending
            .front()
            .is_some_and(|value| value.remaining_after == 0)
        {
            let ready = pending.pop_front().expect("pending match exists");
            accumulator.add(path, ready.byte_offset, ready.value)?;
        }
        if matcher.is_match(&text)? {
            let value = GrepMatch {
                path: path.to_owned(),
                line: line_number,
                text: text.clone(),
                context_before: (context_before > 0).then(|| before.iter().cloned().collect()),
                context_after: (context_after > 0).then(Vec::new),
            };
            if context_after == 0 {
                accumulator.add(path, byte_offset, value)?;
            } else {
                pending.push_back(PendingStreamMatch {
                    byte_offset,
                    value,
                    remaining_after: context_after,
                });
            }
        }
        before.push_back(text);
        while before.len() > context_before {
            before.pop_front();
        }
        byte_offset += count as u64;
    }
    while let Some(ready) = pending.pop_front() {
        accumulator.add(path, ready.byte_offset, ready.value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temporary_workspace() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("electrosphere-agent-test-{}", unique_suffix()));
        fs::create_dir_all(&path).expect("create test workspace");
        path
    }

    #[test]
    fn rejects_parent_and_symlink_escape() {
        let root = temporary_workspace();
        let outside = root
            .parent()
            .expect("workspace parent")
            .join(format!("outside-{}", unique_suffix()));
        fs::write(&outside, b"secret").expect("write outside file");
        symlink(&outside, root.join("escape")).expect("create escape symlink");
        let service = FileService::open(&root).expect("open file service");
        assert_eq!(
            service
                .file_read_bytes("../outside", 0, 8)
                .unwrap_err()
                .code,
            Some("PATH_OUTSIDE_WORKSPACE")
        );
        assert_eq!(
            service.file_read_bytes("escape", 0, 8).unwrap_err().code,
            Some("PATH_OUTSIDE_WORKSPACE")
        );
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn writes_aborts_and_edits_atomically() {
        let root = temporary_workspace();
        let mut service = FileService::open(&root).expect("open file service");
        service
            .file_write_begin("write-1".into(), "nested/file.txt".into(), true)
            .expect("begin write");
        service
            .file_write_chunk("write-1", &STANDARD.encode(b"one\ntwo\n"))
            .expect("write chunk");
        let committed = service.file_write_commit("write-1").expect("commit write");
        let digest = committed.digest.expect("write digest");
        service
            .file_edit(
                "nested/file.txt",
                &digest,
                vec![EditSpec {
                    kind: "replace".into(),
                    start_line: 2,
                    end_line: Some(2),
                    content: Some("changed\n".into()),
                }],
            )
            .expect("edit file");
        assert_eq!(
            fs::read_to_string(root.join("nested/file.txt")).expect("read edited file"),
            "one\nchanged\n"
        );
        service
            .file_write_begin("write-2".into(), "aborted.txt".into(), false)
            .expect("begin aborted write");
        service
            .file_write_chunk("write-2", &STANDARD.encode(b"discard"))
            .expect("write aborted chunk");
        service.file_write_abort("write-2").expect("abort write");
        assert!(!root.join("aborted.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn globs_greps_moves_removes_and_streams_snapshots() {
        let root = temporary_workspace();
        fs::write(root.join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        fs::write(root.join("ignored.txt"), "ignored\n").expect("write ignored file");
        fs::write(root.join("visible.txt"), "alpha\nbeta foobar\n").expect("write visible file");
        fs::write(root.join(".hidden.txt"), "hidden\n").expect("write hidden file");
        let mut service = FileService::open(&root).expect("open file service");

        let glob = service
            .file_glob(vec!["**/*.txt".into()], 10, None, true, false, "name")
            .expect("glob files");
        let paths = glob
            .entries
            .expect("glob entries")
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["visible.txt"]);

        let lookaround = service
            .file_grep(
                "foo(?=bar)",
                vec!["visible.txt".into()],
                10,
                None,
                true,
                1,
                0,
                true,
            )
            .expect("PCRE2 lookaround grep");
        assert_eq!(lookaround.total_matches, Some(1));
        assert_eq!(lookaround.matches.expect("grep matches")[0].line, 2);

        let multiline = service
            .file_grep(
                "alpha\\nbeta",
                vec!["visible.txt".into()],
                10,
                None,
                true,
                0,
                0,
                true,
            )
            .expect("multiline grep");
        assert_eq!(multiline.total_matches, Some(1));

        service
            .file_move("visible.txt", "moved.txt")
            .expect("move file");
        assert_eq!(
            service
                .file_stat("moved.txt")
                .expect("stat moved file")
                .stat_result
                .expect("stat result")
                .kind,
            "file"
        );
        service.file_remove("moved.txt").expect("remove file");
        assert!(service.file_stat("moved.txt").is_err());

        fs::write(root.join("snapshot.txt"), vec![b'x'; 900_000]).expect("write snapshot file");
        let begun = service
            .snapshot_begin("snapshot-1".into(), "cfs-v1")
            .expect("begin snapshot");
        let expected_size = begun.size.expect("snapshot size");
        let expected_digest = begun.digest.expect("snapshot digest");
        let mut offset = 0u64;
        let mut hasher = Sha256::new();
        while offset < expected_size {
            let chunk = service
                .snapshot_read("snapshot-1", offset, MAX_FILE_CHUNK_BYTES)
                .expect("read snapshot");
            let bytes = STANDARD
                .decode(chunk.data.expect("snapshot data"))
                .expect("decode snapshot data");
            assert!(!bytes.is_empty());
            hasher.update(&bytes);
            offset += bytes.len() as u64;
        }
        assert_eq!(offset, expected_size);
        assert_eq!(format!("sha256:{:x}", hasher.finalize()), expected_digest);
        service.snapshot_end("snapshot-1").expect("end snapshot");
        let _ = fs::remove_dir_all(root);
    }
}
