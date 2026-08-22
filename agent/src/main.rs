mod cfs;
mod file_ops;

use anyhow::{bail, Context, Result};
use file_ops::{
    EditSpec, Entry, FailureDetails, FileFailure, FileResponse, FileService, GrepMatch, StatResult,
};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::{getegid, geteuid, getpid, setgid, setuid, Gid, Pid, Uid};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct LineRange {
    start: usize,
    end: usize,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Request {
    Exec {
        #[serde(rename = "executionId")]
        execution_id: String,
        command: String,
        cwd: String,
        env: HashMap<String, String>,
        tty: bool,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
    },
    Write {
        #[serde(rename = "executionId")]
        execution_id: String,
        chars: String,
    },
    Poll {
        #[serde(rename = "executionId")]
        execution_id: String,
    },
    Kill {
        #[serde(rename = "executionId")]
        execution_id: String,
        #[serde(rename = "graceMs")]
        grace_ms: Option<u64>,
    },
    FileRead {
        path: String,
        offset: Option<usize>,
        limit: Option<usize>,
        ranges: Option<Vec<LineRange>>,
        cursor: Option<String>,
    },
    FileReadBytes {
        path: String,
        offset: u64,
        limit: usize,
    },
    FileWriteBegin {
        #[serde(rename = "transferId")]
        transfer_id: String,
        path: String,
        #[serde(rename = "createParents")]
        create_parents: bool,
    },
    FileWriteChunk {
        #[serde(rename = "transferId")]
        transfer_id: String,
        data: String,
    },
    FileWriteCommit {
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
    FileWriteAbort {
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
    FileEdit {
        path: String,
        #[serde(rename = "expectedDigest")]
        expected_digest: String,
        edits: Vec<EditSpec>,
    },
    FileGlob {
        patterns: Vec<String>,
        limit: Option<usize>,
        cursor: Option<String>,
        gitignore: Option<bool>,
        hidden: Option<bool>,
        sort: Option<String>,
    },
    FileGrep {
        pattern: String,
        paths: Option<Vec<String>>,
        limit: Option<usize>,
        cursor: Option<String>,
        #[serde(rename = "caseSensitive")]
        case_sensitive: Option<bool>,
        #[serde(rename = "contextBefore")]
        context_before: Option<usize>,
        #[serde(rename = "contextAfter")]
        context_after: Option<usize>,
        gitignore: Option<bool>,
    },
    FileStat {
        path: String,
    },
    FileMove {
        source: String,
        destination: String,
    },
    FileRemove {
        path: String,
    },
    SnapshotBegin {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
        format: String,
    },
    SnapshotRead {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
        offset: u64,
        limit: usize,
    },
    SnapshotEnd {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
    },
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_omitted_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Entry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matches: Option<Vec<GrepMatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stat_result: Option<StatResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_matches: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_directory: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eof: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<FailureDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines_after: Option<usize>,
}

#[derive(Default)]
struct OutputBuffer {
    bytes: Vec<u8>,
    total: usize,
}

impl OutputBuffer {
    fn append(&mut self, chunk: &[u8]) {
        self.total = self.total.saturating_add(chunk.len());
        if self.total <= MAX_OUTPUT_BYTES {
            self.bytes.extend_from_slice(chunk);
            return;
        }
        let side = MAX_OUTPUT_BYTES / 2;
        let mut combined = Vec::with_capacity(self.bytes.len() + chunk.len());
        combined.extend_from_slice(&self.bytes);
        combined.extend_from_slice(chunk);
        self.bytes.clear();
        self.bytes
            .extend_from_slice(&combined[..side.min(combined.len())]);
        let suffix_start = combined
            .len()
            .saturating_sub(side)
            .max(side.min(combined.len()));
        self.bytes.extend_from_slice(&combined[suffix_start..]);
    }

    fn snapshot(&self) -> (Vec<u8>, usize, usize) {
        (
            self.bytes.clone(),
            self.total,
            self.total.saturating_sub(self.bytes.len()),
        )
    }
}

struct Execution {
    child: Child,
    output: Arc<Mutex<OutputBuffer>>,
    drains: Vec<thread::JoinHandle<()>>,
    started: Instant,
    timeout: Option<Duration>,
    tty: bool,
}

fn response_ok(
    execution_id: Option<String>,
    state: Option<String>,
    exit_code: Option<i32>,
    output: Option<String>,
) -> Response {
    Response {
        ok: true,
        execution_id,
        state,
        exit_code,
        output,
        ..Response::default()
    }
}

fn response_error(error: impl ToString) -> Response {
    Response {
        ok: false,
        error: Some(error.to_string()),
        ..Response::default()
    }
}

fn response_error_code(code: &str, error: impl ToString) -> Response {
    let mut response = response_error(error);
    response.error_code = Some(code.to_owned());
    response
}

fn response_file(result: std::result::Result<FileResponse, FileFailure>) -> Response {
    match result {
        Ok(value) => Response {
            ok: true,
            lines: value.lines,
            entries: value.entries,
            matches: value.matches,
            stat_result: value.stat_result,
            total_matches: value.total_matches,
            next_offset: value.next_offset,
            skipped_files: value.skipped_files,
            is_directory: value.is_directory,
            data: value.data,
            size: value.size,
            digest: value.digest,
            eof: value.eof,
            truncated: value.truncated,
            next_cursor: value.next_cursor,
            lines_before: value.lines_before,
            lines_after: value.lines_after,
            ..Response::default()
        },
        Err(error) => Response {
            ok: false,
            error: Some(error.message),
            error_code: error.code.map(str::to_owned),
            details: error.details,
            ..Response::default()
        },
    }
}

fn response_with_output(mut response: Response, output: &Arc<Mutex<OutputBuffer>>) -> Response {
    let (bytes, total, omitted) = output.lock().expect("output lock").snapshot();
    response.output = Some(String::from_utf8_lossy(&bytes).into_owned());
    response.original_bytes = Some(total);
    response.output_omitted_bytes = Some(omitted);
    response
}

fn read_frame(input: &mut impl Read) -> Result<Option<Request>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length > 1024 * 1024 {
        bail!("agent frame too large");
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(serde_json::from_slice(&payload)?))
}

fn write_frame(output: &mut impl Write, response: &Response) -> Result<()> {
    let payload = serde_json::to_vec(response)?;
    output.write_all(&(payload.len() as u32).to_be_bytes())?;
    output.write_all(&payload)?;
    output.flush()?;
    Ok(())
}

fn drain(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<OutputBuffer>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => output.lock().expect("output lock").append(&buffer[..count]),
            }
        }
    })
}

