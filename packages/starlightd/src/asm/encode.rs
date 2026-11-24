//! Statements → machine code: operand matching against iced's `Code` table (D1) and layout with
//! `BlockEncoder`.
//!
//! Layout: every block entry (an instruction or a ≤16-byte data chunk) gets a placeholder IP in
//! the kernel half of the address space, which no user-space target can equal. Branches and
//! RIP-relative operands that name a label (with no offset) point at the placeholder of the entry
//! after the label, and
//! `BlockEncoder` relocates them and picks short or near branches. Labels used any other way (as
//! immediates, data, with an offset, or at the very end) take their address from the previous
//! pass; passes repeat until every label address is stable.
use super::parse::{DataItem, Expr, Line, MemSize, Operand, Prefix, Stmt};
use super::{AsmError, Assembled};
use iced_x86::{
    BlockEncoder, BlockEncoderOptions, Code, Decoder, DecoderOptions, Encoder, Instruction, InstructionBlock,
    MemorySize, OpCodeOperandKind as K, OpKind, Register,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

const PLACEHOLDER_BASE: u64 = 0xFFFF_F000_0000_0000;
const PLACEHOLDER_STEP: u64 = 0x20;
const MAX_PASSES: usize = 16;
const TWO_GIB: i128 = 1 << 31;
/// Slack for "within rel32 range" checks made before the final layout is known.
const RANGE_SLACK: i128 = 0x1000;

fn placeholder(entry: usize) -> u64 {
    PLACEHOLDER_BASE + entry as u64 * PLACEHOLDER_STEP
}

/// Every 64-bit-mode instruction `Code`, by lowercase mnemonic.
fn codes(mnemonic: &str) -> Option<&'static [Code]> {
    static MAP: OnceLock<HashMap<String, Vec<Code>>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m: HashMap<String, Vec<Code>> = HashMap::new();
        for code in Code::values() {
            let oc = code.op_code();
            if oc.is_instruction() && oc.mode64() {
                m.entry(format!("{:?}", code.mnemonic()).to_ascii_lowercase()).or_default().push(code);
            }
        }
        m
    })
    .get(mnemonic)
    .map(Vec::as_slice)
}

/// A resolved value: its number, and the block entry it names when it's a bare in-block label.
#[derive(Clone, Copy)]
struct Val {
    value: i128,
    entry: Option<usize>,
    symbolic: bool,
}

struct Env<'a> {
    address: u64,
    resolve: &'a dyn Fn(&str) -> Option<u64>,
    /// Lowercase label → (estimated address, block entry it labels; `None` = end of the block).
    labels: HashMap<String, (u64, Option<usize>)>,
}

impl Env<'_> {
    fn value(&self, e: &Expr) -> Result<Val, String> {
        match e {
            Expr::Num(n) => Ok(Val { value: *n, entry: None, symbolic: false }),
            Expr::Sym { name, addend } => {
                let (base, entry) = match self.labels.get(&name.to_ascii_lowercase()) {
                    Some(&(addr, entry)) => (addr, if *addend == 0 { entry } else { None }),
                    None => ((self.resolve)(name).ok_or_else(|| format!("unknown symbol {name}"))?, None),
                };
                Ok(Val { value: base as i128 + *addend as i128, entry, symbolic: true })
            }
        }
    }
}

/// What the final bytes must show for an operand whose target isn't a label in the block.
#[derive(Clone, Copy)]
enum Check {
    Branch(u64),
    RipMem(u64),
}

struct Item<'a> {
    line: usize,
    body: Body<'a>,
}

enum Body<'a> {
    Insn { prefixes: &'a [Prefix], mnemonic: &'a str, operands: &'a [Operand] },
    Data(u8, &'a [DataItem]),
}

pub fn encode(stmts: &[Stmt], address: u64, resolve: &dyn Fn(&str) -> Option<u64>) -> Result<Assembled, AsmError> {
    // Label names (case-insensitive) → defining statement; duplicates are errors.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for s in stmts {
        if let Line::Label(name) = &s.kind {
            if names.insert(name.to_ascii_lowercase(), name.clone()).is_some() {
                return Err(AsmError::new(s.line, format!("label {name} defined twice")));
            }
        }
    }
    let mut est: HashMap<String, u64> = names.keys().map(|k| (k.clone(), address)).collect();
    let mut item_ips: Vec<u64> = vec![];
    for _ in 0..MAX_PASSES {
        let out = pass(stmts, address, resolve, &est, &item_ips)?;
        let stable = out.labels == est;
        est = out.labels;
        item_ips = out.item_ips;
        if stable || est.is_empty() {
            let labels = names.iter().map(|(k, name)| (name.clone(), est[k])).collect();
            return Ok(Assembled { bytes: out.bytes, labels });
        }
    }
    Err(AsmError::new(stmts.first().map_or(1, |s| s.line), "label addresses did not settle"))
}

