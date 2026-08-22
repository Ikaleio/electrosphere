use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

const MAGIC: &[u8] = b"CFS-v1\0";
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 1024 * 1024 * 1024;
const TYPE_DIRECTORY: u8 = 1;
const TYPE_FILE: u8 = 2;
const TYPE_SYMLINK: u8 = 3;
const TYPE_HARDLINK: u8 = 4;

struct SnapshotWriter {
    file: File,
    hasher: Sha256,
    size: u64,
}

impl SnapshotWriter {
    fn create(destination: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .with_context(|| format!("create {}", destination.display()))?;
        Ok(Self {
            file,
            hasher: Sha256::new(),
            size: 0,
        })
    }

    fn finish(mut self) -> Result<(u64, String)> {
        self.file.flush()?;
        self.file.sync_all()?;
        let size = self.size;
        let hash = self.hasher.finalize();
        Ok((size, format!("sha256:{hash:x}")))
    }
}

impl Write for SnapshotWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self
            .size
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| std::io::Error::other("snapshot exceeds total limit"))?;
        if next > MAX_TREE_BYTES {
            return Err(std::io::Error::other("snapshot exceeds total limit"));
        }
        self.file.write_all(buffer)?;
        self.hasher.update(buffer);
        self.size = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn validate_relative(path: &Path) -> Result<String> {
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        bail!("unsafe snapshot path");
    }
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() || value.as_bytes().contains(&0) {
        bail!("unsafe snapshot path");
    }
    Ok(value)
}

fn write_header(
    out: &mut SnapshotWriter,
    path: &str,
    kind: u8,
    mode: u32,
    mtime_ns: u64,
    payload_len: u64,
) -> Result<()> {
    out.write_all(&(path.len() as u32).to_be_bytes())?;
    out.write_all(path.as_bytes())?;
    out.write_all(&[kind])?;
    out.write_all(&mode.to_be_bytes())?;
    out.write_all(&mtime_ns.to_be_bytes())?;
    out.write_all(&payload_len.to_be_bytes())?;
    Ok(())
}

fn collect(root: &Path, directory: &Path, entries: &mut Vec<PathBuf>) -> Result<()> {
    let mut children = fs::read_dir(directory)
        .with_context(|| format!("read {}", directory.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    for child in children {
        let path = child.path();
        entries.push(path.clone());
        if fs::symlink_metadata(&path)?.is_dir() {
            collect(root, &path, entries)?;
        }
    }
    entries.sort_by(|left, right| {
        let left = left
            .strip_prefix(root)
            .unwrap_or(left)
            .as_os_str()
            .as_encoded_bytes();
        let right = right
            .strip_prefix(root)
            .unwrap_or(right)
            .as_os_str()
            .as_encoded_bytes();
        left.cmp(right)
    });
    Ok(())
}

pub fn export_workspace_file(root: &Path, destination: &Path) -> Result<(u64, String)> {
    let result = (|| {
        let mut paths = Vec::new();
        collect(root, root, &mut paths)?;
        let mut out = SnapshotWriter::create(destination)?;
        out.write_all(MAGIC)?;
        let mut hard_links: HashMap<(u64, u64), String> = HashMap::new();
        let mut buffer = [0u8; 64 * 1024];
        for absolute in paths {
            let relative = validate_relative(absolute.strip_prefix(root)?)?;
            let metadata = fs::symlink_metadata(&absolute)?;
            let mode = metadata.permissions().mode() & 0o7777;
            if mode & 0o6000 != 0 {
                bail!("setuid/setgid entry rejected: {relative}");
            }
            let raw_mtime_ns =
                metadata.mtime() as u64 * 1_000_000_000 + metadata.mtime_nsec() as u64;
            let mtime_ns = ((raw_mtime_ns + 500_000) / 1_000_000) * 1_000_000;
            if metadata.is_dir() {
                write_header(&mut out, &relative, TYPE_DIRECTORY, mode, mtime_ns, 0)?;
            } else if metadata.file_type().is_symlink() {
                let target = fs::read_link(&absolute)?;
                if target.is_absolute()
                    || target
                        .components()
                        .any(|part| matches!(part, Component::ParentDir))
                {
                    bail!("symlink target escapes workspace: {relative}");
                }
                let target = target.to_string_lossy();
                write_header(
                    &mut out,
                    &relative,
                    TYPE_SYMLINK,
                    mode,
                    mtime_ns,
                    target.len() as u64,
                )?;
                out.write_all(target.as_bytes())?;
            } else if metadata.is_file() {
                if metadata.len() > MAX_FILE_BYTES {
                    bail!("file exceeds snapshot limit: {relative}");
                }
                let key = (metadata.dev(), metadata.ino());
                if metadata.nlink() > 1 {
                    if let Some(target) = hard_links.get(&key) {
                        write_header(
                            &mut out,
                            &relative,
                            TYPE_HARDLINK,
                            mode,
                            mtime_ns,
                            target.len() as u64,
                        )?;
                        out.write_all(target.as_bytes())?;
                        continue;
                    }
                    hard_links.insert(key, relative.clone());
                }
                write_header(
                    &mut out,
                    &relative,
                    TYPE_FILE,
                    mode,
                    mtime_ns,
                    metadata.len(),
                )?;
                let mut file = File::open(&absolute)?;
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    out.write_all(&buffer[..count])?;
                }
            } else {
                bail!("unsupported snapshot entry: {relative}");
            }
        }
        out.finish()
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}
