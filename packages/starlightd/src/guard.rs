//! Refusals for what would crash or misbehave on a game whose bitness the daemon can't handle yet.
//! Every check runs before any thread is stopped or any register is touched.
use crate::arch::Bits;
use crate::process::Target;
use crate::rpc::RpcError;

pub const SPEED_32: &str = "Game speed doesn't work with 32-bit games yet.";
pub const CODE_32: &str = "Changing code in 32-bit games isn't supported yet.";

/// Before a remote call (alloc, free, anything that runs a syscall inside the game).
pub fn remote(t: &Target) -> Result<(), RpcError> {
    remote_for(t.process_bits, t.code_bits())
}

fn remote_for(process_bits: Bits, code_bits: Option<Bits>) -> Result<(), RpcError> {
    let code = code_bits.ok_or_else(RpcError::target_not_ready)?;
    if process_bits == Bits::B32 || code == Bits::B32 {
        return Err(RpcError::unsupported_target(CODE_32));
    }
    Ok(())
}

/// Before speed_set / speed_get: the speed hooks are 64-bit code.
pub fn speed(t: &Target) -> Result<(), RpcError> {
    speed_for(t.code_bits())
}

fn speed_for(code_bits: Option<Bits>) -> Result<(), RpcError> {
    match code_bits {
        None => Err(RpcError::target_not_ready()),
        Some(Bits::B32) => Err(RpcError::unsupported_target(SPEED_32)),
        Some(Bits::B64) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_unknown_code_bits_is_not_ready() {
        assert_eq!(remote_for(Bits::B64, None).unwrap_err().code, -32016);
        assert_eq!(speed_for(None).unwrap_err().code, -32016);
    }

    #[test]
    fn guard_refuses_32_bit_code_and_processes() {
        assert_eq!(remote_for(Bits::B32, Some(Bits::B32)).unwrap_err().code, -32015);
        assert_eq!(remote_for(Bits::B64, Some(Bits::B32)).unwrap_err().code, -32015);
        assert!(remote_for(Bits::B64, Some(Bits::B64)).is_ok());
        let e = speed_for(Some(Bits::B32)).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (-32015, SPEED_32));
        assert!(speed_for(Some(Bits::B64)).is_ok());
    }
}
