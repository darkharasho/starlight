//! Unique AOB signature builder (D22): forward-only, whole instructions, with position-dependent
//! bytes (RIP-relative displacements, rel32 branch offsets, address-like values) wildcarded.
use crate::aob::{self, Pattern};
use crate::disasm::{self, Insn};
use crate::maps;
use crate::mem;
use crate::modules;
use crate::process::Target;
use crate::rpc::RpcError;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, OpKind};

#[derive(Debug, Clone, PartialEq)]
pub struct Signature {
    /// Space-separated hex bytes with `??` wildcards.
    pub pattern: String,
    pub module: String,
    pub length: usize,
    pub unique: bool,
    pub matches: usize,
}

/// Largest match list kept for narrowing; beyond it the pattern is rescanned at the next step.
const MAX_CANDIDATES: usize = 4096;
/// Bound on full module scans per signature.
const MAX_SCANS: usize = 4;
/// Fewer fixed bytes than this are never worth a module scan.
const MIN_FIXED_BYTES: usize = 3;

/// Per byte of `bytes` (one decoded instruction), whether it must match exactly (`true`) or is
/// wildcarded (`false`). Wildcards: the displacement when the memory operand is RIP-relative or
/// the displacement looks like an address, an immediate that looks like an address, and the
/// offset of rel32 near branches. rel8 branches are kept.
pub fn wildcard_mask(insn: &Instruction, bytes: &[u8], looks_like_address: impl Fn(u64) -> bool) -> Vec<bool> {
    let mut keep = vec![true; bytes.len()];
    let mut dec = Decoder::with_ip(64, bytes, insn.ip(), DecoderOptions::NONE);
    let again = dec.decode();
    if again.is_invalid() {
        return keep;
    }
    let co = dec.get_constant_offsets(&again);
    let mut wild = |off: usize, size: usize| {
        for k in keep.iter_mut().skip(off).take(size) {
            *k = false;
        }
    };
    if co.has_displacement() && co.displacement_size() >= 4 {
        let disp = again.memory_displacement64();
        if again.is_ip_rel_memory_operand() || looks_like_address(disp) {
            wild(co.displacement_offset(), co.displacement_size());
        }
    }
    if co.has_immediate() {
        let is_branch = matches!(
            again.flow_control(),
            FlowControl::Call | FlowControl::UnconditionalBranch | FlowControl::ConditionalBranch
        ) && again.op0_kind() == OpKind::NearBranch64;
        if is_branch {
            if co.immediate_size() >= 4 {
                wild(co.immediate_offset(), co.immediate_size());
            }
        } else if co.immediate_size() >= 4 {
            let op = (0..again.op_count())
                .find(|&i| matches!(again.op_kind(i), OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64))
                .unwrap_or(0);
            let imm = if matches!(again.op_kind(op), OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64) {
                let v = again.immediate(op);
                if co.immediate_size() == 4 && again.op_kind(op) == OpKind::Immediate32 { v & 0xFFFF_FFFF } else { v }
            } else {
                0
            };
            if imm != 0 && looks_like_address(imm) {
                wild(co.immediate_offset(), co.immediate_size());
            }
        }
    }
    keep
}

fn pattern_text(parts: &[Option<u8>]) -> String {
    parts.iter().map(|b| b.map_or("??".to_string(), |b| format!("{b:02X}"))).collect::<Vec<_>>().join(" ")
}

/// Build a signature starting at `address`, adding whole instructions until it is unique in its
/// module or reaches `max_len` bytes. Not unique at the limit: returned with `unique: false`.
pub fn build(t: &Target, address: u64, max_len: usize) -> Result<Signature, RpcError> {
    let mods = modules::list(t)?;
    let m = mods
        .iter()
        .filter(|m| address >= m.base && address < m.base.saturating_add(m.size))
        .min_by_key(|m| m.size)
        .ok_or_else(|| RpcError::module_not_found(format!("address {address:#x} is not inside any module")))?;
    let range = (m.base, m.base.saturating_add(m.size));
    let regions = maps::read(t.pid).map_err(|e| RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)))?;
    let looks_like_address = |v: u64| regions.iter().any(|r| v >= r.start && v < r.end);

    let code = disasm::read_code(t, address, max_len + disasm::MAX_INSN_LEN)?;
    let insns: Vec<Insn> = disasm::decode(&code, address, max_len + disasm::MAX_INSN_LEN);
    let mut parts: Vec<Option<u8>> = vec![];
    let mut cands = Candidates::default();
    for insn in &insns {
        if insn.text.starts_with("db ") || (!parts.is_empty() && parts.len() + insn.length > max_len) {
            break;
        }
        let mut dec = Decoder::with_ip(64, &insn.bytes, insn.address, DecoderOptions::NONE);
        let ins = dec.decode();
        let keep = wildcard_mask(&ins, &insn.bytes, &looks_like_address);
        parts.extend(insn.bytes.iter().zip(&keep).map(|(&b, &k)| k.then_some(b)));
        if parts.iter().flatten().count() < MIN_FIXED_BYTES {
            continue;
        }
        cands.update(t, range, &parts)?;
        if cands.count == 1 {
            break;
        }
    }
    if parts.is_empty() {
        return Err(RpcError::read_failed(format!("no decodable instruction at {address:#x}")));
    }
    // Too few fixed bytes to have been scanned yet: scan once so `matches` is meaningful.
    if !cands.scanned && parts.iter().flatten().count() > 0 {
        cands.update(t, range, &parts)?;
    }
    Ok(Signature {
        pattern: pattern_text(&parts),
        module: m.name.clone(),
        length: parts.len(),
        unique: cands.count == 1,
        matches: cands.count,
    })
}