struct PassOut {
    bytes: Vec<u8>,
    labels: HashMap<String, u64>,
    item_ips: Vec<u64>,
}

fn pass(
    stmts: &[Stmt],
    address: u64,
    resolve: &dyn Fn(&str) -> Option<u64>,
    est: &HashMap<String, u64>,
    item_ips: &[u64],
) -> Result<PassOut, AsmError> {
    // Lay out the block: one entry per instruction, data split into ≤16-byte chunks. A label
    // names the first entry after it.
    let mut items: Vec<Item> = vec![];
    let mut first_entry: Vec<usize> = vec![];
    let mut entries = 0;
    let mut pending: Vec<String> = vec![];
    let mut label_entry: HashMap<String, usize> = HashMap::new();
    for s in stmts {
        let (body, n) = match &s.kind {
            Line::Label(name) => {
                pending.push(name.to_ascii_lowercase());
                continue;
            }
            Line::Insn { prefixes, mnemonic, operands } => (Body::Insn { prefixes, mnemonic, operands }, 1),
            Line::Data { width, items: d } => (Body::Data(*width, d), data_len(d, *width).div_ceil(16)),
        };
        for l in pending.drain(..) {
            label_entry.insert(l, entries);
        }
        items.push(Item { line: s.line, body });
        first_entry.push(entries);
        entries += n;
    }
    let mut env = Env { address, resolve, labels: HashMap::new() };
    for (name, &addr) in est {
        let entry = label_entry.get(name).copied().filter(|&e| e < entries);
        env.labels.insert(name.clone(), (addr, entry));
    }

    let mut block: Vec<Instruction> = vec![];
    let mut entry_item: Vec<usize> = vec![];
    let mut checks: Vec<(usize, Check)> = vec![];
    for (i, it) in items.iter().enumerate() {
        let ip = item_ips.get(i).copied().unwrap_or(address);
        let err = |m: String| AsmError::new(it.line, m);
        match &it.body {
            Body::Insn { prefixes, mnemonic, operands } => {
                let (mut ins, check) = instruction(&env, prefixes, mnemonic, operands, ip).map_err(err)?;
                ins.set_ip(placeholder(block.len()));
                if let Some(c) = check {
                    checks.push((block.len(), c));
                }
                block.push(ins);
                entry_item.push(i);
            }
            Body::Data(width, d) => {
                for chunk in data_bytes(&env, d, *width).map_err(err)?.chunks(16) {
                    let mut ins = Instruction::with_declare_byte(chunk).map_err(|e| err(e.to_string()))?;
                    ins.set_ip(placeholder(block.len()));
                    block.push(ins);
                    entry_item.push(i);
                }
            }
        }
    }

    let res = BlockEncoder::encode(
        64,
        InstructionBlock::new(&block, address),
        BlockEncoderOptions::RETURN_NEW_INSTRUCTION_OFFSETS,
    )
    .map_err(|e| {
        let msg = e.to_string();
        let line = (0..block.len())
            .find(|&b| msg.contains(&format!("0x{:X}", placeholder(b))))
            .map_or(items.first().map_or(1, |it| it.line), |b| items[entry_item[b]].line);
        AsmError::new(line, msg)
    })?;
    let bytes = res.code_buffer;
    let offs = res.new_instruction_offsets;

    // Targets outside the block must have stayed plain rel8/rel32 references (no long-form rewrite).
    for (b, check) in checks {
        let off = offs[b];
        let ok = off != u32::MAX && {
            let at = address + off as u64;
            let mut dec = Decoder::with_ip(64, &bytes[off as usize..], at, DecoderOptions::NONE);
            let d = dec.decode();
            match check {
                Check::Branch(t) => d.op_count() > 0 && d.op0_kind() == OpKind::NearBranch64 && d.near_branch_target() == t,
                Check::RipMem(t) => d.is_ip_rel_memory_operand() && d.ip_rel_memory_address() == t,
            }
        };
        if !ok {
            return Err(AsmError::new(items[entry_item[b]].line, "target is out of rel32 range"));
        }
    }

    let end = address + bytes.len() as u64;
    let entry_ip = |e: usize| if e < offs.len() { address + offs[e] as u64 } else { end };
    let item_ips = first_entry.iter().map(|&e| entry_ip(e)).collect();
    let labels = est.keys().map(|k| (k.clone(), label_entry.get(k).map_or(end, |&e| entry_ip(e)))).collect();
    Ok(PassOut { bytes, labels, item_ips })
}

