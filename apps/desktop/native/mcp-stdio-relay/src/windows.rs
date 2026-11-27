//! Pipe connection, overlapped cancellation, and byte forwarding adapt
//! PwrGit's MIT relay (Copyright (c) 2026 PwrDrvr LLC), including its
//! PwrDisk-derived SID handling (see LICENSE-PwrDisk).
use crate::denied;
use std::{
    env, ffi::c_void,
    future::{Future as _, poll_fn},
    io,
    os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle},
    path::Path,
    pin::pin,
    ptr,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _, copy, split, stdin, stdout},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_BUSY, HANDLE, LocalFree, WAIT_TIMEOUT},
    Security::{
        Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT},
        GetTokenInformation, IsValidSid, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType, SECURITY_IDENTIFICATION, SYNCHRONIZE},
    System::{
        IO::CancelIoEx,
        Pipes::GetNamedPipeServerProcessId,
        Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, SetEvent, WaitForSingleObject},
    },
};

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this pointer came from a successful allocating Win32 API.
        unsafe { LocalFree(self.0) };
    }
}

// SAFETY: sid is a valid SID for the duration of this call.
unsafe fn sid_text(sid: *mut c_void) -> io::Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(denied("invalid Windows SID"));
    }
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _allocation = LocalAllocation(text.cast());
    let mut len = 0;
    // SAFETY: the successful call returned a terminated UTF-16 string.
    while unsafe { *text.add(len) } != 0 { len += 1; }
    Ok(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) }))
}

fn process_sid(process: HANDLE) -> io::Result<String> {
    let mut token = ptr::null_mut();
    // SAFETY: process is a live handle; token is an out pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut bytes = 0;
    // SAFETY: null output queries the required size only.
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &raw mut bytes) };
    if (bytes as usize) < size_of::<TOKEN_USER>() || bytes > 65_536 {
        return Err(denied("invalid process token size"));
    }
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    // SAFETY: TOKEN_USER fits in the aligned, writable buffer.
    if unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), bytes, &raw mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    unsafe { sid_text(user.User.Sid) }
}

fn pipe_owner(handle: HANDLE) -> io::Result<String> {
    let mut owner = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: Windows validates the handle; outputs are valid pointers.
    let status = unsafe {
        GetSecurityInfo(handle, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
            &raw mut owner, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), &raw mut descriptor)
    };
    if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    let _allocation = LocalAllocation(descriptor);
    unsafe { sid_text(owner) }
}

fn server_pid(pipe: HANDLE) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: pipe is a borrowed connected handle and pid is writable.
    if unsafe { GetNamedPipeServerProcessId(pipe, &raw mut pid) } == 0 || pid == 0 {
        return Err(denied("cannot verify connected pipe server process"));
    }
    Ok(pid)
}

fn verify_server(pipe: HANDLE, expected: u32) -> io::Result<OwnedHandle> {
    // SAFETY: these calls use open or pseudo process handles.
    if unsafe { GetFileType(pipe) } != FILE_TYPE_PIPE { return Err(denied("endpoint is not a pipe")); }
    let current_user = process_sid(unsafe { GetCurrentProcess() })?;
    if current_user != pipe_owner(pipe)? { return Err(denied("connected pipe belongs to another user")); }
    let pid = server_pid(pipe)?;
    if pid != expected { return Err(denied("unexpected MCP pipe server process")); }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if process.is_null() { return Err(io::Error::last_os_error()); }
    let owned = unsafe { OwnedHandle::from_raw_handle(process) };
    if current_user != process_sid(process)?
        || unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT
        || server_pid(pipe)? != pid
    {
        return Err(denied("connected pipe server identity changed"));
    }
    Ok(owned)
}

fn validate_path(path: &Path) -> io::Result<()> {
    let name = path.to_str().ok_or_else(|| denied("invalid local pipe name"))?;
    if let Some(suffix) = name.strip_prefix(r"\\.\pipe\")
        && !suffix.is_empty()
        && !suffix.contains(['\\', '/', ':', '?', '*', '"', '<', '>', '|', '\0'])
    {
        return Ok(());
    }
    Err(denied("expected a local Windows pipe name"))
}

// Explicitly cancel pending writes, since Tokio/Mio can keep them alive
// after dropping a pipe. A peer that stops reading must not hold the instance.
struct ConnectedPipe(NamedPipeClient);
impl Drop for ConnectedPipe {
    fn drop(&mut self) {
        // SAFETY: this handle remains open until after Drop returns.
        unsafe { CancelIoEx(self.0.as_raw_handle(), ptr::null()) };
    }
}

pub fn relay(path: &Path, greeting: &[u8]) -> io::Result<()> {
    validate_path(path)?;
    let expected = env::var("PWRAGENT_CODEX_MCP_SERVER_PID").ok()
        .and_then(|pid| pid.parse::<u32>().ok()).filter(|pid| *pid > 0)
        .ok_or_else(|| denied("missing expected MCP pipe server process"))?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let result = runtime.block_on(async {
        // Only wait if all instances are busy. No reconnect after admission.
        // SECURITY_IDENTIFICATION prevents a server impersonating the relay.
        let mut pipe = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match ClientOptions::new().security_qos_flags(SECURITY_IDENTIFICATION).open(path) {
                    Ok(pipe) => return Ok(ConnectedPipe(pipe)),
                    Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }).await??;
        let server = verify_server(pipe.0.as_raw_handle(), expected)?;
        let mut challenge = [0u8; 8];
        tokio::time::timeout(Duration::from_secs(3), pipe.0.read_exact(&mut challenge)).await??;
        // The owner duplicates this event into the actual connected process.
        // Signal it only after rechecking the authenticated pipe and PID.
        if unsafe { WaitForSingleObject(server.as_raw_handle(), 0) } != WAIT_TIMEOUT
            || server_pid(pipe.0.as_raw_handle())? != expected
        {
            return Err(denied("MCP pipe server exited during launch proof"));
        }
        let event = usize::try_from(u64::from_le_bytes(challenge))
            .ok().filter(|handle| *handle != 0).ok_or_else(|| denied("invalid MCP launch proof"))?
            as HANDLE;
        // SAFETY: only the authenticated listener supplies the duplicated
        // handle. Windows validates its type before signalling.
        if unsafe { SetEvent(event) } == 0 { return Err(io::Error::last_os_error()); }
        drop(unsafe { OwnedHandle::from_raw_handle(event) });
        pipe.0.write_all(greeting).await?;
        let (mut read, mut write) = split(&mut pipe.0);
        let mut input = stdin();
        let mut output = stdout();
        {
            let mut up = pin!(copy(&mut input, &mut write));
            let mut down = pin!(copy(&mut read, &mut output));
            poll_fn(|context| match up.as_mut().poll(context) {
                std::task::Poll::Pending => down.as_mut().poll(context),
                ready => ready,
            }).await?;
        }
        Ok(())
    });
    // Tokio stdin can own a blocking OS thread. Closing either direction
    // must end the relay even when the other direction is blocked.
    runtime.shutdown_background();
    result
}

#[cfg(test)]
mod tests {
    use super::validate_path;
    use std::path::Path;

    #[test]
    fn accepts_only_a_single_local_pipe_name() {
        assert!(validate_path(Path::new(r"\\.\pipe\pwragent-123")).is_ok());
        for value in [r"\\server\pipe\pwragent", r"\\.\pipe\directory\pipe", r"\\.\pipe\", r"\\.\pipe\pwragent?"] {
            assert!(validate_path(Path::new(value)).is_err(), "{value}");
        }
    }
}
