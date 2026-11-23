//! x86-64 disassembly in Cheat Engine's text style (uppercase hex, no prefix, RIP-relative
//! operands shown as absolute addresses), so the assembler can parse the text back.
use crate::mem;
use crate::modules::Module;
use crate::process::Target;
use crate::rpc::RpcError;
use iced_x86::{Decoder, DecoderError, DecoderOptions, FlowControl, Formatter, IntelFormatter, OpKind};

/// Longest x86 instruction.
pub const MAX_INSN_LEN: usize = 15;
const PAGE: u64 = 4096;
/// How far back `instruction_before` looks for a decode anchor.
const BACK_WINDOW: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct Insn {
    pub address: u64,
    pub length: usize,
    pub bytes: Vec<u8>,
    pub text: String,
    /// Near branch destination or RIP-relative memory address.
    pub target: Option<u64>,
}

/// Names addresses as `<module>+0x<offset>` (lowercase hex offset).
pub struct Symbolizer {
    /// (base, end, name), sorted by base.
    ranges: Vec<(u64, u64, String)>,
}

impl Symbolizer {
    pub fn new(mods: &[Module]) -> Self {
        let mut ranges: Vec<_> =
            mods.iter().map(|m| (m.base, m.base.saturating_add(m.size), m.name.clone())).collect();
        ranges.sort_by_key(|r| r.0);
        Symbolizer { ranges }
    }

    pub fn name(&self, addr: u64) -> Option<String> {
        let i = self.ranges.partition_point(|r| r.0 <= addr);
        // Modules can nest (e.g. a PE mapped inside a larger mapping), so scan back for a hit.
        self.ranges[..i]
            .iter()
            .rev()
            .find(|r| addr < r.1)
            .map(|(base, _, name)| format!("{name}+{:#x}", addr - base))
    }
}

/// CE-style Intel formatter.
pub fn formatter() -> IntelFormatter {
    let mut f = IntelFormatter::new();
    let o = f.options_mut();
    o.set_uppercase_hex(true);
    o.set_hex_prefix("");
    o.set_hex_suffix("");
    o.set_leading_zeros(false);
    o.set_add_leading_zero_to_hex_numbers(false);
    o.set_small_hex_numbers_in_decimal(false);
    o.set_space_after_operand_separator(false);
    o.set_rip_relative_addresses(false);
    o.set_show_branch_size(false);
    o.set_branch_leading_zeros(false);
    o.set_displacement_leading_zeros(false);
    o.set_signed_memory_displacements(true);
    f
}

/// Decode up to `count` instructions from `bytes`, which start at `ip`. Undecodable bytes become
/// `db XX`. A final instruction cut off by the end of `bytes` is dropped, not reported as `db`.
pub fn decode(bytes: &[u8], ip: u64, count: usize) -> Vec<Insn> {
    let mut fmt = formatter();
    let mut dec = Decoder::with_ip(64, bytes, ip, DecoderOptions::NONE);
    let mut out = Vec::new();
    while out.len() < count && dec.can_decode() {
        let pos = dec.position();
        let ins = dec.decode();
        if ins.is_invalid() {
            if dec.last_error() == DecoderError::NoMoreBytes {
                break;
            }
            // The decoder may have consumed more than one byte; resume right after the bad one.
            let _ = dec.set_position(pos + 1);
            dec.set_ip(ip + (pos + 1) as u64);
            out.push(Insn {
                address: ip + pos as u64,
                length: 1,
                bytes: vec![bytes[pos]],
                text: format!("db {:02X}", bytes[pos]),
                target: None,
            });
            continue;
        }
        let mut text = String::new();
        fmt.format(&ins, &mut text);
        let target = if ins.is_ip_rel_memory_operand() {
            Some(ins.ip_rel_memory_address())
        } else if matches!(
            ins.flow_control(),
            FlowControl::Call | FlowControl::UnconditionalBranch | FlowControl::ConditionalBranch
        ) && ins.op_count() > 0
            && ins.op0_kind() == OpKind::NearBranch64
        {
            Some(ins.near_branch_target())
        } else {
            None
        };
        out.push(Insn {
            address: ins.ip(),
            length: ins.len(),
            bytes: bytes[pos..pos + ins.len()].to_vec(),
            text,
            target,
        });
    }
    out
}

/// Start of the instruction that ends exactly at `rip`, given `buf` = the bytes just before `rip`
/// (`buf` ends at `rip`). Forward-decodes from anchors in `buf`, earliest first, and takes the
/// last instruction of the first chain that lands exactly on `rip`; otherwise falls back to the
/// latest single instruction in `rip-15..rip-1` that ends at `rip`.
pub fn instruction_before_bytes(buf: &[u8], rip: u64) -> Option<u64> {
    let base = rip.checked_sub(buf.len() as u64)?;
    let len = buf.len();
    let first_anchor = len.saturating_sub(BACK_WINDOW);
    for anchor in first_anchor..len {
        let mut dec = Decoder::with_ip(64, &buf[anchor..], base + anchor as u64, DecoderOptions::NONE);
        let mut last = None;
        let mut ok = true;
        while dec.can_decode() {
            let at = dec.ip();
            let ins = dec.decode();
            if ins.is_invalid() {
                ok = false;
                break;
            }
            last = Some(at);
        }
        if ok {
            if let Some(start) = last {
                return Some(start);
            }
        }
    }
    for back in 1..=MAX_INSN_LEN.min(len) {
        let start = len - back;
        let mut dec = Decoder::with_ip(64, &buf[start..], base + start as u64, DecoderOptions::NONE);
        let ins = dec.decode();
        if !ins.is_invalid() && ins.len() == back {
            return Some(base + start as u64);
        }
    }
    None
}