/// Byte length of a data statement (known before any value is resolved).
fn data_len(items: &[DataItem], width: u8) -> usize {
    items
        .iter()
        .map(|it| match it {
            DataItem::Bytes(b) => b.len(),
            DataItem::Value(_) => width as usize,
        })
        .sum()
}

fn data_bytes(env: &Env, items: &[DataItem], width: u8) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for it in items {
        match it {
            DataItem::Bytes(b) => out.extend_from_slice(b),
            DataItem::Value(e) => {
                let v = env.value(e)?.value;
                let bits = width as u32 * 8;
                if v < -(1i128 << (bits - 1)) || v >= 1i128 << bits {
                    return Err(format!("value {v:#x} doesn't fit in {width} byte(s)"));
                }
                out.extend_from_slice(&(v as u64).to_le_bytes()[..width as usize]);
            }
        }
    }
    Ok(out)
}

/// How a memory operand is addressed, decided before matching candidates.
#[derive(Clone, Copy)]
enum Addr {
    /// base/index (+ disp32), or a segment-relative/absolute disp32.
    Regs { base: Register, index: Register, scale: u32, disp: u64, displ_size: u32 },
    /// RIP-relative to an absolute target (a placeholder when `entry` is set).
    Rip { target: u64, entry: Option<usize> },
    /// A 64-bit absolute address that only the `moffs` forms can encode.
    Moffs(u64),
}

