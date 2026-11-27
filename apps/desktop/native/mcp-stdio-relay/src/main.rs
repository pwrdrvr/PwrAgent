use std::{env, io, path::Path, process::ExitCode};

#[cfg(unix)]
mod peer;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

fn denied(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn greeting(grant: &str) -> io::Result<[u8; 53]> {
    if grant.len() != 43
        || !grant.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(denied("missing or invalid MCP registration grant"));
    }
    let mut bytes = [0; 53];
    bytes[..9].copy_from_slice(b"PWA-MCP1 ");
    bytes[9..52].copy_from_slice(grant.as_bytes());
    bytes[52] = b'\n';
    Ok(bytes)
}

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [mode] if mode == "--version" => {
            use std::io::Write as _;
            writeln!(io::stdout().lock(), "pwragent-mcp-stdio-relay {}", env!("CARGO_PKG_VERSION"))
        }
        [mode, endpoint] if mode == "--codex-stdio" => {
            let grant = env::var("PWRAGENT_CODEX_MCP_GRANT")
                .map_err(|_| denied("missing or invalid MCP registration grant"))?;
            let greeting = greeting(&grant)?;
            #[cfg(unix)]
            return unix::relay(Path::new(endpoint), &greeting);
            #[cfg(windows)]
            return windows::relay(Path::new(endpoint), &greeting);
        }
        #[cfg(unix)]
        [mode, pid] if mode == "--codex-root" => {
            let pid = pid.to_str().and_then(|pid| pid.parse().ok())
                .ok_or_else(|| denied("invalid owner child PID"))?;
            peer::root(pid)
        }
        #[cfg(unix)]
        [mode] if mode == "--codex-peer" => peer::ancestry(3),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid MCP relay arguments")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("MCP stdio relay: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_greeting_is_exact_and_cannot_add_a_line() {
        let grant = "-_0123456789abcdefghijklmnopqrstuvwxyzABCDE";
        assert_eq!(greeting(grant).unwrap().as_slice(), format!("PWA-MCP1 {grant}\n").as_bytes());
        assert!(greeting(&format!("\n{}", &grant[1..])).is_err());
        assert!(greeting(&grant[..42]).is_err());
    }
}