/// Read the bytes preceding `rip` (shrinking to what's readable) and find the instruction ending at it.
pub fn instruction_before(t: &Target, rip: u64) -> Option<u64> {
    let want = BACK_WINDOW as u64 + MAX_INSN_LEN as u64;
    let want = want.min(rip);
    let buf = read_tail(t, rip, want).ok()?;
    instruction_before_bytes(&buf, rip)
}

/// Last `want` bytes before `end`, shrunk to the start of `end`'s page if that's all that's readable.
fn read_tail(t: &Target, end: u64, want: u64) -> Result<Vec<u8>, RpcError> {
    match mem::read_bytes(t, end - want, want as usize) {
        Ok(b) => Ok(b),
        Err(e) => {
            let in_page = end % PAGE;
            if in_page == 0 || in_page >= want {
                return Err(e);
            }
            mem::read_bytes(t, end - in_page, in_page as usize)
        }
    }
}

/// Read up to `len` bytes at `addr`, stopping at the first unreadable page. Fails only if nothing is readable.
pub fn read_code(t: &Target, addr: u64, len: usize) -> Result<Vec<u8>, RpcError> {
    let mut out = Vec::with_capacity(len);
    let mut cur = addr;
    while out.len() < len {
        let to_page = (PAGE - cur % PAGE) as usize;
        let n = to_page.min(len - out.len());
        match mem::read_bytes(t, cur, n) {
            Ok(b) => out.extend_from_slice(&b),
            Err(e) if out.is_empty() => return Err(e),
            Err(_) => break,
        }
        cur = match cur.checked_add(n as u64) {
            Some(c) => c,
            None => break,
        };
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: &[u8], ip: u64) -> String {
        decode(bytes, ip, 1)[0].text.clone()
    }

    #[test]
    fn formats_ce_style() {
        // RIP-relative: 0x1000 + 6 + 0x10 = 0x1016, shown absolute and uppercase.
        assert_eq!(text(&[0x8B, 0x05, 0x10, 0, 0, 0], 0x1000), "mov eax,[1016]");
        assert_eq!(text(&[0x48, 0x89, 0x4C, 0x24, 0x08], 0x1000), "mov [rsp+8],rcx");
        assert_eq!(text(&[0x48, 0x8D, 0x84, 0x24, 0xAB, 0x00, 0x00, 0x00], 0), "lea rax,[rsp+AB]");
    }

    #[test]
    fn branch_target_is_absolute_without_size() {
        let d = decode(&[0xE8, 0x0B, 0x00, 0x00, 0x00], 0x400000, 1);
        assert_eq!(d[0].text, "call 400010");
        assert_eq!(d[0].target, Some(0x400010));
        let d = decode(&[0x8B, 0x05, 0x10, 0, 0, 0], 0x1000, 1);
        assert_eq!(d[0].target, Some(0x1016));
        assert_eq!(decode(&[0x90], 0, 1)[0].target, None);
    }

    #[test]
    fn bad_byte_is_db() {
        let d = decode(&[0x06, 0x90], 0x2000, 2);
        assert_eq!(d[0].text, "db 06");
        assert_eq!(d[0].length, 1);
        assert_eq!(d[0].address, 0x2000);
        assert_eq!(d[1].text, "nop");
        assert_eq!(d[1].address, 0x2001);
    }

    #[test]
    fn truncated_tail_is_dropped() {
        let d = decode(&[0x90, 0x8B, 0x05, 0x10], 0, 5);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].text, "nop");
    }

    #[test]
    fn instruction_before_finds_start() {
        let mut buf = vec![0x90; 20];
        let mov = buf.len();
        buf.extend_from_slice(&[0x89, 0x05, 1, 2, 3, 4]);
        let rip = 0x5000 + buf.len() as u64;
        assert_eq!(instruction_before_bytes(&buf, rip), Some(0x5000 + mov as u64));
        // A trailing instruction after it moves the answer to that one.
        buf.push(0xC3);
        assert_eq!(instruction_before_bytes(&buf, rip + 1), Some(rip));
    }

    #[test]
    fn symbolizer_names_module_offsets() {
        let m = |name: &str, base, size| Module {
            name: name.into(),
            base,
            size,
            path: String::new(),
            kind: crate::modules::Kind::Elf,
        };
        let s = Symbolizer::new(&[m("b.so", 0x20000, 0x1000), m("a", 0x1000, 0x2000)]);
        assert_eq!(s.name(0x1010).as_deref(), Some("a+0x10"));
        assert_eq!(s.name(0x20ABC).as_deref(), Some("b.so+0xabc"));
        assert_eq!(s.name(0x3000), None);
        assert_eq!(s.name(0x10), None);
    }
}