/// Pick the shortest encoding of one instruction at `ip`. Returns the instruction (label
/// references pointing at entry placeholders) and the check its final bytes must pass.
fn instruction(
    env: &Env,
    prefixes: &[Prefix],
    mnemonic: &str,
    operands: &[Operand],
    ip: u64,
) -> Result<(Instruction, Option<Check>), String> {
    let cands = codes(mnemonic).ok_or_else(|| format!("unknown instruction {mnemonic}"))?;
    if let Some(r) = string_instruction(prefixes, mnemonic, operands) {
        return Ok((r?, None));
    }
    // `rep ret` (F3 C3) is the only prefixed `ret`.
    if mnemonic == "ret" && operands.is_empty() && !prefixes.is_empty() {
        if prefixes.iter().any(|p| !matches!(p, Prefix::Rep | Prefix::Repe)) {
            return Err("prefix not allowed on ret with these operands".into());
        }
        let mut ins = Instruction::with(Code::Retnq);
        ins.set_has_repe_prefix(true);
        return Ok((ins, None));
    }
    // `imul r, imm` is iced's (and CE's) short spelling of `imul r, r, imm`.
    let expanded;
    let operands = match (mnemonic, operands) {
        ("imul", [Operand::Reg(r), imm @ Operand::Imm(_)]) => {
            expanded = [Operand::Reg(*r), Operand::Reg(*r), imm.clone()];
            &expanded[..]
        }
        _ => operands,
    };
    // Resolve operand values once.
    let mut vals: Vec<Option<Val>> = vec![];
    let mut addrs: Vec<Option<Addr>> = vec![];
    for op in operands {
        let (v, a) = match op {
            Operand::Reg(_) => (None, None),
            Operand::Imm(e) => (Some(env.value(e)?), None),
            Operand::Mem { base, index, scale, disp, seg, .. } => {
                (None, Some(mem_addr(env, *base, *index, *scale, disp, *seg, ip)?))
            }
        };
        vals.push(v);
        addrs.push(a);
    }
    let mem_size = operands.iter().find_map(|o| match o {
        Operand::Mem { size, .. } => Some(*size),
        _ => None,
    });

    let has_imm = operands.iter().any(|o| matches!(o, Operand::Imm(_)));
    let has_mem = mem_size.is_some();
    // 16-bit operand size only when the source asks for it (a 16-bit register or `word`);
    // otherwise `push 1234` could pick the 2-byte-shorter `66 68` form.
    let wants_o16 = mem_size == Some(Some(MemSize::Word))
        || operands.iter().any(|o| matches!(o, Operand::Reg(r) if r.is_gpr16()));
    let near_branch = matches!(mnemonic, "jmp" | "call");

    let mut enc = Encoder::new(64);
    let mut found: Vec<(usize, Instruction)> = vec![];
    // Memory sizes of every candidate the register and memory operands fit (whatever the immediate).
    let mut sizes: Vec<usize> = vec![];
    let mut first_err = None;
    let mut prefix_rejected = false;
    'cand: for &code in cands {
        let oc = code.op_code();
        // `cbw`/`cwd` are the 16-bit sign extensions and take no operand to say so.
        let o16 = oc.operand_size() == 16 && !wants_o16 && !matches!(mnemonic, "cbw" | "cwd");
        if oc.op_count() as usize != operands.len() || o16 {
            continue;
        }
        let prefix_ok = prefixes.iter().all(|p| match p {
            Prefix::Lock => oc.can_use_lock_prefix() && has_mem,
            Prefix::Rep | Prefix::Repe => oc.can_use_rep_prefix(),
            Prefix::Repne => oc.can_use_repne_prefix(),
        });
        if !prefix_ok {
            prefix_rejected = true;
            continue;
        }
        let mut ins = Instruction::default();
        ins.set_code(code);
        // Far `m16:16`-style branches are never what `jmp [x]` / `call [x]` means.
        if near_branch && matches!(ins.memory_size(), MemorySize::SegPtr16 | MemorySize::SegPtr32 | MemorySize::SegPtr64) {
            continue;
        }
        for p in prefixes {
            match p {
                Prefix::Lock => ins.set_has_lock_prefix(true),
                Prefix::Rep => ins.set_has_rep_prefix(true),
                Prefix::Repe => ins.set_has_repe_prefix(true),
                Prefix::Repne => ins.set_has_repne_prefix(true),
            }
        }
        // Registers and memory first, so `sizes` sees every form the operands could mean.
        for (i, op) in operands.iter().enumerate() {
            let ok = match op {
                Operand::Reg(r) => set_reg(&mut ins, i as u32, oc.op_kind(i as u32), *r),
                Operand::Imm(_) => true,
                Operand::Mem { size, seg, .. } => {
                    set_mem(&mut ins, i as u32, oc.op_kind(i as u32), addrs[i].unwrap(), *seg)
                        && size.is_none_or(|s| {
                            let n = ins.memory_size().size();
                            n == 0 || n == s.bytes()
                        })
                }
            };
            if !ok {
                continue 'cand;
            }
        }
        if has_mem {
            // Would this form encode with an immediate that fits anything? Then its size is a
            // possible meaning of the operands, whether or not the real immediate fits.
            let mut probe = ins;
            let fits = operands.iter().enumerate().all(|(i, op)| {
                let kind = oc.op_kind(i as u32);
                let v = if is_branch(kind) { ip as i128 } else { 1 };
                !matches!(op, Operand::Imm(_)) || set_imm(&mut probe, i as u32, kind, Val { value: v, entry: None, symbolic: false })
            });
            if fits && enc.encode(&probe, ip).is_ok() {
                sizes.push(ins.memory_size().size());
            }
        }
        for (i, op) in operands.iter().enumerate() {
            if matches!(op, Operand::Imm(_)) && !set_imm(&mut ins, i as u32, oc.op_kind(i as u32), vals[i].unwrap()) {
                continue 'cand;
            }
        }
        match enc.encode(&ins, ip) {
            Ok(len) => found.push((len, ins)),
            Err(e) => {
                first_err.get_or_insert(e.to_string());
            }
        }
    }
    // A memory operand without a size that could mean several sizes (see the module doc).
    sizes.sort_unstable();
    sizes.dedup();
    if mem_size == Some(None) && sizes.len() > 1 {
        let default = if near_branch || matches!(mnemonic, "push" | "pop") {
            8
        } else if has_imm || mnemonic == "nop" {
            4
        } else {
            return Err("operand size required (add byte/word/dword/qword ptr)".into());
        };
        found.retain(|(_, i)| i.memory_size().size() == default);
        if found.is_empty() {
            let name = if default == 4 { "dword" } else { "qword" };
            return Err(format!("operands don't fit the default {name} size; add a size keyword"));
        }
    }
    let Some((_, ins)) = found.into_iter().min_by_key(|(len, _)| *len) else {
        return Err(match first_err {
            _ if prefix_rejected => format!("prefix not allowed on {mnemonic} with these operands"),
            Some(e) if operands.iter().all(|o| !matches!(o, Operand::Reg(_))) => format!("can't encode: {e}"),
            _ => format!("invalid operands for {mnemonic}"),
        });
    };
    finish(ins, operands, &vals, &addrs, ip)
}

