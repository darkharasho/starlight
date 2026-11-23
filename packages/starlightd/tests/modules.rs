mod common;
use common::*;
use serde_json::{json, Value};

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn modules(c: &mut Client, t: &Target) -> Vec<Value> {
    let h = c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone();
    c.call("modules", json!({"handle": h})).unwrap()["modules"].as_array().unwrap().clone()
}

#[test]
fn lists_main_elf_module_named_target() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let mods = modules(&mut c, &t);
    let m = mods.iter().find(|m| m["name"] == "target").expect("target module");
    assert_eq!(m["kind"], "elf");
    let (base, size) = (hex(m["base"].as_str().unwrap()), hex(m["size"].as_str().unwrap()));
    let a = hex(&t.addr("g_health"));
    assert!(base <= a && a < base + size, "g_health {a:#x} not in {base:#x}+{size:#x}");
}

#[test]
fn lists_mapped_pe_file_as_pe_module() {
    let dir = std::env::temp_dir().join(format!("starlightd-pe-{}/dir with space", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("GameAssembly.dll");
    let mut bytes = minimal_pe(0x3000);
    bytes.resize(0x3000, 0);
    std::fs::write(&path, bytes).unwrap();

    let t = Target::spawn(&["--map", path.to_str().unwrap()]);
    let d = Daemon::start();
    let mut c = d.client();
    let mods = modules(&mut c, &t);
    let m = mods.iter().find(|m| m["name"] == "GameAssembly.dll").expect("pe module");
    assert_eq!(m["kind"], "pe");
    assert_eq!(m["base"], t.addr("mapped"));
    assert_eq!(m["size"], "0x3000");
    assert_eq!(m["path"], path.to_str().unwrap());
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}
