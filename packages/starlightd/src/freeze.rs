//! Freeze loops: one thread per freeze rewrites a value until cancelled.
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MIN_INTERVAL_MS: u64 = 10;
pub const MAX_INTERVAL_MS: u64 = 3_600_000;
const STOP_POLL: Duration = Duration::from_millis(20);

struct Entry {
    /// The freeze's teardown action in the connection's `cleanup::Owner`.
    token: Option<u64>,
    /// Held across the stop check and the write, so once `stop` returns no further write happens.
    stopped: Arc<Mutex<bool>>,
}

/// Freezes of one connection, shared with their teardown actions.
#[derive(Clone, Default)]
pub struct Freezes {
    inner: Arc<Mutex<(u32, HashMap<u32, Entry>)>>,
}

/// Writes `data`, or with a `mask` only its masked bits: the other bits keep what memory holds
/// (bit fields share their bytes with other values).
fn write(target: &Target, addr: u64, data: &[u8], mask: Option<&[u8]>) -> Result<(), RpcError> {
    let Some(mask) = mask else { return mem::write_bytes(target, addr, data) };
    let cur = mem::read_bytes(target, addr, data.len())?;
    let merged: Vec<u8> = cur.iter().zip(data).zip(mask).map(|((c, d), m)| (c & !m) | (d & m)).collect();
    mem::write_bytes(target, addr, &merged)
}

impl Freezes {
    /// Write once synchronously (failure creates no freeze), then keep writing on a thread.
    /// `mask` (same length as `data`) limits the freeze to its set bits.
    pub fn start(&self, target: Arc<Target>, addr: u64, data: Vec<u8>, mask: Option<Vec<u8>>, interval_ms: u64) -> Result<u32, RpcError> {
        if interval_ms > MAX_INTERVAL_MS {
            return Err(RpcError::invalid_params(format!("interval_ms exceeds {MAX_INTERVAL_MS}")));
        }
        if mask.as_ref().is_some_and(|m| m.len() != data.len()) {
            return Err(RpcError::invalid_params("mask must be as long as bytes"));
        }
        write(&target, addr, &data, mask.as_deref())?;
        let interval = Duration::from_millis(interval_ms.max(MIN_INTERVAL_MS));
        let stopped = Arc::new(Mutex::new(false));
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.0 += 1;
            let id = g.0;
            g.1.insert(id, Entry { token: None, stopped: stopped.clone() });
            id
        };
        std::thread::spawn(move || {
            let mut next = Instant::now() + interval;
            loop {
                // Sleep in short slices so a cancelled freeze releases its target promptly.
                while Instant::now() < next {
                    if *stopped.lock().unwrap() {
                        return;
                    }
                    std::thread::sleep(STOP_POLL.min(next.saturating_duration_since(Instant::now())));
                }
                let guard = stopped.lock().unwrap();
                if *guard {
                    return;
                }
                let _ = write(&target, addr, &data, mask.as_deref()); // errors are ignored by design
                drop(guard);
                next = Instant::now() + interval;
            }
        });
        Ok(id)
    }

    pub fn set_token(&self, id: u32, token: u64) {
        if let Some(e) = self.inner.lock().unwrap().1.get_mut(&id) {
            e.token = Some(token);
        }
    }

    /// Stop a freeze; returns its teardown token, if one was set.
    pub fn stop(&self, id: u32) -> Result<Option<u64>, RpcError> {
        match self.inner.lock().unwrap().1.remove(&id) {
            Some(e) => {
                *e.stopped.lock().unwrap() = true;
                Ok(e.token)
            }
            None => Err(RpcError::invalid_params(format!("unknown freeze id: {id}"))),
        }
    }
}
