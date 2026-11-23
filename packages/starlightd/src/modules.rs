//! Module listing from `/proc/<pid>/maps`: native ELF objects and Wine/Proton PE images.
use crate::maps::{self, Region};
use crate::mem;
use crate::process::Target;
use crate::rpc::RpcError;
use serde::{Serialize, Serializer};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Elf,
    Pe,
}

impl Serialize for Kind {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match self {
            Kind::Elf => "elf",
            Kind::Pe => "pe",
        })
    }
}

fn ser_hex<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format!("{v:#x}"))
}

#[derive(Debug, Clone, Serialize)]
pub struct Module {
    pub name: String,
    #[serde(serialize_with = "ser_hex")]
    pub base: u64,
    #[serde(serialize_with = "ser_hex")]
    pub size: u64,
    pub path: String,
    pub kind: Kind,
}

const PE_HEADER_LEN: usize = 0x1000;

/// `SizeOfImage` from a PE header (PE32 and PE32+), or `None` if `header` isn't a PE image.
pub fn pe_size_of_image(header: &[u8]) -> Option<u64> {
    let u32_at = |o: usize| -> Option<u32> {
        Some(u32::from_le_bytes(header.get(o..o.checked_add(4)?)?.try_into().ok()?))
    };
    if header.get(0..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(0x3c)? as usize;
    if header.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    // PE signature (4) + COFF header (20) precede the optional header.
    let opt = pe.checked_add(24)?;
    let magic = u16::from_le_bytes(header.get(opt..opt + 2)?.try_into().ok()?);
    if magic != 0x10b && magic != 0x20b {
        return None;
    }
    u32_at(opt + 56).map(u64::from)
}

fn is_pe_path(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    l.ends_with(".dll") || l.ends_with(".exe")
}

fn is_file_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("/memfd:") && !path.starts_with("/dev/")
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn list(t: &Target) -> Result<Vec<Module>, RpcError> {
    let regions = maps::read(t.pid).map_err(|e| match e.raw_os_error() {
        Some(libc::ENOENT) | Some(libc::ESRCH) => RpcError::process_not_found(format!("pid {} has exited", t.pid)),
        _ => RpcError::read_failed(format!("cannot read maps of pid {}: {e}", t.pid)),
    })?;
    Ok(build(&regions, |addr| mem::read_bytes(t, addr, PE_HEADER_LEN).ok()))
}

/// Lowest start and total span of a group's regions.
fn extent(rs: &[&Region]) -> (u64, u64) {
    let base = rs.iter().map(|r| r.start).min().unwrap();
    let end = rs.iter().map(|r| r.end).max().unwrap();
    (base, end - base)
}

/// Largest plausible PE `SizeOfImage`; anything bigger (or zero) is treated as a corrupt header.
const MAX_IMAGE: u64 = 2 << 30;

/// Group file-backed regions by path (first-seen order) into modules.
fn build(regions: &[Region], read_header: impl Fn(u64) -> Option<Vec<u8>>) -> Vec<Module> {
    let mut order: Vec<&str> = vec![];
    let mut groups: HashMap<&str, Vec<&Region>> = HashMap::new();
    for r in regions {
        let Some(p) = r.path.as_deref().filter(|p| is_file_path(p)) else { continue };
        groups.entry(p).or_insert_with(|| {
            order.push(p);
            vec![]
        })
        .push(r);
    }
    let mut out = vec![];
    for path in order {
        let rs = &groups[path];
        let name = basename(path).to_string();
        if is_pe_path(path) {
            // Several offset-0 regions can exist; prefer a parseable header, then the image
            // that covers the most of this path's regions, then the lowest address.
            let best = rs
                .iter()
                .filter(|r| r.offset == 0)
                .filter_map(|r| {
                    let size = read_header(r.start).and_then(|h| pe_size_of_image(&h)).filter(|&s| s > 0 && s <= MAX_IMAGE)?;
                    let covered = rs.iter().filter(|o| o.start >= r.start && o.start - r.start < size).count();
                    Some((covered, r.start, size))
                })
                .max_by_key(|&(covered, start, _)| (covered, std::cmp::Reverse(start)));
            let (base, size) = best.map(|(_, b, s)| (b, s)).unwrap_or_else(|| extent(rs));
            out.push(Module { name, base, size, path: path.to_string(), kind: Kind::Pe });
        } else {
            let (base, size) = extent(rs);
            out.push(Module { name, base, size, path: path.to_string(), kind: Kind::Elf });
        }
    }
    out
}

/// ASCII case-insensitive lookup by module name.
pub fn find<'a>(list: &'a [Module], name: &str) -> Option<&'a Module> {
    list.iter().find(|m| m.name.eq_ignore_ascii_case(name))
}

