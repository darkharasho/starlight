//! Parser for `/proc/<pid>/maps`.
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Perms {
    pub read: bool,
    pub write: bool,
    pub exec: bool,
    pub shared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Region {
    pub start: u64,
    pub end: u64,
    pub perms: Perms,
    pub offset: u64,
    pub path: Option<String>,
}

/// Split off the next whitespace-separated field, returning (field, rest).
fn next_field(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

fn parse_line(line: &str) -> Option<Region> {
    let (range, rest) = next_field(line)?;
    let (perms, rest) = next_field(rest)?;
    let (offset, rest) = next_field(rest)?;
    let (_dev, rest) = next_field(rest)?;
    let (_inode, rest) = next_field(rest)?;
    let (s, e) = range.split_once('-')?;
    let start = u64::from_str_radix(s, 16).ok()?;
    let end = u64::from_str_radix(e, 16).ok()?;
    let offset = u64::from_str_radix(offset, 16).ok()?;
    let p = perms.as_bytes();
    if p.len() < 4 {
        return None;
    }
    let mut path = rest.trim();
    if let Some(stripped) = path.strip_suffix(" (deleted)") {
        path = stripped.trim_end();
    }
    Some(Region {
        start,
        end,
        perms: Perms {
            read: p[0] == b'r',
            write: p[1] == b'w',
            exec: p[2] == b'x',
            shared: p[3] == b's',
        },
        offset,
        path: if path.is_empty() { None } else { Some(path.to_string()) },
    })
}

pub fn parse(text: &str) -> Vec<Region> {
    text.lines().filter_map(parse_line).collect()
}

pub fn read(pid: i32) -> io::Result<Vec<Region>> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/maps"))?;
    Ok(parse(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_line() {
        let r = parse("00400000-00401000 r-xp 00000000 08:01 1234  /usr/bin/target\n");
        assert_eq!(r[0].start, 0x400000);
        assert_eq!(r[0].end, 0x401000);
        assert!(r[0].perms.read && r[0].perms.exec && !r[0].perms.write);
        assert_eq!(r[0].path.as_deref(), Some("/usr/bin/target"));
    }

    #[test]
    fn parses_path_with_spaces_and_deleted_suffix() {
        let r = parse("7f0000000000-7f0000001000 r--p 00000000 00:2a 99 /home/u/.steam/steamapps/common/9 Kings/GameAssembly.dll (deleted)\n");
        assert_eq!(
            r[0].path.as_deref(),
            Some("/home/u/.steam/steamapps/common/9 Kings/GameAssembly.dll")
        );
    }

    #[test]
    fn anonymous_and_pseudo_paths() {
        let r = parse("1000-2000 rw-p 00000000 00:00 0 \n3000-4000 rw-p 00000000 00:00 0  [heap]\n");
        assert_eq!(r[0].path, None);
        assert_eq!(r[1].path.as_deref(), Some("[heap]"));
    }

    #[test]
    fn shared_flag_and_offset() {
        let r = parse("1000-2000 rw-s 00001000 00:00 0\n");
        assert!(r[0].perms.shared);
        assert_eq!(r[0].offset, 0x1000);
    }
}
