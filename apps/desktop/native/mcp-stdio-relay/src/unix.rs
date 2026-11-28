//! Private-directory, socket-owner and connected-peer checks follow PwrGit's
//! MIT-licensed relay (Copyright (c) 2026 PwrDrvr LLC), with PwrAgent's
//! descriptor-based ancestor walk, ACL check and inode revalidation.
use crate::denied;
use std::{
    ffi::{CStr, CString},
    io::{self, Write as _},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd},
        unix::{ffi::OsStrExt as _, net::UnixStream},
    },
    path::Path,
};

pub fn uid() -> libc::uid_t {
    // SAFETY: no pointers or preconditions.
    unsafe { libc::geteuid() }
}

fn status(result: libc::c_int) -> io::Result<()> {
    if result < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn fd(result: RawFd) -> io::Result<OwnedFd> {
    status(result)?;
    // SAFETY: the successful open returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(result) })
}

fn stat_at(parent: RawFd, name: Option<&CStr>) -> io::Result<libc::stat> {
    let mut info = MaybeUninit::uninit();
    // SAFETY: the output is writable, and name is a NUL-terminated string.
    status(unsafe {
        match name {
            Some(name) => libc::fstatat(parent, name.as_ptr(), info.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW),
            None => libc::fstat(parent, info.as_mut_ptr()),
        }
    })?;
    Ok(unsafe { info.assume_init() })
}

fn protected_parent(path: &Path) -> io::Result<(OwnedFd, CString)> {
    let parts = path.as_os_str().as_bytes().strip_prefix(b"/")
        .ok_or_else(|| denied("use an absolute socket path"))?;
    let mut parts: Vec<_> = parts.split(|byte| *byte == b'/').collect();
    if parts.len() < 2 || parts.iter().any(|part| matches!(*part, b"" | b"." | b"..")) {
        return Err(denied("use a socket in a protected user directory"));
    }
    let name = CString::new(parts.pop().expect("checked nonempty path"))?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: open/openat use terminated strings and do not create files.
    let mut parent = fd(unsafe { libc::open(c"/".as_ptr(), flags) })?;
    for part in parts {
        let part = CString::new(part)?;
        parent = fd(unsafe { libc::openat(parent.as_raw_fd(), part.as_ptr(), flags) })?;
        let info = stat_at(parent.as_raw_fd(), None)?;
        #[cfg(target_os = "macos")]
        acl::check(Some(parent.as_raw_fd()), None)?;
        if info.st_uid != 0 && info.st_uid != uid() {
            return Err(denied("endpoint ancestor belongs to another user"));
        }
        if info.st_mode & 0o022 != 0 && !(info.st_uid == 0 && info.st_mode & libc::S_ISVTX != 0) {
            return Err(denied("endpoint ancestor is writable by another user"));
        }
    }
    let info = stat_at(parent.as_raw_fd(), None)?;
    if info.st_uid != uid() || info.st_mode & 0o077 != 0 {
        return Err(denied("socket parent must be private and owned by this user"));
    }
    Ok((parent, name))
}

fn socket_info(parent: &OwnedFd, name: &CStr) -> io::Result<libc::stat> {
    let info = stat_at(parent.as_raw_fd(), Some(name))?;
    if info.st_mode & libc::S_IFMT != libc::S_IFSOCK || info.st_mode & 0o077 != 0 || info.st_uid != uid() {
        return Err(denied("endpoint must be a private socket owned by this user"));
    }
    Ok(info)
}

pub fn socket_option<T: Copy>(descriptor: RawFd, level: libc::c_int, option: libc::c_int, mut value: T) -> io::Result<T> {
    let expected = std::mem::size_of::<T>() as libc::socklen_t;
    let mut size = expected;
    // SAFETY: this module supplies the argument type for each socket option.
    status(unsafe { libc::getsockopt(descriptor, level, option, (&raw mut value).cast(), &mut size) })?;
    if size != expected { return Err(denied("socket credentials have an unexpected size")); }
    Ok(value)
}

pub fn check_peer(descriptor: RawFd) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let peer = socket_option(descriptor, libc::SOL_SOCKET, libc::SO_PEERCRED, libc::ucred { pid: 0, uid: 0, gid: 0 })?.uid;
    #[cfg(target_os = "macos")]
    let peer = {
        let mut peer = 0;
        let mut gid = 0;
        // SAFETY: outputs are valid for the syscall.
        status(unsafe { libc::getpeereid(descriptor, &mut peer, &mut gid) })?;
        peer
    };
    if peer != uid() { return Err(denied("connected socket belongs to another user")); }
    Ok(())
}