fn valid_cwd(cwd: &str) -> bool {
    cwd == "/workspace" || cwd.starts_with("/workspace/")
}

fn spawn_execution(
    command: String,
    cwd: String,
    env: HashMap<String, String>,
    tty: bool,
    timeout_ms: u64,
) -> Result<Execution> {
    if !valid_cwd(&cwd) {
        bail!("cwd must be inside /workspace");
    }
    if env.len() > 128 || env.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > 64 * 1024 {
        bail!("environment is too large");
    }
    let mut process = Command::new("/bin/sh");
    process.arg("-lc").arg(command).current_dir(cwd).env_clear();
    for (key, value) in env {
        process.env(key, value);
    }
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        process.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if geteuid().is_root() {
                setgid(Gid::from_raw(1000)).map_err(io::Error::other)?;
                setuid(Uid::from_raw(1000)).map_err(io::Error::other)?;
            }
            Ok(())
        });
    }
    let mut child = process.spawn().context("spawn command")?;
    let output = Arc::new(Mutex::new(OutputBuffer::default()));
    let mut drains = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        drains.push(drain(stdout, output.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        drains.push(drain(stderr, output.clone()));
    }
    Ok(Execution {
        child,
        output,
        drains,
        started: Instant::now(),
        timeout: (timeout_ms > 0).then(|| Duration::from_millis(timeout_ms)),
        tty,
    })
}

