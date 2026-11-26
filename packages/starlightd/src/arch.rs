//! Target bitness. Two facts per target:
//! - `process_bits`: the ELF class of `/proc/<pid>/exe`. It decides how remote calls are made.
//! - `code_bits`: the PE optional-header magic of the game's exe (or `process_bits` for a process
//!   with no PE images). It decides pointer size, the assembler, disasm and speed. Under Proton the
//!   exe may not be mapped yet at attach, so it is resolved lazily and can be unknown.
use crate::mem;
use crate::modules::{self, Kind};
use crate::process::Target;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bits {
    B32,
    B64,
}

impl Bits {
    pub fn n(self) -> u32 {
        match self {
            Bits::B32 => 32,
            Bits::B64 => 64,
        }
    }

    pub fn ptr_size(self) -> usize {
        match self {
            Bits::B32 => 4,
            Bits::B64 => 8,
        }
    }
}

/// The bitness of an ELF file from its header (`EI_CLASS`), or `None` if it isn't ELF.
pub fn elf_class_bits(header: &[u8]) -> Option<Bits> {
    if header.get(0..4)? != b"\x7fELF" {
        return None;
    }
    match header.get(4)? {
        1 => Some(Bits::B32),
        2 => Some(Bits::B64),
        _ => None,
    }
}

/// The bitness a PE optional-header magic stands for: 0x10b is PE32, 0x20b is PE32+.
pub fn pe_bits(optional_magic: u16) -> Option<Bits> {
    match optional_magic {
        0x10b => Some(Bits::B32),
        0x20b => Some(Bits::B64),
        _ => None,
    }
}

/// The optional-header magic of a PE image header, or `None` if it isn't one.
pub fn pe_magic(header: &[u8]) -> Option<u16> {
    if header.get(0..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(header.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if header.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let opt = pe.checked_add(24)?;
    Some(u16::from_le_bytes(header.get(opt..opt.checked_add(2)?)?.try_into().ok()?))
}

/// Wine's own programs, which run in every prefix and never say anything about the game.
const WINE_PROGRAMS: &[&str] = &[
    "start.exe",
    "wineboot.exe",
    "services.exe",
    "winedevice.exe",
    "plugplay.exe",
    "explorer.exe",
    "rpcss.exe",
    "svchost.exe",
    "conhost.exe",
];

pub fn is_wine_program(name: &str) -> bool {
    WINE_PROGRAMS.iter().any(|w| w.eq_ignore_ascii_case(name))
}

/// The ELF class of `/proc/<pid>/exe`.
pub fn process_bits(pid: i32) -> std::io::Result<Bits> {
    use std::io::Read;
    let mut h = [0u8; 5];
    std::fs::File::open(format!("/proc/{pid}/exe"))?.read_exact(&mut h)?;
    elf_class_bits(&h).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "not an ELF executable"))
}

/// The game code's bitness, from the modules mapped right now. `None` while it can't be told yet.
pub fn detect_code_bits(t: &Target) -> Option<Bits> {
    let mods = modules::list(t).ok()?;
    detect_from(&mods, t.main_module.as_deref(), t.process_bits, |m| {
        mem::read_bytes(t, m.base, 0x1000).ok().as_deref().and_then(pe_magic).and_then(pe_bits)
    })
}

/// `detect_code_bits` over a module list; `bits_of` reads one PE module's header.
pub fn detect_from(
    mods: &[modules::Module],
    main_module: Option<&str>,
    process_bits: Bits,
    bits_of: impl Fn(&modules::Module) -> Option<Bits>,
) -> Option<Bits> {
    let pe: Vec<&modules::Module> = mods.iter().filter(|m| m.kind == Kind::Pe).collect();
    if let Some(name) = main_module {
        return pe.iter().find(|m| m.name.eq_ignore_ascii_case(name)).and_then(|m| bits_of(m));
    }
    if pe.is_empty() {
        return Some(process_bits);
    }
    let exe = pe.iter().find(|m| m.name.to_ascii_lowercase().ends_with(".exe") && !is_wine_program(&m.name))?;
    bits_of(exe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::Module;

    fn m(name: &str, kind: Kind) -> Module {
        Module { name: name.into(), base: 0, size: 0x1000, path: format!("/x/{name}"), kind }
    }

    #[test]
    fn elf_class() {
        assert_eq!(elf_class_bits(b"\x7fELF\x01\x01\x01"), Some(Bits::B32));
        assert_eq!(elf_class_bits(b"\x7fELF\x02\x01\x01"), Some(Bits::B64));
        assert_eq!(elf_class_bits(b"MZ\x90\x00\x02"), None);
    }

    #[test]
    fn pe_magic_bits() {
        assert_eq!(pe_bits(0x10b), Some(Bits::B32));
        assert_eq!(pe_bits(0x20b), Some(Bits::B64));
        assert_eq!(pe_bits(0), None);
    }

    #[test]
    fn wine_programs_case_insensitive() {
        assert!(is_wine_program("Start.EXE"));
        assert!(!is_wine_program("game.exe"));
    }

    #[test]
    fn sizes() {
        assert_eq!((Bits::B32.n(), Bits::B32.ptr_size()), (32, 4));
        assert_eq!((Bits::B64.n(), Bits::B64.ptr_size()), (64, 8));
    }

    #[test]
    fn detect_skips_wine_programs_and_uses_the_game_exe() {
        let mods = vec![m("libc.so.6", Kind::Elf), m("start.exe", Kind::Pe), m("ntdll.dll", Kind::Pe), m("Game.exe", Kind::Pe)];
        let got = detect_from(&mods, None, Bits::B64, |m| Some(if m.name == "Game.exe" { Bits::B32 } else { Bits::B64 }));
        assert_eq!(got, Some(Bits::B32));
    }

    #[test]
    fn detect_is_unknown_while_only_wine_pe_modules_are_mapped() {
        let mods = vec![m("start.exe", Kind::Pe), m("ntdll.dll", Kind::Pe)];
        assert_eq!(detect_from(&mods, None, Bits::B64, |_| Some(Bits::B64)), None);
    }

    #[test]
    fn detect_without_pe_modules_is_process_bits() {
        let mods = vec![m("target32", Kind::Elf)];
        assert_eq!(detect_from(&mods, None, Bits::B32, |_| None), Some(Bits::B32));
    }

    #[test]
    fn detect_uses_the_named_main_module_or_waits_for_it() {
        let mods = vec![m("a.exe", Kind::Pe), m("w32.EXE", Kind::Pe)];
        let bits = |m: &Module| Some(if m.name == "w32.EXE" { Bits::B32 } else { Bits::B64 });
        assert_eq!(detect_from(&mods, Some("w32.exe"), Bits::B64, bits), Some(Bits::B32));
        assert_eq!(detect_from(&mods, Some("later.exe"), Bits::B64, bits), None);
    }

    #[test]
    fn pe_magic_reads_the_optional_header() {
        let mut h = vec![0u8; 0x200];
        h[0..2].copy_from_slice(b"MZ");
        h[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
        h[0x40..0x44].copy_from_slice(b"PE\0\0");
        h[0x58..0x5a].copy_from_slice(&0x10bu16.to_le_bytes());
        assert_eq!(pe_magic(&h), Some(0x10b));
        assert_eq!(pe_magic(&h[..0x30]), None);
    }
}
