//! Value scan sessions (D18/D19). Results stay in the daemon; only counts and pages cross the socket.
pub mod store;
pub mod value;

use crate::cleanup::{Owner, Teardown};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::{maps, mem, regions};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use store::{Geometry, Store};
use value::{Encoding, Matcher, ScanType};

/// `scan_first` params (besides `handle`).
#[derive(Debug, Deserialize)]
pub struct FirstReq {
    #[serde(rename = "type")]
    pub ty: String,
    pub mode: String,
    pub value: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
    pub encoding: Option<String>,
    pub alignment: Option<u64>,
}

/// `scan_next` params (besides `scan`).
#[derive(Debug, Deserialize)]
pub struct NextReq {
    pub mode: String,
    pub value: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
}

struct Session {
    target: Arc<Target>,
    ty: ScanType,
    encoding: Option<String>,
    geo: Geometry,
    /// Locked for the length of a next scan; another call meanwhile gets `Busy`.
    store: Mutex<Store>,
    /// Teardown token in the connection's owner (0 until registered).
    token: AtomicU64,
}

/// Scan sessions of one connection. Each belongs to the handle that started it.
pub struct Scans {
    owner: Arc<Owner>,
    inner: Arc<Mutex<(u32, HashMap<u32, Arc<Session>>)>>,
}

fn exited(t: &Target) -> RpcError {
    RpcError::process_not_found(format!("pid {} has exited", t.pid))
}

fn reader(t: &Target) -> impl Fn(u64, usize) -> Option<Vec<u8>> + Sync + '_ {
    move |addr, len| mem::read_bytes(t, addr, len).ok()
}

impl Scans {
    pub fn new(owner: Arc<Owner>) -> Self {
        Scans { owner, inner: Arc::new(Mutex::new((0, HashMap::new()))) }
    }

    /// Run a first scan on `t` and register the session under `handle`. Returns `(id, count)`.
    pub fn first(&self, t: Arc<Target>, handle: u32, req: FirstReq) -> Result<(u32, u64), RpcError> {
        let ty = ScanType::parse(&req.ty)?;
        let m = Matcher::first(ty, &req.mode, req.value.as_deref(), req.min.as_deref(), req.max.as_deref(), req.encoding.as_deref())?;
        let width = m.width();
        let align = match req.alignment {
            None => ty.size().map_or(1, |s| s.min(4)),
            Some(a) => {
                let a = a as usize;
                if a == 0 || !a.is_power_of_two() || a > store::MAX_ALIGN {
                    return Err(RpcError::invalid_params(format!("alignment must be a power of two up to {}", store::MAX_ALIGN)));
                }
                a
            }
        };
        let geo = Geometry { width, align };
        if t.exited() {
            return Err(exited(&t));
        }
        let ranges = regions::scannable(&maps::read(t.pid).map_err(|e| match e.raw_os_error() {
            Some(libc::ENOENT) | Some(libc::ESRCH) => exited(&t),
            _ => RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)),
        })?);
        let read = reader(&t);
        let store = if m.is_unknown() {
            let file = snapshot_file().map_err(|e| RpcError::internal_error(format!("scan snapshot file: {e}")))?;
            let mut s = Store::first_dense(&ranges, geo, &read, file).map_err(io_error)?;
            s.shrink(geo).map_err(io_error)?;
            s
        } else {
            Store::first_sparse(&ranges, geo, &read, &|cur| m.matches(cur, None))
        };
        if t.exited() {
            return Err(exited(&t));
        }
        let count = store.count();
        let session = Arc::new(Session {
            target: t.clone(),
            ty,
            encoding: req.encoding,
            geo,
            store: Mutex::new(store),
            token: AtomicU64::new(0),
        });
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.0 += 1;
            let id = g.0;
            g.1.insert(id, session.clone());
            id
        };
        // The teardown only drops the session (closing its snapshot file); it never touches the owner.
        let inner = self.inner.clone();
        let token = self.owner.add(Some(handle), Teardown::Scan, Box::new(move || {
            inner.lock().unwrap().1.remove(&id);
        }));
        session.token.store(token, Ordering::Relaxed);
        Ok((id, count))
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, RpcError> {
        self.inner.lock().unwrap().1.get(&id).cloned().ok_or_else(|| RpcError::unknown_id(format!("unknown scan: {id}")))
    }

    /// Narrow scan `id`. Returns the new count.
    pub fn next(&self, id: u32, req: NextReq) -> Result<u64, RpcError> {
        let s = self.get(id)?;
        let mut store = lock(&s.store)?;
        let m = Matcher::next(s.ty, &req.mode, req.value.as_deref(), req.min.as_deref(), req.max.as_deref(), s.encoding.as_deref())?;
        if m.width() != 0 && m.width() != s.geo.width {
            return Err(RpcError::invalid_params(format!("value must be {} bytes long, like the first scan's", s.geo.width)));
        }
        if s.target.exited() {
            return Err(exited(&s.target));
        }
        let read = reader(&s.target);
        store.next(s.geo, &read, &|cur, prev| m.matches(cur, Some(prev))).map_err(io_error)?;
        if s.target.exited() {
            return Err(exited(&s.target));
        }
        Ok(store.count())
    }

    /// The count, and candidates `offset .. offset + limit` with their current values
    /// (`None` if no longer readable).
    pub fn results(&self, id: u32, offset: u64, limit: usize) -> Result<(u64, Vec<(u64, Option<String>)>), RpcError> {
        let s = self.get(id)?;
        let (count, addrs) = {
            let store = lock(&s.store)?;
            (store.count(), store.page(s.geo, offset, limit))
        };
        if s.target.exited() {
            return Err(exited(&s.target));
        }
        let enc = Encoding::parse(s.encoding.as_deref())?;
        let results = addrs
            .into_iter()
            .map(|a| (a, mem::read_bytes(&s.target, a, s.geo.width).ok().map(|b| value::format_encoded(s.ty, enc, &b))))
            .collect();
        Ok((count, results))
    }

    /// End scan `id`, freeing its results.
    pub fn end(&self, id: u32) -> Result<(), RpcError> {
        let s = self.inner.lock().unwrap().1.remove(&id).ok_or_else(|| RpcError::unknown_id(format!("unknown scan: {id}")))?;
        self.owner.remove(s.token.load(Ordering::Relaxed));
        Ok(())
    }
}

