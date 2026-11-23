//! Freeze loops: one thread per freeze rewrites a value until cancelled.
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MIN_INTERVAL_MS: u64 = 10;
const STOP_POLL: Duration = Duration::from_millis(20);

struct Entry {
    handle: u32,
    stop: Arc<AtomicBool>,
}

/// Freezes of one connection, shared with the exit watcher threads.
#[derive(Clone, Default)]
pub struct Freezes {
    inner: Arc<Mutex<(u32, HashMap<u32, Entry>)>>,
}

impl Freezes {
    /// Write once synchronously (failure creates no freeze), then keep writing on a thread.
    pub fn start(&self, handle: u32, target: Arc<Target>, addr: u64, data: Vec<u8>, interval_ms: u64) -> Result<u32, RpcError> {
        mem::write_bytes(&target, addr, &data)?;
        let interval = Duration::from_millis(interval_ms.max(MIN_INTERVAL_MS));
        let stop = Arc::new(AtomicBool::new(false));
        let id = {
            let mut g = self.inner.lock().unwrap();
            g.0 += 1;
            let id = g.0;
            g.1.insert(id, Entry { handle, stop: stop.clone() });
            id
        };
        std::thread::spawn(move || {
            let mut next = Instant::now() + interval;
            loop {
                // Sleep in short slices so a cancelled freeze releases its target promptly.
                while Instant::now() < next {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    std::thread::sleep(STOP_POLL.min(next.saturating_duration_since(Instant::now())));
                }
                if stop.load(Ordering::Acquire) {
                    return;
                }
                let _ = mem::write_bytes(&target, addr, &data); // errors are ignored by design
                next = Instant::now() + interval;
            }
        });
        Ok(id)
    }

    pub fn stop(&self, id: u32) -> Result<(), RpcError> {
        match self.inner.lock().unwrap().1.remove(&id) {
            Some(e) => {
                e.stop.store(true, Ordering::Release);
                Ok(())
            }
            None => Err(RpcError::invalid_params(format!("unknown freeze id: {id}"))),
        }
    }

    pub fn stop_handle(&self, handle: u32) {
        self.inner.lock().unwrap().1.retain(|_, e| {
            if e.handle == handle {
                e.stop.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
    }

    pub fn stop_all(&self) {
        for (_, e) in self.inner.lock().unwrap().1.drain() {
            e.stop.store(true, Ordering::Release);
        }
    }
}