fn connect(path: &Path) -> io::Result<UnixStream> {
    let (parent, name) = protected_parent(path)?;
    let before = socket_info(&parent, &name)?;
    #[cfg(target_os = "macos")]
    let acl_path = CString::new(path.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    acl::check(None, Some(&acl_path))?;
    let stream = UnixStream::connect(path)?;
    check_peer(stream.as_raw_fd())?;
    let pinned = socket_info(&parent, &name)?;
    let (again_parent, again_name) = protected_parent(path)?;
    let current = socket_info(&again_parent, &again_name)?;
    for after in [pinned, current] {
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) {
            return Err(denied("socket changed during connection"));
        }
    }
    #[cfg(target_os = "macos")]
    acl::check(None, Some(&acl_path))?;
    Ok(stream)
}

#[cfg(target_os = "macos")]
mod acl {
    use super::*;
    use std::ffi::{c_int, c_void};

    unsafe extern "C" {
        fn filesec_init() -> *mut c_void;
        fn filesec_free(value: *mut c_void);
        fn filesec_get_property(value: *mut c_void, property: c_int, output: *mut c_void) -> c_int;
        #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
        fn fstatx_np(fd: RawFd, info: *mut libc::stat, security: *mut c_void) -> c_int;
        #[cfg_attr(target_arch = "x86_64", link_name = "lstatx_np$INODE64")]
        fn lstatx_np(path: *const libc::c_char, info: *mut libc::stat, security: *mut c_void) -> c_int;
        fn acl_valid(acl: *mut c_void) -> c_int;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
        fn acl_free(acl: *mut c_void) -> c_int;
    }

    struct FileSec(*mut c_void);
    impl Drop for FileSec {
        fn drop(&mut self) { unsafe { filesec_free(self.0) }; }
    }
    struct Acl(*mut c_void);
    impl Drop for Acl {
        fn drop(&mut self) { unsafe { acl_free(self.0) }; }
    }

    pub fn check(fd: Option<RawFd>, path: Option<&CStr>) -> io::Result<()> {
        const FILESEC_ACL: c_int = 5;
        const ACL_FIRST_ENTRY: c_int = 0;
        const ACL_NEXT_ENTRY: c_int = -1;
        const ACL_EXTENDED_ALLOW: c_int = 1;
        // SAFETY: all pointers are either live OS allocations or call outputs.
        unsafe {
            let security = filesec_init();
            if security.is_null() { return Err(io::Error::last_os_error()); }
            let security = FileSec(security);
            let mut info = MaybeUninit::uninit();
            status(match (fd, path) {
                (Some(fd), _) => fstatx_np(fd, info.as_mut_ptr(), security.0),
                (_, Some(path)) => lstatx_np(path.as_ptr(), info.as_mut_ptr(), security.0),
                _ => return Err(denied("missing endpoint for ACL check")),
            })?;
            let mut acl = std::ptr::null_mut::<c_void>();
            if filesec_get_property(security.0, FILESEC_ACL, (&raw mut acl).cast()) != 0 {
                let error = io::Error::last_os_error();
                // ENOENT after a successful statx means the ACL is absent.
                return if error.raw_os_error() == Some(libc::ENOENT) { Ok(()) } else { Err(error) };
            }
            if acl.is_null() { return Err(denied("missing endpoint ACL")); }
            let acl = Acl(acl);
            status(acl_valid(acl.0))?;
            let mut entry = std::ptr::null_mut();
            let mut result = acl_get_entry(acl.0, ACL_FIRST_ENTRY, &mut entry);
            while result == 0 {
                let mut tag = 0;
                status(acl_get_tag_type(entry, &mut tag))?;
                if tag == ACL_EXTENDED_ALLOW { return Err(denied("endpoint has an extended allow ACL")); }
                result = acl_get_entry(acl.0, ACL_NEXT_ENTRY, &mut entry);
            }
            // Darwin reports EINVAL when there is no next entry.
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINVAL) { return Err(error); }
        }
        Ok(())
    }
}

