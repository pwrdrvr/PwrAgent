//! Port of PwrAgent's Unix peer admission probes, MIT, Copyright (c) 2026 PwrDrvr LLC.
use crate::{denied, unix};
use std::{io::{self, Write as _}, os::fd::RawFd};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Process {
    pid: libc::pid_t,
    parent: libc::pid_t,
    generation: u64,
    #[cfg(target_os = "macos")]
    parent_generation: u64,
    #[cfg(target_os = "macos")]
    pid_version: u32,
}

pub fn root(pid: libc::pid_t) -> io::Result<()> {
    let process = process(pid)?;
    // SAFETY: getppid takes no arguments.
    if process.parent != unsafe { libc::getppid() } {
        return Err(denied("agent runtime is not a live owner child"));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::{fd::AsRawFd as _, unix::net::UnixStream};
        let (local, _) = UnixStream::pair()?;
        drop(pidfd(local.as_raw_fd())?);
    }
    writeln!(io::stdout().lock(), "{}:{}", process.pid, process.generation)
}

pub fn ancestry(fd: RawFd) -> io::Result<()> {
    unix::check_peer(fd)?;
    #[cfg(target_os = "macos")]
    let audit = unix::socket_option(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, [0u32; 8])?;
    #[cfg(target_os = "macos")]
    let pid = audit[5] as libc::pid_t;
    #[cfg(target_os = "linux")]
    let connected = pidfd(fd)?;
    #[cfg(target_os = "linux")]
    let pid = unix::socket_option(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, libc::ucred { pid: 0, uid: 0, gid: 0 })?.pid;
    let first = process(pid)?;
    #[cfg(target_os = "macos")]
    if first.pid_version != audit[7] { return Err(denied("connected peer PID generation changed")); }
    let mut chain = vec![first];
    while chain.len() < 5 {
        let child = *chain.last().expect("peer checked first");
        let Ok(parent) = process(child.parent) else { break };
        #[cfg(target_os = "macos")]
        if child.parent_generation != parent.generation { break; }
        #[cfg(target_os = "linux")]
        if parent.generation > child.generation { break; }
        chain.push(parent);
    }
    // Parentage can change during observation, so verify the entire chain
    // before emitting any identity. Linux also holds the connected peer pidfd.
    for observed in chain.iter().rev() {
        if *observed != process(observed.pid)? { return Err(denied("peer ancestry changed")); }
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd as _;
        let mut check = libc::pollfd { fd: connected.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: check is one writable pollfd.
        if unsafe { libc::poll(&mut check, 1, 0) } != 0 {
            return Err(denied("connected peer is no longer live"));
        }
    }
    let mut output = io::stdout().lock();
    for entry in chain { writeln!(output, "{}:{}", entry.pid, entry.generation)?; }
    Ok(())
}

#[cfg(target_os = "macos")]
fn process(pid: libc::pid_t) -> io::Result<Process> {
    use std::mem::{MaybeUninit, size_of};
    // XNU's proc_info_private.h defines flavor 18. Missing or changed
    // records are unsupported. No PID-only fallback is sufficient.
    #[repr(C)]
    struct Snapshot {
        bsd: libc::proc_bsdinfo,
        executable_uuid: [u8; 16],
        unique_id: u64,
        parent_unique_id: u64,
        pid_version: u32,
        original_parent_version: u32,
        reserved: [u64; 2],
    }
    if pid <= 1 { return Err(denied("invalid process identity")); }
    let mut snapshot = MaybeUninit::<Snapshot>::uninit();
    let expected = size_of::<Snapshot>() as libc::c_int;
    // SAFETY: the kernel receives the correct writable size, and we only
    // read the result when it reports exactly that size.
    let actual = unsafe { libc::proc_pidinfo(pid, 18, 0, snapshot.as_mut_ptr().cast(), expected) };
    if actual != expected { return Err(denied("cannot read process generation")); }
    let snapshot = unsafe { snapshot.assume_init() };
    if snapshot.bsd.pbi_pid != pid as u32 || snapshot.bsd.pbi_uid != unix::uid()
        || snapshot.bsd.pbi_status == 5 || snapshot.unique_id == 0
    {
        return Err(denied("process identity is unavailable"));
    }
    Ok(Process {
        pid, parent: snapshot.bsd.pbi_ppid as libc::pid_t,
        generation: snapshot.unique_id, parent_generation: snapshot.parent_unique_id,
        pid_version: snapshot.pid_version,
    })
}

#[cfg(target_os = "linux")]
fn pidfd(fd: RawFd) -> io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::{FromRawFd as _, OwnedFd};
    let descriptor = unix::socket_option(fd, libc::SOL_SOCKET, libc::SO_PEERPIDFD, -1)?;
    if descriptor < 0 { return Err(denied("connected peer pidfd is unavailable")); }
    // SAFETY: SO_PEERPIDFD returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn process(pid: libc::pid_t) -> io::Result<Process> {
    use std::{fs::File, io::Read as _, os::unix::fs::MetadataExt as _};
    if pid <= 1 { return Err(denied("invalid process identity")); }
    let stat = File::open(format!("/proc/{pid}/stat"))?;
    if stat.metadata()?.uid() != unix::uid() { return Err(denied("process has a different owner")); }
    let mut data = Vec::with_capacity(4096);
    stat.take(4096).read_to_end(&mut data)?;
    if data.len() == 4096 { return Err(denied("process stat exceeds its bound")); }
    let (parent, generation) = parse_linux_stat(&data).ok_or_else(|| denied("invalid or exited process"))?;
    Ok(Process { pid, parent, generation })
}

#[cfg(target_os = "linux")]
fn parse_linux_stat(data: &[u8]) -> Option<(libc::pid_t, u64)> {
    // comm can contain spaces, newlines, non-UTF-8 bytes and parentheses.
    let end = data.iter().rposition(|&byte| byte == b')')?;
    let mut fields = std::str::from_utf8(&data[end + 1..]).ok()?.split_ascii_whitespace();
    let state = fields.next()?;
    if matches!(state, "Z" | "X") { return None; }
    let parent = fields.next()?.parse().ok()?;
    let generation = fields.nth(17)?.parse().ok()?;
    (generation != 0).then_some((parent, generation))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::parse_linux_stat;

    #[test]
    fn proc_stat_uses_the_last_parenthesis_and_the_original_start_time_field() {
        let mut stat = b"123 (\xff) comm\n)) S 42".to_vec();
        for _ in 5..22 { stat.extend_from_slice(b" 0"); }
        stat.extend_from_slice(b" 987 0\n");
        assert_eq!(parse_linux_stat(&stat), Some((42, 987)));
        assert!(parse_linux_stat(b"123 (process) Z 42").is_none());
    }
}