fn workspace_exhausted() -> bool {
    let path = match CString::new("/workspace") {
        Ok(path) => path,
        Err(_) => return false,
    };
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    result == 0 && unsafe { stats.assume_init() }.f_bavail == 0
}

fn join_drains(execution: &mut Execution) {
    for drain in execution.drains.drain(..) {
        let _ = drain.join();
    }
}

fn poll_execution(id: &str, execution: &mut Execution) -> Result<Response> {
    if execution
        .timeout
        .is_some_and(|timeout| execution.started.elapsed() >= timeout)
    {
        let _ = kill(
            Pid::from_raw(-(execution.child.id() as i32)),
            Signal::SIGKILL,
        );
        let _ = execution.child.wait();
        join_drains(execution);
        return Ok(response_with_output(
            response_ok(Some(id.to_owned()), Some("TIMED_OUT".into()), None, None),
            &execution.output,
        ));
    }
    let status = execution.child.try_wait()?;
    if status.is_some() {
        join_drains(execution);
    }
    if status.as_ref().is_some_and(|value| !value.success()) && workspace_exhausted() {
        return Ok(response_error_code(
            "STORAGE_EXHAUSTED",
            "workspace disk is full",
        ));
    }
    Ok(response_with_output(
        response_ok(
            Some(id.to_owned()),
            Some(
                if status.is_some() {
                    "COMPLETED"
                } else {
                    "RUNNING"
                }
                .into(),
            ),
            status.and_then(|value| value.code()),
            None,
        ),
        &execution.output,
    ))
}

fn kill_execution(id: &str, execution: &mut Execution, grace_ms: u64) -> Result<Response> {
    let process_group = Pid::from_raw(-(execution.child.id() as i32));
    let _ = kill(process_group, Signal::SIGTERM);
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    loop {
        if let Some(status) = execution.child.try_wait()? {
            join_drains(execution);
            return Ok(response_with_output(
                response_ok(
                    Some(id.to_owned()),
                    Some("CANCELED".into()),
                    status.code(),
                    None,
                ),
                &execution.output,
            ));
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = kill(process_group, Signal::SIGKILL);
    let status = execution.child.wait()?;
    join_drains(execution);
    Ok(response_with_output(
        response_ok(
            Some(id.to_owned()),
            Some("CANCELED".into()),
            status.code(),
            None,
        ),
        &execution.output,
    ))
}
fn mount_fs(
    source: Option<&str>,
    target: &str,
    filesystem: &str,
    flags: libc::c_ulong,
) -> Result<()> {
    fs::create_dir_all(target)?;
    let source = source.map(CString::new).transpose()?;
    let target = CString::new(target)?;
    let filesystem = CString::new(filesystem)?;
    let result = unsafe {
        libc::mount(
            source
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            target.as_ptr(),
            filesystem.as_ptr(),
            flags,
            std::ptr::null(),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error()).context("mount guest filesystem");
    }
    Ok(())
}

fn guest_vsock_connection() -> Result<Option<(File, File)>> {
    if getpid().as_raw() != 1 {
        return Ok(None);
    }
    let command_line = match fs::read_to_string("/proc/cmdline") {
        Ok(command_line) => command_line,
        Err(_) => {
            mount_fs(Some("proc"), "/proc", "proc", 0)?;
            fs::read_to_string("/proc/cmdline").unwrap_or_default()
        }
    };
    if !command_line
        .split_whitespace()
        .any(|value| value == "electrosphere.firecracker=1")
    {
        return Ok(None);
    }

    mount_fs(Some("devtmpfs"), "/dev", "devtmpfs", 0)?;
    mount_fs(Some("/dev/vda"), "/newroot", "ext4", libc::MS_RDONLY)?;
    mount_fs(Some("/dev/vdb"), "/newroot/workspace", "ext4", 0)?;
    nix::unistd::chroot("/newroot")?;
    nix::unistd::chdir("/")?;
    mount_fs(Some("proc"), "/proc", "proc", 0)?;
    mount_fs(Some("sysfs"), "/sys", "sysfs", libc::MS_RDONLY)?;
    mount_fs(Some("devtmpfs"), "/dev", "devtmpfs", 0)?;
    mount_fs(
        Some("tmpfs"),
        "/tmp",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
    )?;
    let _ = mount_fs(Some("cgroup2"), "/sys/fs/cgroup", "cgroup2", 0);

    let listener =
        unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if listener < 0 {
        return Err(io::Error::last_os_error()).context("create vsock listener");
    }
    let address = libc::sockaddr_vm {
        svm_family: libc::AF_VSOCK as libc::sa_family_t,
        svm_reserved1: 0,
        svm_port: 5000,
        svm_cid: libc::VMADDR_CID_ANY,
        svm_zero: [0; 4],
    };
    let bound = unsafe {
        libc::bind(
            listener,
            &address as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        )
    };
    if bound != 0 || unsafe { libc::listen(listener, 1) } != 0 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(listener) };
        return Err(error).context("bind vsock listener");
    }
    let connection = unsafe {
        libc::accept4(
            listener,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            libc::SOCK_CLOEXEC,
        )
    };
    unsafe { libc::close(listener) };
    if connection < 0 {
        return Err(io::Error::last_os_error()).context("accept vsock connection");
    }
    let reader = unsafe { libc::dup(connection) };
    if reader < 0 {
        unsafe { libc::close(connection) };
        return Err(io::Error::last_os_error()).context("duplicate vsock connection");
    }
    Ok(Some(unsafe {
        (File::from_raw_fd(reader), File::from_raw_fd(connection))
    }))
}