/// The string instructions (`movsb`, `rep stosq`, …) with no operands or the memory operands the
/// disassembler prints. `None` when the mnemonic or operands aren't a string form (`movsd xmm0,xmm1`).
fn string_instruction(prefixes: &[Prefix], mnemonic: &str, operands: &[Operand]) -> Option<Result<Instruction, String>> {
    use iced_x86::RepPrefixKind as R;
    let (op, suffix) = mnemonic.split_at(mnemonic.len().checked_sub(1)?);
    let width = match suffix {
        "b" => MemSize::Byte,
        "w" => MemSize::Word,
        "d" => MemSize::Dword,
        "q" => MemSize::Qword,
        _ => return None,
    };
    // Memory operands, in the order the disassembler prints them.
    let want: &[Register] = match op {
        "movs" => &[Register::RDI, Register::RSI],
        "cmps" => &[Register::RSI, Register::RDI],
        "stos" | "scas" => &[Register::RDI],
        "lods" => &[Register::RSI],
        _ => return None,
    };
    let shaped = operands.len() == want.len()
        && operands.iter().zip(want).all(|(o, w)| {
            matches!(o, Operand::Mem { size, seg: None, base: Some(b), index: None, disp: Expr::Num(0), .. }
                if b == w && size.is_none_or(|s| s == width))
        });
    if !operands.is_empty() && !shaped {
        return None;
    }
    let compare = matches!(op, "cmps" | "scas");
    let rep = match prefixes {
        [] => R::None,
        [Prefix::Rep] if !compare => R::Repe,
        [Prefix::Repe] if compare => R::Repe,
        [Prefix::Repne] if compare => R::Repne,
        _ => return Some(Err(format!("prefix not allowed on {mnemonic} with these operands"))),
    };
    let ins = match (op, width) {
        ("movs", MemSize::Byte) => Instruction::with_movsb(64, Register::None, rep),
        ("movs", MemSize::Word) => Instruction::with_movsw(64, Register::None, rep),
        ("movs", MemSize::Dword) => Instruction::with_movsd(64, Register::None, rep),
        ("movs", _) => Instruction::with_movsq(64, Register::None, rep),
        ("cmps", MemSize::Byte) => Instruction::with_cmpsb(64, Register::None, rep),
        ("cmps", MemSize::Word) => Instruction::with_cmpsw(64, Register::None, rep),
        ("cmps", MemSize::Dword) => Instruction::with_cmpsd(64, Register::None, rep),
        ("cmps", _) => Instruction::with_cmpsq(64, Register::None, rep),
        ("stos", MemSize::Byte) => Instruction::with_stosb(64, rep),
        ("stos", MemSize::Word) => Instruction::with_stosw(64, rep),
        ("stos", MemSize::Dword) => Instruction::with_stosd(64, rep),
        ("stos", _) => Instruction::with_stosq(64, rep),
        ("lods", MemSize::Byte) => Instruction::with_lodsb(64, Register::None, rep),
        ("lods", MemSize::Word) => Instruction::with_lodsw(64, Register::None, rep),
        ("lods", MemSize::Dword) => Instruction::with_lodsd(64, Register::None, rep),
        ("lods", _) => Instruction::with_lodsq(64, Register::None, rep),
        ("scas", MemSize::Byte) => Instruction::with_scasb(64, rep),
        ("scas", MemSize::Word) => Instruction::with_scasw(64, rep),
        ("scas", MemSize::Dword) => Instruction::with_scasd(64, rep),
        _ => Instruction::with_scasq(64, rep),
    };
    Some(ins.map_err(|e| e.to_string()))
}

