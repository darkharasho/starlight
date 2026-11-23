mod aob;
mod cleanup;
mod freeze;
mod maps;
mod mem;
mod modules;
mod peer;
mod pointer;
mod process;
mod rpc;

use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

fn parse_socket_arg() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--socket" {
            return args.next().map(PathBuf::from);
        }
        if let Some(v) = a.strip_prefix("--socket=") {
            return Some(PathBuf::from(v));
        }
    }
    None
}

fn main() {
    // Before any other thread starts, so every thread inherits the blocked signal mask.
    cleanup::spawn_signal_thread();
    let Some(path) = parse_socket_arg() else {
        eprintln!("usage: starlightd --socket <path>");
        std::process::exit(2);
    };
    let _ = std::fs::remove_file(&path);
    // Bind under a restrictive umask so the socket never exists with looser permissions.
    let old_umask = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(&path);
    unsafe { libc::umask(old_umask) };
    let listener = match bound {
        Ok(l) => l,
        Err(e) => {
            eprintln!("starlightd: bind {}: {e}", path.display());
            std::process::exit(1);
        }
    };
    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("starlightd: chmod {}: {e}", path.display());
        std::process::exit(1);
    }

    // Exit when the parent closes our stdin, after reverting every change to every game.
    std::thread::spawn(|| {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin();
        while let Ok(n) = stdin.read(&mut sink) {
            if n == 0 {
                break;
            }
        }
        cleanup::shutdown_all(cleanup::SHUTDOWN_DEADLINE);
        std::process::exit(0);
    });

    println!("READY 1");

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if !peer::peer_allowed(peer::peer_pid(&stream), peer::parent_pid()) {
            // Dropping the stream hangs up on the caller.
            continue;
        }
        std::thread::spawn(move || serve(stream));
    }
}

fn serve(stream: std::os::unix::net::UnixStream) {
    let Ok(reader_stream) = stream.try_clone() else { return };
    let session = rpc::Session::new(rpc::Conn::new(stream));
    for line in BufReader::new(reader_stream).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        session.handle_line(&line);
    }
    session.close();
}