fn main() -> Result<()> {
    let stopping = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGINT, stopping.clone())?;
    signal_hook::flag::register(signal_hook::consts::SIGTERM, stopping.clone())?;
    let _identity = (geteuid(), getegid());
    let (mut input, mut output): (Box<dyn Read>, Box<dyn Write>) = match guest_vsock_connection()? {
        Some((reader, writer)) => (Box::new(reader), Box::new(writer)),
        None => (Box::new(io::stdin()), Box::new(io::stdout())),
    };
    let mut executions: HashMap<String, Execution> = HashMap::new();
    let mut files =
        FileService::open("/workspace").map_err(|error| anyhow::anyhow!(error.message))?;
    while let Some(request) = read_frame(&mut input)? {
        let response = match request {
            Request::Exec {
                execution_id,
                command,
                cwd,
                env,
                tty,
                timeout_ms,
            } => {
                if executions.contains_key(&execution_id) {
                    response_error("execution already exists")
                } else if executions.len() >= 64 {
                    response_error("session capacity reached")
                } else {
                    match spawn_execution(command, cwd, env, tty, timeout_ms) {
                        Ok(execution) => {
                            executions.insert(execution_id.clone(), execution);
                            response_ok(Some(execution_id), Some("RUNNING".into()), None, None)
                        }
                        Err(error) => response_error(error),
                    }
                }
            }
            Request::Write {
                execution_id,
                chars,
            } => match executions.get_mut(&execution_id) {
                Some(execution) if execution.tty => match execution.child.stdin.as_mut() {
                    Some(stdin) => match stdin
                        .write_all(chars.as_bytes())
                        .and_then(|_| stdin.flush())
                    {
                        Ok(()) => {
                            response_ok(Some(execution_id), Some("RUNNING".into()), None, None)
                        }
                        Err(error) => response_error(error),
                    },
                    None => response_error("stdin closed"),
                },
                Some(_) => response_error("non-TTY stdin is closed"),
                None => response_error("execution unavailable"),
            },
            Request::Poll { execution_id } => match executions.get_mut(&execution_id) {
                Some(execution) => {
                    poll_execution(&execution_id, execution).unwrap_or_else(response_error)
                }
                None => response_error("execution unavailable"),
            },
            Request::Kill {
                execution_id,
                grace_ms,
            } => match executions.get_mut(&execution_id) {
                Some(execution) => {
                    kill_execution(&execution_id, execution, grace_ms.unwrap_or(1_000))
                        .unwrap_or_else(response_error)
                }
                None => response_error("execution unavailable"),
            },
            Request::FileRead {
                path,
                offset,
                limit,
                ranges,
                cursor,
            } => response_file(files.file_read(
                &path,
                offset,
                limit,
                ranges.map(|values| {
                    values
                        .into_iter()
                        .map(|value| (value.start, value.end))
                        .collect()
                }),
                cursor.as_deref(),
            )),
            Request::FileReadBytes {
                path,
                offset,
                limit,
            } => response_file(files.file_read_bytes(&path, offset, limit)),
            Request::FileWriteBegin {
                transfer_id,
                path,
                create_parents,
            } => response_file(files.file_write_begin(transfer_id, path, create_parents)),
            Request::FileWriteChunk { transfer_id, data } => {
                response_file(files.file_write_chunk(&transfer_id, &data))
            }
            Request::FileWriteCommit { transfer_id } => {
                response_file(files.file_write_commit(&transfer_id))
            }
            Request::FileWriteAbort { transfer_id } => {
                response_file(files.file_write_abort(&transfer_id))
            }
            Request::FileEdit {
                path,
                expected_digest,
                edits,
            } => response_file(files.file_edit(&path, &expected_digest, edits)),
            Request::FileGlob {
                patterns,
                limit,
                cursor,
                gitignore,
                hidden,
                sort,
            } => response_file(files.file_glob(
                patterns,
                limit.unwrap_or(1_000),
                cursor.as_deref(),
                gitignore.unwrap_or(true),
                hidden.unwrap_or(false),
                sort.as_deref().unwrap_or("name"),
            )),
            Request::FileGrep {
                pattern,
                paths,
                limit,
                cursor,
                case_sensitive,
                context_before,
                context_after,
                gitignore,
            } => response_file(files.file_grep(
                &pattern,
                paths.unwrap_or_default(),
                limit.unwrap_or(1_000),
                cursor.as_deref(),
                case_sensitive.unwrap_or(true),
                context_before.unwrap_or(0),
                context_after.unwrap_or(0),
                gitignore.unwrap_or(true),
            )),
            Request::FileStat { path } => response_file(files.file_stat(&path)),
            Request::FileMove {
                source,
                destination,
            } => response_file(files.file_move(&source, &destination)),
            Request::FileRemove { path } => response_file(files.file_remove(&path)),
            Request::SnapshotBegin {
                snapshot_id,
                format,
            } => response_file(files.snapshot_begin(snapshot_id, &format)),
            Request::SnapshotRead {
                snapshot_id,
                offset,
                limit,
            } => response_file(files.snapshot_read(&snapshot_id, offset, limit)),
            Request::SnapshotEnd { snapshot_id } => response_file(files.snapshot_end(&snapshot_id)),
        };
        write_frame(&mut output, &response)?;
    }
    if getpid().as_raw() == 1 {
        while !stopping.load(Ordering::Relaxed) {
            loop {
                match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
                    Ok(WaitStatus::StillAlive) | Err(nix::errno::Errno::ECHILD) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    for execution in executions.values_mut() {
        let _ = kill(
            Pid::from_raw(-(execution.child.id() as i32)),
            Signal::SIGKILL,
        );
        let _ = execution.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn accepts_chunked_file_and_snapshot_requests() {
        let write: Request = serde_json::from_str(
            r#"{"type":"FileWriteBegin","transferId":"transfer-1","path":"file.txt","createParents":true}"#,
        )
        .expect("deserialize file write begin");
        assert!(matches!(
            write,
            Request::FileWriteBegin {
                create_parents: true,
                ..
            }
        ));

        let snapshot: Request = serde_json::from_str(
            r#"{"type":"SnapshotRead","snapshotId":"snapshot-1","offset":0,"limit":393216}"#,
        )
        .expect("deserialize snapshot read");
        assert!(matches!(
            snapshot,
            Request::SnapshotRead {
                offset: 0,
                limit: 393216,
                ..
            }
        ));

        let kill: Request = serde_json::from_str(r#"{"type":"Kill","executionId":"execution-1"}"#)
            .expect("deserialize kill");
        assert!(matches!(kill, Request::Kill { grace_ms: None, .. }));
    }
}