/// Point label references at placeholders and work out the final-bytes check.
fn finish(
    mut ins: Instruction,
    operands: &[Operand],
    vals: &[Option<Val>],
    addrs: &[Option<Addr>],
    ip: u64,
) -> Result<(Instruction, Option<Check>), String> {
    let mut check = None;
    for i in 0..operands.len() {
        let kind = ins.op_kind(i as u32);
        if kind == OpKind::NearBranch64 {
            let v = vals[i].unwrap();
            match v.entry {
                Some(e) => ins.set_near_branch64(placeholder(e)),
                None => {
                    if !near(ip, v.value) {
                        return Err("branch target is out of rel32 range".into());
                    }
                    check = Some(Check::Branch(v.value as u64));
                }
            }
        }
        if let Some(Addr::Rip { target, entry }) = addrs[i] {
            match entry {
                Some(e) => ins.set_memory_displacement64(placeholder(e)),
                None => check = Some(Check::RipMem(target)),
            }
        }
    }
    Ok((ins, check))
}

fn near(ip: u64, target: i128) -> bool {
    let d = target - ip as i128;
    d > -TWO_GIB + RANGE_SLACK && d < TWO_GIB - RANGE_SLACK
}

fn mem_addr(
    env: &Env,
    base: Option<Register>,
    index: Option<Register>,
    scale: u8,
    disp: &Expr,
    seg: Option<Register>,
    ip: u64,
) -> Result<Addr, String> {
    let v = env.value(disp)?;
    if base.is_some() || index.is_some() {
        // A displacement is a signed 32-bit value; accept its unsigned and 64-bit spellings too.
        let d = v.value;
        let d32 = if (-TWO_GIB..TWO_GIB << 1).contains(&d) {
            d as i64 as i32
        } else {
            return Err("displacement out of range".into());
        };
        return Ok(Addr::Regs {
            base: base.unwrap_or(Register::None),
            index: index.unwrap_or(Register::None),
            scale: scale as u32,
            disp: d32 as i64 as u64,
            displ_size: if d32 == 0 { 0 } else { 1 },
        });
    }
    if !(i64::MIN as i128..=u64::MAX as i128).contains(&v.value) {
        return Err("address out of range".into());
    }
    let target = v.value as u64;
    let abs = || {
        if (target as i64) as i32 as i64 == target as i64 {
            // displ_size 8 = 64-bit addressing with a sign-extended disp32 (4 would add a 0x67 prefix).
            Addr::Regs { base: Register::None, index: Register::None, scale: 1, disp: target, displ_size: 8 }
        } else {
            Addr::Moffs(target)
        }
    };
    if seg.is_some() {
        return Ok(abs());
    }
    if v.symbolic {
        if v.entry.is_none() && !near(ip, v.value) {
            return Err("memory target is out of rel32 range".into());
        }
        return Ok(Addr::Rip { target, entry: v.entry });
    }
    // A plain number: RIP-relative when it's within ±2 GiB of `address` (R3).
    if near(env.address, v.value) {
        Ok(Addr::Rip { target, entry: None })
    } else {
        Ok(abs())
    }
}

fn set_reg(ins: &mut Instruction, i: u32, kind: K, r: Register) -> bool {
    let reg_ok = !matches!(
        kind,
        K::mem | K::mem_offs | K::mem_mpx | K::mem_mib | K::sibmem | K::seg_rSI | K::es_rDI | K::seg_rDI | K::seg_rBX_al
    ) && !is_imm(kind)
        && !is_branch(kind);
    if !reg_ok {
        return false;
    }
    ins.set_op_kind(i, OpKind::Register);
    ins.set_op_register(i, r);
    true
}

fn is_branch(k: K) -> bool {
    matches!(k, K::br16_1 | K::br32_1 | K::br64_1 | K::br16_2 | K::br32_4 | K::br64_4 | K::brdisp_2 | K::brdisp_4 | K::farbr2_2 | K::farbr4_2)
}

fn is_imm(k: K) -> bool {
    matches!(
        k,
        K::imm4_m2z | K::imm8 | K::imm8_const_1 | K::imm8sex16 | K::imm8sex32 | K::imm8sex64 | K::imm16 | K::imm32 | K::imm32sex64 | K::imm64
    )
}