struct Buffer {
    bytes: [u8; 16384],
    start: usize,
    end: usize,
}

impl Buffer {
    fn new() -> Self { Self { bytes: [0; 16384], start: 0, end: 0 } }
    fn empty(&self) -> bool { self.start == self.end }

    fn read(&mut self, fd: RawFd) -> io::Result<bool> {
        // SAFETY: the provided buffer is writable for this length.
        let n = unsafe { libc::read(fd, self.bytes.as_mut_ptr().cast(), self.bytes.len()) };
        if n < 0 { return transient().map(|()| true); }
        self.start = 0;
        self.end = n as usize;
        Ok(n > 0)
    }

    fn write(&mut self, fd: RawFd) -> io::Result<()> {
        let bytes = &self.bytes[self.start..self.end];
        // SAFETY: bytes is readable for this length.
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 { return transient(); }
        if n == 0 { return Err(io::ErrorKind::WriteZero.into()); }
        self.start += n as usize;
        Ok(())
    }
}

fn transient() -> io::Result<()> {
    let error = io::Error::last_os_error();
    if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) { Ok(()) } else { Err(error) }
}

fn nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: both operations use the documented flags argument.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    status(flags)?;
    status(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) })
}

pub fn relay(path: &Path, greeting: &[u8]) -> io::Result<()> {
    use libc::{POLLERR, POLLHUP, POLLIN, POLLNVAL, POLLOUT, STDIN_FILENO as INPUT, STDOUT_FILENO as OUTPUT};
    let mut stream = connect(path)?;
    stream.write_all(greeting)?;
    let sock = stream.as_raw_fd();
    for fd in [sock, INPUT, OUTPUT] { nonblocking(fd)?; }
    let event = |fd, events| libc::pollfd { fd, events, revents: 0 };
    let (mut up, mut down) = (Buffer::new(), Buffer::new());
    loop {
        let mut events = [
            event(if up.empty() { INPUT } else { -1 }, POLLIN),
            event(sock, if down.empty() { POLLIN } else { 0 } | if up.empty() { 0 } else { POLLOUT }),
            event(if down.empty() { -1 } else { OUTPUT }, POLLOUT),
        ];
        // SAFETY: poll receives a writable array of exactly three entries.
        if unsafe { libc::poll(events.as_mut_ptr(), events.len() as libc::nfds_t, -1) } < 0 {
            transient()?;
            continue;
        }
        let [input, socket, output] = events.map(|entry| entry.revents);
        if output & POLLOUT != 0 { down.write(OUTPUT)?; }
        if socket & POLLOUT != 0 { up.write(sock)?; }
        if input & (POLLIN | POLLHUP) != 0 && up.empty() && !up.read(INPUT)? { return Ok(()); }
        if socket & (POLLIN | POLLHUP) != 0 && down.empty() && !down.read(sock)? { return Ok(()); }
        if (input | socket | output) & (POLLERR | POLLNVAL) != 0 || output & POLLHUP != 0 {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::connect;
    use std::{
        fs,
        os::unix::{fs::{symlink, DirBuilderExt as _, PermissionsExt as _}, net::UnixListener},
    };

    #[test]
    fn only_connects_to_the_private_socket_at_the_verified_path() {
        let root = fs::canonicalize("/tmp").unwrap().join(format!("pwa-rust-relay-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let path = root.join("owner.sock");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(connect(&path).is_ok());
        let alias = root.join("alias.sock");
        symlink(&path, &alias).unwrap();
        assert!(connect(&alias).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap();
        assert!(connect(&path).is_err());
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }
}