#[cfg(test)]
fn minimal_pe(size_of_image: u32) -> Vec<u8> {
    let mut h = vec![0u8; 0x200];
    h[0..4].copy_from_slice(&[0x4D, 0x5A, 0x90, 0x00]);
    h[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    h[0x40..0x44].copy_from_slice(b"PE\0\0");
    h[0x44..0x46].copy_from_slice(&0x8664u16.to_le_bytes());
    h[0x54..0x56].copy_from_slice(&0xF0u16.to_le_bytes());
    h[0x58..0x5a].copy_from_slice(&0x20bu16.to_le_bytes());
    h[0x58 + 56..0x58 + 60].copy_from_slice(&size_of_image.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pe_size_of_image_from_minimal_header() {
        assert_eq!(pe_size_of_image(&minimal_pe(0x5000)), Some(0x5000));
    }

    #[test]
    fn non_pe_header_is_none() {
        assert_eq!(pe_size_of_image(b"\x7fELF...."), None);
        assert_eq!(pe_size_of_image(b"MZ"), None);
    }

    #[test]
    fn pe_module_lookup_is_case_insensitive() {
        let list = vec![Module {
            name: "GameAssembly.dll".into(),
            base: 0x1000,
            size: 0x3000,
            path: "/x/GameAssembly.dll".into(),
            kind: Kind::Pe,
        }];
        assert!(find(&list, "gameassembly.dll").is_some());
        assert!(find(&list, "other.dll").is_none());
    }

    #[test]
    fn build_groups_regions_and_skips_pseudo_paths() {
        let text = "400000-401000 r--p 00000000 00:00 1 /bin/t\n401000-403000 r-xp 00001000 00:00 1 /bin/t\n\
                    500000-501000 rw-p 00000000 00:00 0 [heap]\n\
                    7f0000-7f1000 r--p 00000000 00:00 2 /g/A.DLL\n7f1000-7f3000 r-xp 00001000 00:00 2 /g/A.DLL\n";
        let regions = maps::parse(text);
        let pe = minimal_pe(0x3000);
        let mods = build(&regions, |a| (a == 0x7f0000).then(|| pe.clone()));
        assert_eq!(mods.len(), 2);
        assert_eq!((mods[0].name.as_str(), mods[0].base, mods[0].size, mods[0].kind), ("t", 0x400000, 0x3000, Kind::Elf));
        assert_eq!((mods[1].name.as_str(), mods[1].base, mods[1].size, mods[1].kind), ("A.DLL", 0x7f0000, 0x3000, Kind::Pe));
    }

    fn pe_mods(text: &str, headers: &[(u64, u32)]) -> Vec<Module> {
        let regions = maps::parse(text);
        build(&regions, |a| headers.iter().find(|(h, _)| *h == a).map(|(_, s)| minimal_pe(*s)))
    }

    #[test]
    fn unreadable_pe_header_falls_back_to_extent() {
        let text = "7f0000-7f1000 r--p 00000000 00:00 2 /g/GameAssembly.dll\n7f1000-7f3000 r-xp 00001000 00:00 2 /g/GameAssembly.dll\n";
        let m = pe_mods(text, &[]);
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].base, m[0].size, m[0].kind), (0x7f0000, 0x3000, Kind::Pe));
    }

    #[test]
    fn pe_without_offset_zero_region_falls_back_to_extent() {
        let text = "7f1000-7f3000 r-xp 00001000 00:00 2 /g/a.dll\n";
        let m = pe_mods(text, &[]);
        assert_eq!((m[0].base, m[0].size, m[0].kind), (0x7f1000, 0x2000, Kind::Pe));
    }

    #[test]
    fn insane_size_of_image_is_unparseable() {
        let text = "7f0000-7f1000 r--p 00000000 00:00 2 /g/a.dll\n7f1000-7f3000 r-xp 00001000 00:00 2 /g/a.dll\n";
        for bad in [0u32, 0x8000_0001] {
            let m = pe_mods(text, &[(0x7f0000, bad)]);
            assert_eq!((m[0].base, m[0].size), (0x7f0000, 0x3000), "size {bad:#x}");
        }
    }

    #[test]
    fn multiple_offset_zero_prefers_parseable_then_most_coverage_then_lowest() {
        // Unparseable lowest region is skipped.
        let text = "100000-101000 r--p 00000000 00:00 2 /g/a.dll\n200000-201000 r--p 00000000 00:00 2 /g/a.dll\n";
        let m = pe_mods(text, &[(0x200000, 0x1000)]);
        assert_eq!((m[0].base, m[0].size), (0x200000, 0x1000));
        // Most same-path regions inside the image wins over a lower start.
        let text = "100000-101000 r--p 00000000 00:00 2 /g/a.dll\n\
                    200000-201000 r--p 00000000 00:00 2 /g/a.dll\n201000-203000 r-xp 00001000 00:00 2 /g/a.dll\n";
        let m = pe_mods(text, &[(0x100000, 0x1000), (0x200000, 0x3000)]);
        assert_eq!((m[0].base, m[0].size), (0x200000, 0x3000));
        // Tie goes to the lowest start.
        let text = "100000-101000 r--p 00000000 00:00 2 /g/a.dll\n200000-201000 r--p 00000000 00:00 2 /g/a.dll\n";
        let m = pe_mods(text, &[(0x100000, 0x1000), (0x200000, 0x1000)]);
        assert_eq!(m[0].base, 0x100000);
    }
}