fn set_mem(ins: &mut Instruction, i: u32, kind: K, addr: Addr, seg: Option<Register>) -> bool {
    let moffs = kind == K::mem_offs;
    let mem_ok = moffs
        || matches!(
            kind,
            K::mem | K::r8_or_mem | K::r16_or_mem | K::r32_or_mem | K::r64_or_mem | K::xmm_or_mem | K::mm_or_mem
        );
    if !mem_ok {
        return false;
    }
    ins.set_op_kind(i, OpKind::Memory);
    ins.set_segment_prefix(seg.unwrap_or(Register::None));
    match addr {
        Addr::Regs { base, index, scale, disp, displ_size } => {
            if moffs {
                return false;
            }
            ins.set_memory_base(base);
            ins.set_memory_index(index);
            ins.set_memory_index_scale(scale);
            ins.set_memory_displacement64(disp);
            ins.set_memory_displ_size(displ_size);
        }
        Addr::Rip { target, .. } => {
            if moffs {
                return false;
            }
            ins.set_memory_base(Register::RIP);
            ins.set_memory_index(Register::None);
            ins.set_memory_index_scale(1);
            ins.set_memory_displacement64(target);
            ins.set_memory_displ_size(8);
        }
        Addr::Moffs(target) => {
            if !moffs {
                return false;
            }
            ins.set_memory_base(Register::None);
            ins.set_memory_index(Register::None);
            ins.set_memory_index_scale(1);
            ins.set_memory_displacement64(target);
            ins.set_memory_displ_size(8);
        }
    }
    true
}

/// `v` truncated to `bits`, if it's in `[-2^(bits-1), 2^bits)`.
fn trunc(v: i128, bits: u32) -> Option<u64> {
    (v >= -(1i128 << (bits - 1)) && v < 1i128 << bits).then_some(v as u64 & (u64::MAX >> (64 - bits)))
}

/// Sign-extend the low `bits` of `v`.
fn sext(v: u64, bits: u32) -> i64 {
    ((v << (64 - bits)) as i64) >> (64 - bits)
}

fn set_imm(ins: &mut Instruction, i: u32, kind: K, v: Val) -> bool {
    let n = v.value;
    // The second immediate of `enter`/`extrq`-style instructions uses its own slot.
    let second = i > 0 && matches!(ins.op_kind(i - 1), OpKind::Immediate8 | OpKind::Immediate16);
    match kind {
        K::br64_1 | K::br64_4 => {
            let Some(t) = trunc(n, 64) else { return false };
            ins.set_op_kind(i, OpKind::NearBranch64);
            ins.set_near_branch64(t);
        }
        K::imm8 => {
            let Some(t) = trunc(n, 8) else { return false };
            if second {
                ins.set_op_kind(i, OpKind::Immediate8_2nd);
                ins.set_immediate8_2nd(t as u8);
            } else {
                ins.set_op_kind(i, OpKind::Immediate8);
                ins.set_immediate8(t as u8);
            }
        }
        K::imm8_const_1 => {
            if n != 1 {
                return false;
            }
            ins.set_op_kind(i, OpKind::Immediate8);
            ins.set_immediate8(1);
        }
        K::imm8sex16 | K::imm8sex32 | K::imm8sex64 => {
            let bits = match kind {
                K::imm8sex16 => 16,
                K::imm8sex32 => 32,
                _ => 64,
            };
            let Some(t) = trunc(n, bits) else { return false };
            let s = sext(t, bits);
            if s != s as i8 as i64 {
                return false;
            }
            match bits {
                16 => {
                    ins.set_op_kind(i, OpKind::Immediate8to16);
                    ins.set_immediate8to16(s as i16);
                }
                32 => {
                    ins.set_op_kind(i, OpKind::Immediate8to32);
                    ins.set_immediate8to32(s as i32);
                }
                _ => {
                    ins.set_op_kind(i, OpKind::Immediate8to64);
                    ins.set_immediate8to64(s);
                }
            }
        }
        K::imm16 => {
            let Some(t) = trunc(n, 16) else { return false };
            ins.set_op_kind(i, OpKind::Immediate16);
            ins.set_immediate16(t as u16);
        }
        K::imm32 => {
            let Some(t) = trunc(n, 32) else { return false };
            ins.set_op_kind(i, OpKind::Immediate32);
            ins.set_immediate32(t as u32);
        }
        K::imm32sex64 => {
            let Some(t) = trunc(n, 64) else { return false };
            if t as i64 != t as i64 as i32 as i64 {
                return false;
            }
            ins.set_op_kind(i, OpKind::Immediate32to64);
            ins.set_immediate32to64(t as i64);
        }
        K::imm64 => {
            let Some(t) = trunc(n, 64) else { return false };
            ins.set_op_kind(i, OpKind::Immediate64);
            ins.set_immediate64(t);
        }
        _ => return false,
    }
    true
}