/// Tracks which module addresses still match the growing pattern. Scans the module only when
/// the list is unknown (first time, or the last scan overflowed `MAX_CANDIDATES`), at most
/// `MAX_SCANS` times; otherwise narrows the list by reading each candidate's bytes.
#[derive(Default)]
struct Candidates {
    /// Known full match list; `None` until scanned or after an overflow.
    list: Option<Vec<u64>>,
    scans: usize,
    scanned: bool,
    /// Current match count. Exact when `list` is known; after an overflow it is the capped count
    /// (a lower bound), and once the scan budget is spent it is the last known (stale) count.
    count: usize,
}

impl Candidates {
    fn update(&mut self, t: &Target, range: (u64, u64), parts: &[Option<u8>]) -> Result<(), RpcError> {
        let text = pattern_text(parts);
        let pattern = Pattern::parse(&text)?;
        if let Some(list) = &mut self.list {
            list.retain(|&a| mem::read_bytes(t, a, parts.len()).is_ok_and(|b| pattern.matches_window(&b)));
            self.count = list.len();
        } else if self.scans < MAX_SCANS {
            self.scans += 1;
            self.scanned = true;
            let found = aob::scan(t, range, &pattern, MAX_CANDIDATES + 1)?;
            if found.len() > MAX_CANDIDATES {
                self.count = found.len();
            } else {
                self.count = found.len();
                self.list = Some(found);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(bytes: &[u8], ip: u64, addr: impl Fn(u64) -> bool) -> Vec<bool> {
        let ins = Decoder::with_ip(64, bytes, ip, DecoderOptions::NONE).decode();
        wildcard_mask(&ins, bytes, addr)
    }

    #[test]
    fn rip_relative_displacement_is_wildcarded() {
        // mov eax,[rip+0x10]: opcode+modrm kept, 4 displacement bytes wildcarded.
        let m = mask(&[0x8B, 0x05, 0x10, 0, 0, 0], 0x1000, |_| false);
        assert_eq!(m, vec![true, true, false, false, false, false]);
    }

    #[test]
    fn rel32_call_is_wildcarded_rel8_jump_is_not() {
        let call = mask(&[0xE8, 0x0B, 0, 0, 0], 0x1000, |_| false);
        assert_eq!(call, vec![true, false, false, false, false]);
        let jmp = mask(&[0xEB, 0x05], 0x1000, |_| false);
        assert_eq!(jmp, vec![true, true]);
        let jcc = mask(&[0x0F, 0x84, 1, 0, 0, 0], 0x1000, |_| false);
        assert_eq!(jcc, vec![true, true, false, false, false, false]);
    }

    #[test]
    fn small_immediate_is_kept() {
        let m = mask(&[0x83, 0xC0, 0x01], 0x1000, |v| v >= 0x400000);
        assert_eq!(m, vec![true; 3]);
    }

    #[test]
    fn address_like_values_are_wildcarded_small_ones_kept() {
        // mov eax,[0x404040] (absolute disp32, SIB form): address-like displacement wildcarded.
        let abs = [0x8B, 0x04, 0x25, 0x40, 0x40, 0x40, 0x00];
        let m = mask(&abs, 0x1000, |v| (0x400000..0x500000).contains(&v));
        assert_eq!(m, vec![true, true, true, false, false, false, false]);
        assert_eq!(mask(&abs, 0x1000, |_| false), vec![true; 7]);
        // mov eax,0x404040 (imm32) wildcarded only when it looks like an address.
        let imm = [0xB8, 0x40, 0x40, 0x40, 0x00];
        assert_eq!(mask(&imm, 0, |v| (0x400000..0x500000).contains(&v)), vec![true, false, false, false, false]);
        assert_eq!(mask(&imm, 0, |_| false), vec![true; 5]);
        // [rsp+8] displacement is small and not RIP-relative: kept.
        assert_eq!(mask(&[0x48, 0x89, 0x4C, 0x24, 0x08], 0, |_| false), vec![true; 5]);
    }
}
