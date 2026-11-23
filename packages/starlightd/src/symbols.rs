//! Exported symbols read straight from a module's image in memory: PE export tables and ELF dynamic
//! symbols, plus the GOT slots an ELF module uses for an imported function.
//!
//! The parsing core takes a reader (`read(addr, len) -> Option<Vec<u8>>`) so it can run on hand-built
//! buffers; the `Target`-based functions wrap it. Every read is bounds-checked against the module's
//! range, and a malformed table yields an empty result rather than a panic.
use crate::modules::{self, Kind, Module};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::mem;

/// Reads `len` bytes of target memory at an address, or `None` if any of it is unreadable.
pub type Reader<'a> = &'a dyn Fn(u64, usize) -> Option<Vec<u8>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymKind {
    Func,
    /// `STT_GNU_IFUNC`: `address` is the resolver; the real implementation is picked at load time.
    Ifunc,
    Object,
}

impl SymKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymKind::Func => "func",
            SymKind::Ifunc => "ifunc",
            SymKind::Object => "object",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Export {
    pub name: String,
    /// Absolute address in the target; `0` for a PE forwarder (follow it with `resolve`).
    pub address: u64,
    pub kind: SymKind,
    /// PE forwarder target as written in the table: `"DLL.Name"` or `"DLL.#ord"`.
    pub forwarder: Option<String>,
}

/// Most forwarder hops `resolve` follows before giving up.
const MAX_HOPS: usize = 8;
/// Sanity caps so a corrupt table can't make us allocate or loop without bound.
const MAX_SYMS: usize = 1 << 21;
const MAX_NAME: usize = 1024;
const PAGE: u64 = 0x1000;

/// A module's image: a reader confined to `[base, end)`.
struct Img<'a> {
    read: Reader<'a>,
    base: u64,
    end: u64,
}

impl<'a> Img<'a> {
    fn new(read: Reader<'a>, m: &Module) -> Self {
        Img { read, base: m.base, end: m.base.saturating_add(m.size) }
    }
    fn get(&self, addr: u64, len: usize) -> Option<Vec<u8>> {
        let stop = addr.checked_add(len as u64)?;
        if addr < self.base || stop > self.end {
            return None;
        }
        let v = (self.read)(addr, len)?;
        (v.len() == len).then_some(v)
    }
    fn u32(&self, addr: u64) -> Option<u32> {
        Some(u32::from_le_bytes(self.get(addr, 4)?.try_into().ok()?))
    }
    /// NUL-terminated string, read a page-bounded chunk at a time so a name at the end of a
    /// mapping never makes the read fail.
    fn cstr(&self, addr: u64) -> Option<String> {
        let mut out = vec![];
        let mut at = addr;
        while out.len() < MAX_NAME {
            let room = (PAGE - (at & (PAGE - 1))).min(256) as usize;
            let room = room.min(self.end.checked_sub(at)? as usize);
            if room == 0 {
                return None; // ran off the end of the module without a NUL
            }
            let chunk = self.get(at, room)?;
            if let Some(n) = chunk.iter().position(|&b| b == 0) {
                out.extend_from_slice(&chunk[..n]);
                return String::from_utf8(out).ok();
            }
            out.extend_from_slice(&chunk);
            at += room as u64;
        }
        None
    }
}

// ---------------------------------------------------------------- PE

