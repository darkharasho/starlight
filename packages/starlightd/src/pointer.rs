//! Pointer-chain resolution with Cheat Engine semantics.
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;

/// `base` is already module-adjusted. Each offset is applied after reading a pointer at the
/// current address (`addr = *addr + offset`), so the final result is an address, not a value.
/// With no offsets the result is `base` itself.
pub fn resolve(t: &Target, base: u64, offsets: &[u64]) -> Result<u64, RpcError> {
    resolve_with(base, offsets, |a| mem::read_bytes(t, a, 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())))
}

fn resolve_with(base: u64, offsets: &[u64], read_u64: impl Fn(u64) -> Result<u64, RpcError>) -> Result<u64, RpcError> {
    let mut addr = base;
    for (i, off) in offsets.iter().enumerate() {
        let p = read_u64(addr).map_err(|e| RpcError::read_failed(format!("pointer chain step {i}: {}", e.message)))?;
        addr = p.wrapping_add(*off);
    }
    Ok(addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_offsets_returns_base() {
        assert_eq!(resolve_with(0x10, &[], |_| unreachable!()).unwrap(), 0x10);
    }

    #[test]
    fn follows_chain_and_adds_offsets() {
        let read = |a: u64| match a {
            0x100 => Ok(0x200),
            0x208 => Ok(0x300),
            _ => Err(RpcError::read_failed("x")),
        };
        assert_eq!(resolve_with(0x100, &[8, 0x10], read).unwrap(), 0x310);
    }

    #[test]
    fn failed_step_reports_index() {
        let e = resolve_with(0x100, &[0, 0], |a| if a == 0x100 { Ok(0x500) } else { Err(RpcError::read_failed("boom")) }).unwrap_err();
        assert_eq!(e.code, -32003);
        assert!(e.message.contains("step 1"), "{}", e.message);
    }
}