fn lock(m: &Mutex<Store>) -> Result<std::sync::MutexGuard<'_, Store>, RpcError> {
    match m.try_lock() {
        Ok(g) => Ok(g),
        Err(TryLockError::WouldBlock) => Err(RpcError::busy("this scan is still running")),
        Err(TryLockError::Poisoned(p)) => Ok(p.into_inner()),
    }
}

fn io_error(e: std::io::Error) -> RpcError {
    RpcError::internal_error(format!("scan snapshot file: {e}"))
}

/// `$XDG_CACHE_HOME/starlight/scans`, falling back to `~/.cache/starlight/scans`.
fn cache_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("starlight").join("scans")
}

/// An unlinked read/write file in the cache dir: `O_TMPFILE`, or create + unlink where the
/// filesystem doesn't support it. It disappears when closed, even if the daemon is killed.
fn snapshot_file() -> std::io::Result<File> {
    let dir = cache_dir();
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    let tmp = OpenOptions::new().read(true).write(true).mode(0o600).custom_flags(libc::O_TMPFILE).open(&dir);
    if let Ok(f) = tmp {
        return Ok(f);
    }
    static N: AtomicU64 = AtomicU64::new(0);
    let path = dir.join(format!("scan-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let f = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path)?;
    std::fs::remove_file(&path)?;
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_scan_is_busy() {
        let m = Mutex::new(Store::Sparse { addrs: vec![1], prev: vec![0] });
        let held = m.lock().unwrap();
        assert_eq!(lock(&m).err().map(|e| e.code), Some(-32013));
        drop(held);
        assert_eq!(lock(&m).unwrap().count(), 1);
    }

    #[test]
    fn snapshot_file_is_unlinked_and_writable() {
        use std::os::unix::fs::FileExt;
        let f = snapshot_file().unwrap();
        f.write_all_at(b"abc", 4096).unwrap();
        let mut b = [0u8; 3];
        f.read_exact_at(&mut b, 4096).unwrap();
        assert_eq!(&b, b"abc");
        let link = std::fs::read_link(format!("/proc/self/fd/{}", std::os::fd::AsRawFd::as_raw_fd(&f))).unwrap();
        assert!(link.to_string_lossy().ends_with("(deleted)") || !link.exists(), "{link:?}");
    }
}
