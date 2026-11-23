//! Reading and writing another process's memory.
use crate::process::Target;
use crate::rpc::RpcError;
use std::os::unix::fs::FileExt;

/// Read exactly `len` bytes via `process_vm_readv`; anything short is `ReadFailed`.
pub fn read_bytes(t: &Target, addr: u64, len: usize) -> Result<Vec<u8>, RpcError> {
    let mut buf = vec![0u8; len];
    if len == 0 {
        return Ok(buf);
    }
    let local = libc::iovec { iov_base: buf.as_mut_ptr() as *mut libc::c_void, iov_len: len };
    let remote = libc::iovec { iov_base: addr as usize as *mut libc::c_void, iov_len: len };
    let n = unsafe { libc::process_vm_readv(t.pid, &local, 1, &remote, 1, 0) };
    if n < 0 {
        let e = std::io::Error::last_os_error();
        return Err(RpcError::read_failed(format!("read {len} bytes at {addr:#x}: {e}")));
    }
    if n as usize != len {
        return Err(RpcError::read_failed(format!("short read at {addr:#x}: {n} of {len} bytes")));
    }
    Ok(buf)
}

/// Write via `pwrite` on `/proc/<pid>/mem` (works on read-only pages).
pub fn write_bytes(t: &Target, addr: u64, data: &[u8]) -> Result<(), RpcError> {
    if addr > i64::MAX as u64 {
        return Err(RpcError::write_failed(format!("address {addr:#x} out of range")));
    }
    match t.mem.write_at(data, addr) {
        Ok(n) if n == data.len() => Ok(()),
        Ok(n) => Err(RpcError::write_failed(format!("short write at {addr:#x}: {n} of {} bytes", data.len()))),
        Err(e) => Err(RpcError::write_failed(format!("write at {addr:#x}: {e}"))),
    }
}
