//! Which memory a value or pointer scan looks at (D18).
use crate::maps::Region;

/// `(start, end)` of every region that is readable, writable and private, skipping the kernel's
/// special mappings and device memory (`/dev/*`: GPU and driver buffers are slow or unsafe to read).
pub fn scannable(regions: &[Region]) -> Vec<(u64, u64)> {
    regions
        .iter()
        .filter(|r| r.perms.read && r.perms.write && !r.perms.shared && r.end > r.start)
        .filter(|r| match r.path.as_deref() {
            Some("[vvar]") | Some("[vdso]") | Some("[vsyscall]") => false,
            Some(p) => !p.starts_with("/dev/"),
            None => true,
        })
        .map(|r| (r.start, r.end))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maps;

    #[test]
    fn keeps_private_writable_and_drops_the_rest() {
        let r = maps::parse(
            "1000-2000 rw-p 00000000 00:00 0 [heap]\n\
             2000-3000 r--p 00000000 00:00 0 /usr/lib/libc.so.6\n\
             3000-4000 rw-s 00000000 00:00 0 /memfd:x\n\
             4000-5000 rw-p 00000000 00:00 0 [vvar]\n\
             5000-6000 rw-p 00000000 00:00 0 /dev/dri/renderD128\n\
             6000-7000 rw-p 00000000 00:00 0\n\
             7000-8000 rwxp 00000000 00:00 0 /game/data.bin\n\
             8000-9000 -w-p 00000000 00:00 0\n",
        );
        assert_eq!(scannable(&r), vec![(0x1000, 0x2000), (0x6000, 0x7000), (0x7000, 0x8000)]);
    }
}
