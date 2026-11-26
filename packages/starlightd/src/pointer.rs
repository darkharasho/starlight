//! Pointer-chain resolution with Cheat Engine semantics.
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;

/// `base` is already module-adjusted. Each offset is applied after reading a pointer at the
/// current address (`addr = *addr + offset`), so the final result is an address, not a value.
/// With no offsets the result is `base` itself. `size` is the pointer size (4 or 8); with 4, every
/// step reads 4 bytes and wraps at 32 bits, as Cheat Engine does for 32-bit games.
pub fn resolve(t: &Target, base: u64, offsets: &[u64], size: usize) -> Result<u64, RpcError> {
    resolve_with(base, offsets, size, |a| read_pointer(t, a, size))
}

/// A `size`-byte pointer at `addr`, zero-extended.
pub fn read_pointer(t: &Target, addr: u64, size: usize) -> Result<u64, RpcError> {
    let b = mem::read_bytes(t, addr, size)?;
    let mut buf = [0u8; 8];
    buf[..size].copy_from_slice(&b[..size]);
    Ok(u64::from_le_bytes(buf))
}

fn resolve_with(base: u64, offsets: &[u64], size: usize, read: impl Fn(u64) -> Result<u64, RpcError>) -> Result<u64, RpcError> {
    let mask = if size == 4 { 0xFFFF_FFFF } else { u64::MAX };
    let mut addr = base & mask;
    for (i, off) in offsets.iter().enumerate() {
        let p = read(addr).map_err(|e| RpcError::read_failed(format!("pointer chain step {i}: {}", e.message)))?;
        addr = p.wrapping_add(*off) & mask;
    }
    Ok(addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_byte_steps_wrap_at_32_bits() {
        let read = |a: u64| if a == 0x1000 { Ok(0xFFFF_FFF0) } else { Err(RpcError::read_failed("x")) };
        assert_eq!(resolve_with(0x1000, &[0x20], 4, read).unwrap(), 0x10);
    }

    #[test]
    fn four_byte_read_zero_extends() {
        // The reader sees only 4 bytes; a high bit set stays a 32-bit address.
        let read = |a: u64| if a == 0x1000 { Ok(0x8000_0000) } else { Err(RpcError::read_failed("x")) };
        assert_eq!(resolve_with(0x1000, &[4], 4, read).unwrap(), 0x8000_0004);
    }

    #[test]
    fn no_offsets_returns_base() {
        assert_eq!(resolve_with(0x10, &[], 8, |_| unreachable!()).unwrap(), 0x10);
    }

    #[test]
    fn follows_chain_and_adds_offsets() {
        let read = |a: u64| match a {
            0x100 => Ok(0x200),
            0x208 => Ok(0x300),
            _ => Err(RpcError::read_failed("x")),
        };
        assert_eq!(resolve_with(0x100, &[8, 0x10], 8, read).unwrap(), 0x310);
    }

    #[test]
    fn failed_step_reports_index() {
        let e = resolve_with(0x100, &[0, 0], 8, |a| if a == 0x100 { Ok(0x500) } else { Err(RpcError::read_failed("boom")) }).unwrap_err();
        assert_eq!(e.code, -32003);
        assert!(e.message.contains("step 1"), "{}", e.message);
    }
}