/// `(ordinal, export)` for every entry of the PE export directory. Nameless (ordinal-only) exports
/// are named `#<ordinal>`.
fn pe_entries(img: &Img) -> Option<Vec<(u32, Export)>> {
    let hdr = img.get(img.base, 0x1000.min(img.end.checked_sub(img.base)? as usize))?;
    let u32_at = |o: usize| -> Option<u32> { Some(u32::from_le_bytes(hdr.get(o..o.checked_add(4)?)?.try_into().ok()?)) };
    if hdr.get(0..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(0x3c)? as usize;
    if hdr.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let opt = pe.checked_add(24)?;
    let dd = match u16::from_le_bytes(hdr.get(opt..opt + 2)?.try_into().ok()?) {
        0x20b => opt + 112,
        0x10b => opt + 96,
        _ => return None,
    };
    let (dir_rva, dir_size) = (u32_at(dd)? as u64, u32_at(dd + 4)? as u64);
    if dir_rva == 0 || dir_size < 40 {
        return None;
    }
    let at = |rva: u64| img.base.checked_add(rva);
    let dir = img.get(at(dir_rva)?, 40)?;
    let d32 = |o: usize| u32::from_le_bytes(dir[o..o + 4].try_into().unwrap());
    let (ord_base, nfuncs, nnames) = (d32(0x10), d32(0x14) as usize, d32(0x18) as usize);
    let (aof, aon, aono) = (d32(0x1c) as u64, d32(0x20) as u64, d32(0x24) as u64);
    // Ordinals are 16-bit, so no valid table has more functions than that.
    if nfuncs > 0x10000 || nnames > 0x10000 {
        return None;
    }
    let funcs = img.get(at(aof)?, nfuncs * 4)?;
    let func_rva = |i: usize| u32::from_le_bytes(funcs[i * 4..i * 4 + 4].try_into().unwrap()) as u64;
    let names = img.get(at(aon)?, nnames * 4)?;
    let ords = img.get(at(aono)?, nnames * 2)?;

    let make = |name: String, rva: u64| -> Option<Export> {
        if rva >= dir_rva && rva < dir_rva + dir_size {
            let fwd = img.cstr(at(rva)?)?;
            Some(Export { name, address: 0, kind: SymKind::Func, forwarder: Some(fwd) })
        } else {
            Some(Export { name, address: at(rva)?, kind: SymKind::Func, forwarder: None })
        }
    };

    let mut named = vec![false; nfuncs];
    let mut out = vec![];
    for i in 0..nnames {
        let idx = u16::from_le_bytes(ords[i * 2..i * 2 + 2].try_into().unwrap()) as usize;
        let name_rva = u32::from_le_bytes(names[i * 4..i * 4 + 4].try_into().unwrap()) as u64;
        if idx >= nfuncs || func_rva(idx) == 0 {
            continue;
        }
        named[idx] = true;
        let Some(name) = at(name_rva).and_then(|a| img.cstr(a)) else { continue };
        if let Some(e) = make(name, func_rva(idx)) {
            out.push((ord_base.wrapping_add(idx as u32), e));
        }
    }
    for idx in (0..nfuncs).filter(|&i| !named[i] && func_rva(i) != 0) {
        let ord = ord_base.wrapping_add(idx as u32);
        if let Some(e) = make(format!("#{ord}"), func_rva(idx)) {
            out.push((ord, e));
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- ELF

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const DT_NULL: u64 = 0;
const DT_PLTRELSZ: u64 = 2;
const DT_HASH: u64 = 4;
const DT_STRTAB: u64 = 5;
const DT_SYMTAB: u64 = 6;
const DT_RELA: u64 = 7;
const DT_RELASZ: u64 = 8;
const DT_JMPREL: u64 = 23;
const DT_GNU_HASH: u64 = 0x6fff_fef5;
const SYM_SIZE: u64 = 24;
const RELA_SIZE: u64 = 24;
const R_X86_64_GLOB_DAT: u32 = 6;
const R_X86_64_JUMP_SLOT: u32 = 7;

/// What we need from an ELF module's dynamic section. Pointers are already absolute addresses.
struct ElfDyn {
    /// Load bias: add to link-time virtual addresses (symbol values, relocation offsets).
    bias: u64,
    symtab: u64,
    strtab: u64,
    /// Number of `.dynsym` entries.
    nsyms: u64,
    jmprel: Option<(u64, u64)>,
    rela: Option<(u64, u64)>,
}

fn elf_dyn(img: &Img) -> Option<ElfDyn> {
    let eh = img.get(img.base, 64)?;
    if &eh[0..4] != b"\x7fELF" || eh[4] != 2 || eh[5] != 1 {
        return None;
    }
    let phoff = u64::from_le_bytes(eh[0x20..0x28].try_into().unwrap());
    let phentsize = u16::from_le_bytes(eh[0x36..0x38].try_into().unwrap()) as usize;
    let phnum = u16::from_le_bytes(eh[0x38..0x3a].try_into().unwrap()) as usize;
    if phentsize < 56 || phnum == 0 || phnum > 256 {
        return None;
    }
    let ph = img.get(img.base.checked_add(phoff)?, phentsize * phnum)?;
    let mut first_load = None;
    let mut dynamic = None;
    for i in 0..phnum {
        let p = &ph[i * phentsize..i * phentsize + 56];
        let ty = u32::from_le_bytes(p[0..4].try_into().unwrap());
        let vaddr = u64::from_le_bytes(p[16..24].try_into().unwrap());
        let memsz = u64::from_le_bytes(p[40..48].try_into().unwrap());
        if ty == PT_LOAD && first_load.is_none() {
            first_load = Some(vaddr);
        } else if ty == PT_DYNAMIC && dynamic.is_none() {
            dynamic = Some((vaddr, memsz));
        }
    }
    let bias = img.base.wrapping_sub(first_load?);
    let (dyn_vaddr, dyn_size) = dynamic?;
    let dyn_bytes = img.get(dyn_vaddr.wrapping_add(bias), dyn_size.min(0x10000) as usize & !15)?;

    // glibc relocates d_ptr values in place; other loaders leave link-time addresses.
    let fix = |p: u64| if p >= img.base && p < img.end { p } else { p.wrapping_add(bias) };
    let (mut symtab, mut strtab, mut hash, mut gnu_hash) = (None, None, None, None);
    let (mut jmprel, mut pltrelsz, mut rela, mut relasz) = (None, 0u64, None, 0u64);
    for e in dyn_bytes.chunks_exact(16) {
        let tag = u64::from_le_bytes(e[0..8].try_into().unwrap());
        let val = u64::from_le_bytes(e[8..16].try_into().unwrap());
        match tag {
            DT_NULL => break,
            DT_SYMTAB => symtab = Some(fix(val)),
            DT_STRTAB => strtab = Some(fix(val)),
            DT_HASH => hash = Some(fix(val)),
            DT_GNU_HASH => gnu_hash = Some(fix(val)),
            DT_JMPREL => jmprel = Some(fix(val)),
            DT_PLTRELSZ => pltrelsz = val,
            DT_RELA => rela = Some(fix(val)),
            DT_RELASZ => relasz = val,
            _ => {}
        }
    }
    let nsyms = match (hash, gnu_hash) {
        (Some(h), _) => img.u32(h.checked_add(4)?)? as u64,
        (None, Some(g)) => gnu_hash_nsyms(img, g)?,
        (None, None) => return None,
    };
    Some(ElfDyn {
        bias,
        symtab: symtab?,
        strtab: strtab?,
        nsyms: nsyms.min(MAX_SYMS as u64),
        jmprel: jmprel.map(|a| (a, pltrelsz)),
        rela: rela.map(|a| (a, relasz)),
    })
}

/// Symbol count from a `DT_GNU_HASH` table: one past the last symbol of the highest bucket's chain.
fn gnu_hash_nsyms(img: &Img, gh: u64) -> Option<u64> {
    let h = img.get(gh, 16)?;
    let w = |o: usize| u32::from_le_bytes(h[o..o + 4].try_into().unwrap());
    let (nbuckets, symoffset, bloom_size) = (w(0) as u64, w(4) as u64, w(8) as u64);
    if nbuckets == 0 || nbuckets > MAX_SYMS as u64 || bloom_size > MAX_SYMS as u64 {
        return None;
    }
    let buckets = gh.checked_add(16)?.checked_add(bloom_size * 8)?;
    let chains = buckets.checked_add(nbuckets * 4)?;
    let b = img.get(buckets, nbuckets as usize * 4)?;
    let max_bucket = b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as u64).max()?;
    if max_bucket < symoffset {
        return Some(symoffset);
    }
    let mut i = max_bucket;
    while i - symoffset < MAX_SYMS as u64 {
        let word = img.u32(chains.checked_add((i - symoffset) * 4)?)?;
        if word & 1 != 0 {
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// Name of `.dynsym` entry `index`.
fn read_sym_name(img: &Img, d: &ElfDyn, index: u64) -> Option<String> {
    if index >= d.nsyms {
        return None;
    }
    let s = img.get(d.symtab.checked_add(index * SYM_SIZE)?, 4)?;
    let name_off = u32::from_le_bytes(s[0..4].try_into().unwrap()) as u64;
    img.cstr(d.strtab.checked_add(name_off)?)
}

fn elf_exports(img: &Img) -> Option<Vec<Export>> {
    let d = elf_dyn(img)?;
    let table = img.get(d.symtab, (d.nsyms * SYM_SIZE) as usize)?;
    let mut out = vec![];
    for s in table.chunks_exact(SYM_SIZE as usize) {
        let kind = match s[4] & 0xf {
            1 => SymKind::Object,
            2 => SymKind::Func,
            10 => SymKind::Ifunc,
            _ => continue,
        };
        let shndx = u16::from_le_bytes(s[6..8].try_into().unwrap());
        let value = u64::from_le_bytes(s[8..16].try_into().unwrap());
        if shndx == 0 {
            continue; // undefined: an import, not an export
        }
        let name_off = u32::from_le_bytes(s[0..4].try_into().unwrap()) as u64;
        let Some(name) = d.strtab.checked_add(name_off).and_then(|a| img.cstr(a)).filter(|n| !n.is_empty()) else {
            continue;
        };
        out.push(Export { name, address: value.wrapping_add(d.bias), kind, forwarder: None });
    }
    Some(out)
}

fn elf_got_slots(img: &Img, name: &str) -> Option<Vec<u64>> {
    let d = elf_dyn(img)?;
    let mut slots = vec![];
    // Symbol index -> whether it's `name`; most relocations name a different symbol.
    let mut verdict: std::collections::HashMap<u64, bool> = Default::default();
    for (start, size) in [d.jmprel, d.rela].into_iter().flatten() {
        let size = size.min(MAX_SYMS as u64 * RELA_SIZE) as usize / RELA_SIZE as usize * RELA_SIZE as usize;
        let Some(table) = img.get(start, size) else { continue };
        for r in table.chunks_exact(RELA_SIZE as usize) {
            let offset = u64::from_le_bytes(r[0..8].try_into().unwrap());
            let info = u64::from_le_bytes(r[8..16].try_into().unwrap());
            let (sym, ty) = (info >> 32, info as u32);
            if ty != R_X86_64_JUMP_SLOT && ty != R_X86_64_GLOB_DAT {
                continue;
            }
            let hit = *verdict.entry(sym).or_insert_with(|| read_sym_name(img, &d, sym).is_some_and(|n| n == name));
            if hit {
                slots.push(offset.wrapping_add(d.bias));
            }
        }
    }
    slots.sort_unstable();
    slots.dedup();
    Some(slots)
}

// ---------------------------------------------------------------- public API

/// Exports of `m`; empty when the image is unreadable or malformed.
pub fn exports_with(read: Reader, m: &Module) -> Vec<Export> {
    let img = Img::new(read, m);
    match m.kind {
        Kind::Pe => pe_entries(&img).map(|v| v.into_iter().map(|(_, e)| e).collect()),
        Kind::Elf => elf_exports(&img),
    }
    .unwrap_or_default()
}

/// The export `name` of `m`, not following forwarders. On PE a name of the form `#<n>` selects by ordinal.
fn find_export(read: Reader, m: &Module, name: &str) -> Option<Export> {
    let img = Img::new(read, m);
    if m.kind == Kind::Pe {
        let entries = pe_entries(&img)?;
        let ord = name.strip_prefix('#').and_then(|n| n.parse::<u32>().ok());
        return entries
            .into_iter()
            .find(|(o, e)| e.name == name || Some(*o) == ord)
            .map(|(_, e)| e);
    }
    elf_exports(&img)?.into_iter().find(|e| e.name == name)
}

/// Address of `name` in module `module` (matched case-insensitively), following PE forwarders
/// (`"DLL.Name"`, with `.dll` appended to the module name) across `mods`, at most 8 hops.
pub fn resolve_with(read: Reader, mods: &[Module], module: &str, name: &str) -> Result<u64, RpcError> {
    let (mut module, mut name) = (module.to_string(), name.to_string());
    for _ in 0..=MAX_HOPS {
        let m = modules::find(mods, &module).ok_or_else(|| RpcError::module_not_found(format!("module not found: {module}")))?;
        let e = find_export(read, m, &name)
            .ok_or_else(|| RpcError::symbol_not_found(format!("{module} has no export {name}")))?;
        let Some(fwd) = e.forwarder else { return Ok(e.address) };
        let (dll, sym) = fwd
            .split_once('.')
            .ok_or_else(|| RpcError::symbol_not_found(format!("bad forwarder {fwd:?} for {name}")))?;
        let lower = dll.to_ascii_lowercase();
        module = if lower.ends_with(".dll") || lower.ends_with(".exe") { dll.to_string() } else { format!("{dll}.dll") };
        name = sym.to_string();
    }
    Err(RpcError::symbol_not_found(format!("forwarder chain for {name} exceeds {MAX_HOPS} hops")))
}

/// Slot addresses of the `R_X86_64_JUMP_SLOT` and `R_X86_64_GLOB_DAT` relocations of `m` that import `name`.
pub fn got_slots_with(read: Reader, m: &Module, name: &str) -> Vec<u64> {
    if m.kind != Kind::Elf {
        return vec![];
    }
    elf_got_slots(&Img::new(read, m), name).unwrap_or_default()
}

fn target_reader(t: &Target) -> impl Fn(u64, usize) -> Option<Vec<u8>> + '_ {
    move |addr, len| mem::read_bytes(t, addr, len).ok()
}

pub fn exports(t: &Target, m: &Module) -> Result<Vec<Export>, RpcError> {
    Ok(exports_with(&target_reader(t), m))
}

pub fn resolve(t: &Target, mods: &[Module], module: &str, name: &str) -> Result<u64, RpcError> {
    resolve_with(&target_reader(t), mods, module, name)
}

pub fn got_slots(t: &Target, m: &Module, name: &str) -> Result<Vec<u64>, RpcError> {
    Ok(got_slots_with(&target_reader(t), m, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(name: &str, base: u64, size: u64, kind: Kind) -> Module {
        Module { name: name.into(), base, size, path: format!("/x/{name}"), kind }
    }

    /// Reader over several `(base, bytes)` images.
    fn reader(images: Vec<(u64, Vec<u8>)>) -> impl Fn(u64, usize) -> Option<Vec<u8>> {
        move |addr, len| {
            images.iter().find_map(|(base, buf)| {
                let off = addr.checked_sub(*base)? as usize;
                buf.get(off..off.checked_add(len)?).map(<[u8]>::to_vec)
            })
        }
    }

    fn put(buf: &mut [u8], off: usize, bytes: &[u8]) {
        buf[off..off + bytes.len()].copy_from_slice(bytes);
    }

    /// PE32+ image (RVA == offset) exporting `(name, rva)` entries; an rva inside the export
    /// directory (0x200..0x400) is written as a forwarder string at that rva.
    fn pe(exports: &[(&str, u32)], forwarders: &[(u32, &str)]) -> Vec<u8> {
        let mut b = vec![0u8; 0x1000];
        put(&mut b, 0, b"MZ");
        put(&mut b, 0x3c, &0x40u32.to_le_bytes());
        put(&mut b, 0x40, b"PE\0\0");
        put(&mut b, 0x58, &0x20bu16.to_le_bytes());
        put(&mut b, 0x58 + 112, &0x200u32.to_le_bytes()); // export dir RVA
        put(&mut b, 0x58 + 116, &0x200u32.to_le_bytes()); // export dir size
        let n = exports.len() as u32;
        put(&mut b, 0x200 + 0x10, &1u32.to_le_bytes()); // ordinal base
        put(&mut b, 0x200 + 0x14, &n.to_le_bytes());
        put(&mut b, 0x200 + 0x18, &n.to_le_bytes());
        put(&mut b, 0x200 + 0x1c, &0x600u32.to_le_bytes());
        put(&mut b, 0x200 + 0x20, &0x700u32.to_le_bytes());
        put(&mut b, 0x200 + 0x24, &0x800u32.to_le_bytes());
        let mut name_at = 0x900;
        for (i, (name, rva)) in exports.iter().enumerate() {
            put(&mut b, 0x600 + i * 4, &rva.to_le_bytes());
            put(&mut b, 0x700 + i * 4, &(name_at as u32).to_le_bytes());
            put(&mut b, 0x800 + i * 2, &(i as u16).to_le_bytes());
            put(&mut b, name_at, name.as_bytes());
            name_at += name.len() + 1;
        }
        for (rva, text) in forwarders {
            put(&mut b, *rva as usize, text.as_bytes());
        }
        b
    }

    #[test]
    fn pe_exports_by_name() {
        let base = 0x10_0000;
        let img = pe(&[("Alpha", 0x1000), ("Beta", 0x1010)], &[]);
        let m = module("a.dll", base, 0x1000, Kind::Pe);
        let got = exports_with(&reader(vec![(base, img)]), &m);
        assert_eq!(
            got,
            vec![
                Export { name: "Alpha".into(), address: base + 0x1000, kind: SymKind::Func, forwarder: None },
                Export { name: "Beta".into(), address: base + 0x1010, kind: SymKind::Func, forwarder: None },
            ]
        );
    }

    #[test]
    fn pe_forwarder_is_reported() {
        let base = 0x10_0000;
        // 0x300 lies inside the export directory (0x200..0x400): a forwarder string, not code.
        let img = pe(&[("QueryPerformanceCounter", 0x300)], &[(0x300, "NTDLL.RtlQueryPerformanceCounter\0")]);
        let m = module("kernel32.dll", base, 0x1000, Kind::Pe);
        let got = exports_with(&reader(vec![(base, img)]), &m);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].forwarder.as_deref(), Some("NTDLL.RtlQueryPerformanceCounter"));
        assert_eq!(got[0].address, 0);
    }

    #[test]
    fn resolve_follows_forwarders_across_modules_case_insensitively() {
        let (kb, nb) = (0x10_0000u64, 0x20_0000u64);
        let k = pe(&[("QueryPerformanceCounter", 0x300)], &[(0x300, "NTDLL.RtlQueryPerformanceCounter\0")]);
        let n = pe(&[("RtlQueryPerformanceCounter", 0x1234)], &[]);
        let mods = vec![module("kernel32.dll", kb, 0x1000, Kind::Pe), module("ntdll.dll", nb, 0x1000, Kind::Pe)];
        let r = reader(vec![(kb, k), (nb, n)]);
        assert_eq!(resolve_with(&r, &mods, "KERNEL32.DLL", "QueryPerformanceCounter"), Ok(nb + 0x1234));
        assert_eq!(resolve_with(&r, &mods, "kernel32.dll", "Nope").unwrap_err().code, -32008);
        assert_eq!(resolve_with(&r, &mods, "missing.dll", "x").unwrap_err().code, -32005);
    }

    #[test]
    fn resolve_follows_ordinal_forwarders_and_stops_after_eight_hops() {
        let (ab, bb) = (0x10_0000u64, 0x20_0000u64);
        // a!Go -> b.#1, and b's export #1 is "Real".
        let a = pe(&[("Go", 0x300)], &[(0x300, "b.#1\0")]);
        let b = pe(&[("Real", 0x1500)], &[]);
        let mods = vec![module("a.dll", ab, 0x1000, Kind::Pe), module("b.dll", bb, 0x1000, Kind::Pe)];
        assert_eq!(resolve_with(&reader(vec![(ab, a), (bb, b)]), &mods, "a.dll", "Go"), Ok(bb + 0x1500));
        // A forwarder loop must end in an error, not spin.
        let looped = pe(&[("Go", 0x300)], &[(0x300, "a.Go\0")]);
        let mods = vec![module("a.dll", ab, 0x1000, Kind::Pe)];
        let err = resolve_with(&reader(vec![(ab, looped)]), &mods, "a.dll", "Go").unwrap_err();
        assert_eq!(err.code, -32008);
        assert!(err.message.contains("hops"), "{}", err.message);
    }

    #[test]
    fn malformed_images_yield_empty_lists_not_panics() {
        let base = 0x10_0000;
        let zero = vec![0u8; 0x1000];
        for kind in [Kind::Pe, Kind::Elf] {
            let m = module("z", base, 0x1000, kind);
            assert!(exports_with(&reader(vec![(base, zero.clone())]), &m).is_empty());
            assert!(exports_with(&reader(vec![]), &m).is_empty());
        }
        // A PE whose export tables point outside the module.
        let mut bad = pe(&[("A", 0x1000)], &[]);
        put(&mut bad, 0x200 + 0x1c, &0xffff_f000u32.to_le_bytes());
        let m = module("bad.dll", base, 0x1000, Kind::Pe);
        assert!(exports_with(&reader(vec![(base, bad)]), &m).is_empty());
        assert!(got_slots_with(&reader(vec![(base, zero)]), &module("z", base, 0x1000, Kind::Elf), "x").is_empty());
    }

    #[test]
    fn unterminated_string_at_module_end_terminates() {
        let base = 0x10_0000;
        // Export name and forwarder strings that run to the module's last byte with no NUL.
        let mut img = pe(&[("A", 0x1000), ("B", 0x300)], &[]);
        put(&mut img, 0x700, &0xff8u32.to_le_bytes());
        put(&mut img, 0x704, &0x900u32.to_le_bytes());
        put(&mut img, 0xff8, b"ABCDEFGH");
        put(&mut img, 0x300, b"NTDLL.Unterminated"); // forwarder text ...
        img[0x312..0x400].fill(b'x'); // ... padded, still inside the dir and NUL-free
        let m = module("a.dll", base, 0x1000, Kind::Pe);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = reader(vec![(base, img)]);
            let _ = tx.send((exports_with(&r, &m), resolve_with(&r, &[m.clone()], "a.dll", "B")));
        });
        let (list, res) = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("parsing hung on an unterminated string");
        assert!(list.iter().all(|e| e.name != "ABCDEFGH"), "{list:?}");
        assert!(res.is_err());
    }

    const SYMS: &[(&str, u8, u16)] = &[
        // (name, st_info, st_shndx); index 0 is the null symbol.
        ("", 0, 0),
        ("foo", 0x12, 5),          // GLOBAL FUNC
        ("ifn", 0x1a, 5),          // GLOBAL GNU_IFUNC
        ("obj", 0x11, 6),          // GLOBAL OBJECT
        ("gettimeofday", 0x12, 0), // undefined import
        ("other", 0x12, 0),        // undefined import
        ("tls", 0x16, 7),          // TLS: not reported
    ];

    /// 64-bit ELF image at `base` with PT_LOAD vaddr 0 (bias == base). `abs` stores dynamic pointers as
    /// absolute addresses (as glibc does after relocation) instead of link-time addresses.
    fn elf(base: u64, abs: bool, gnu: bool) -> Vec<u8> {
        let mut b = vec![0u8; 0x2000];
        put(&mut b, 0, b"\x7fELF");
        b[4] = 2;
        b[5] = 1;
        put(&mut b, 0x20, &0x40u64.to_le_bytes());
        put(&mut b, 0x36, &56u16.to_le_bytes());
        put(&mut b, 0x38, &2u16.to_le_bytes());
        // PT_LOAD vaddr 0, PT_DYNAMIC vaddr 0x100
        put(&mut b, 0x40, &PT_LOAD.to_le_bytes());
        put(&mut b, 0x40 + 40, &0x2000u64.to_le_bytes());
        put(&mut b, 0x78, &PT_DYNAMIC.to_le_bytes());
        put(&mut b, 0x78 + 16, &0x100u64.to_le_bytes());
        put(&mut b, 0x78 + 40, &0x100u64.to_le_bytes());
        // dynstr at 0x400, dynsym at 0x200
        let mut str_at = 1;
        for (i, (name, info, shndx)) in SYMS.iter().enumerate() {
            let s = 0x200 + i * 24;
            if !name.is_empty() {
                put(&mut b, s, &(str_at as u32).to_le_bytes());
                put(&mut b, 0x400 + str_at, name.as_bytes());
                str_at += name.len() + 1;
            }
            b[s + 4] = *info;
            put(&mut b, s + 6, &shndx.to_le_bytes());
            put(&mut b, s + 8, &(0x1000 + i as u64 * 0x10).to_le_bytes());
        }
        let n = SYMS.len() as u32;
        if gnu {
            // nbuckets 2, symoffset 2, bloom 1 word; buckets [2, 4]; chains for syms 2..6: [0,1,0,0,1]
            put(&mut b, 0x500, &2u32.to_le_bytes());
            put(&mut b, 0x504, &2u32.to_le_bytes());
            put(&mut b, 0x508, &1u32.to_le_bytes());
            put(&mut b, 0x500 + 16 + 8, &2u32.to_le_bytes());
            put(&mut b, 0x500 + 16 + 12, &4u32.to_le_bytes());
            for (i, w) in [0u32, 1, 0, 0, 1].iter().enumerate() {
                put(&mut b, 0x500 + 16 + 8 + 8 + i * 4, &w.to_le_bytes());
            }
        } else {
            put(&mut b, 0x504, &n.to_le_bytes()); // nchain
        }
        // JMPREL at 0x600: JUMP_SLOT(gettimeofday) @0x1800, JUMP_SLOT(other) @0x1808
        // RELA at 0x640: GLOB_DAT(gettimeofday) @0x1810, RELATIVE @0x1818, GLOB_DAT(other) @0x1820
        let rela = |b: &mut Vec<u8>, at: usize, off: u64, sym: u64, ty: u32| {
            put(b, at, &off.to_le_bytes());
            put(b, at + 8, &((sym << 32) | ty as u64).to_le_bytes());
        };
        rela(&mut b, 0x600, 0x1800, 4, 7);
        rela(&mut b, 0x618, 0x1808, 5, 7);
        rela(&mut b, 0x640, 0x1810, 4, 6);
        rela(&mut b, 0x658, 0x1818, 0, 8);
        rela(&mut b, 0x670, 0x1820, 5, 6);
        let p = |off: u64| if abs { base + off } else { off };
        let dynamic: Vec<(u64, u64)> = vec![
            (DT_SYMTAB, p(0x200)),
            (DT_STRTAB, p(0x400)),
            (if gnu { DT_GNU_HASH } else { DT_HASH }, p(0x500)),
            (DT_JMPREL, p(0x600)),
            (DT_PLTRELSZ, 48),
            (DT_RELA, p(0x640)),
            (DT_RELASZ, 72),
            (DT_NULL, 0),
        ];
        for (i, (tag, val)) in dynamic.iter().enumerate() {
            put(&mut b, 0x100 + i * 16, &tag.to_le_bytes());
            put(&mut b, 0x100 + i * 16 + 8, &val.to_le_bytes());
        }
        b
    }

    #[test]
    fn elf_exports_report_kinds_and_skip_imports() {
        let base = 0x7000_0000u64;
        for (abs, gnu) in [(false, false), (true, false), (false, true), (true, true)] {
            let m = module("libx.so", base, 0x2000, Kind::Elf);
            let got = exports_with(&reader(vec![(base, elf(base, abs, gnu))]), &m);
            let summary: Vec<_> = got.iter().map(|e| (e.name.as_str(), e.kind, e.address)).collect();
            assert_eq!(
                summary,
                vec![
                    ("foo", SymKind::Func, base + 0x1010),
                    ("ifn", SymKind::Ifunc, base + 0x1020),
                    ("obj", SymKind::Object, base + 0x1030),
                ],
                "abs={abs} gnu={gnu}"
            );
        }
    }

    #[test]
    fn gnu_hash_symbol_count() {
        let base = 0x7000_0000u64;
        let m = module("libx.so", base, 0x2000, Kind::Elf);
        let r = reader(vec![(base, elf(base, true, true))]);
        let img = Img::new(&r, &m);
        // The highest bucket starts at symbol 4 and its chain ends at symbol 6, so 7 symbols.
        assert_eq!(gnu_hash_nsyms(&img, base + 0x500), Some(7));
        // Buckets all below symoffset: nothing hashed, count is symoffset.
        let mut buf = elf(base, true, true);
        put(&mut buf, 0x500 + 16 + 8, &1u32.to_le_bytes());
        put(&mut buf, 0x500 + 16 + 12, &0u32.to_le_bytes());
        let r = reader(vec![(base, buf)]);
        assert_eq!(gnu_hash_nsyms(&Img::new(&r, &m), base + 0x500), Some(2));
    }

    #[test]
    fn got_slots_from_rela_tables() {
        let base = 0x7000_0000u64;
        let m = module("target", base, 0x2000, Kind::Elf);
        for abs in [false, true] {
            let r = reader(vec![(base, elf(base, abs, false))]);
            assert_eq!(got_slots_with(&r, &m, "gettimeofday"), vec![base + 0x1800, base + 0x1810], "abs={abs}");
            assert_eq!(got_slots_with(&r, &m, "other"), vec![base + 0x1808, base + 0x1820]);
            assert!(got_slots_with(&r, &m, "absent").is_empty());
        }
    }

    #[test]
    fn non_pic_executable_pointers_are_absolute() {
        // PT_LOAD vaddr == base (bias 0), dynamic pointers hold link-time == runtime addresses.
        let base = 0x40_0000u64;
        let mut b = elf(0, false, false);
        put(&mut b, 0x40 + 16, &base.to_le_bytes()); // first PT_LOAD vaddr
        put(&mut b, 0x78 + 16, &(base + 0x100).to_le_bytes());
        for i in 0..7 {
            let at = 0x100 + i * 16 + 8;
            let v = u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
            if i != 4 && i != 6 {
                put(&mut b, at, &(base + v).to_le_bytes());
            }
        }
        // symbol values / relocation offsets are link-time vaddrs; rebase them to match.
        for i in 0..SYMS.len() {
            put(&mut b, 0x200 + i * 24 + 8, &(base + 0x1000 + i as u64 * 0x10).to_le_bytes());
        }
        for at in [0x600, 0x618, 0x640, 0x658, 0x670] {
            let off = u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
            put(&mut b, at, &(base + off).to_le_bytes());
        }
        let m = module("target", base, 0x2000, Kind::Elf);
        let r = reader(vec![(base, b)]);
        assert_eq!(exports_with(&r, &m)[0].address, base + 0x1010);
        assert_eq!(got_slots_with(&r, &m, "gettimeofday"), vec![base + 0x1800, base + 0x1810]);
    }
}
