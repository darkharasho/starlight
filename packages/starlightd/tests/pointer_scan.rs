mod common;
use common::*;
use serde_json::{json, Value};

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn module_base(c: &mut Client, h: &Value, name: &str) -> u64 {
    let mods = c.call("modules", json!({"handle": h})).unwrap();
    let m = mods["modules"].as_array().unwrap().iter().find(|m| m["name"] == name).unwrap().clone();
    hex(m["base"].as_str().unwrap())
}

/// All results of a pointer scan, as `(module, base, offsets)`.
fn all_paths(c: &mut Client, id: &Value) -> Vec<(String, u64, Vec<String>)> {
    let r = c.call("pointer_results", json!({"id": id, "offset": 0, "limit": 1000})).unwrap();
    r["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["module"].as_str().unwrap().to_string(),
                hex(p["base"].as_str().unwrap()),
                p["offsets"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect(),
            )
        })
        .collect()
}

fn has_path(paths: &[(String, u64, Vec<String>)], base: u64, offsets: &[&str]) -> bool {
    paths.iter().any(|(m, b, o)| m == "target" && *b == base && o.iter().map(String::as_str).eq(offsets.iter().copied()))
}

#[test]
fn finds_static_path_through_heap() {
    let t = Target::spawn(&["--heap-chain"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let tb = module_base(&mut c, &h, "target");
    let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
    assert!(r["count"].as_u64().unwrap() >= 1);
    let paths = all_paths(&mut c, &r["id"]);
    let base = hex(&t.addr("g_root")) - tb;
    assert!(has_path(&paths, base, &["0x18", "0x10"]), "{paths:?}");
    let rr = c
        .call("resolve_pointer", json!({"handle": h, "module": "target", "base": format!("{base:#x}"), "offsets": ["0x18", "0x10"]}))
        .unwrap();
    assert_eq!(rr["address"], t.addr("heap_value").as_str());
}

#[test]
fn rescan_after_restart_drops_stale_paths() {
    let d = Daemon::start();
    let mut c = d.client();
    let (id, root_base, decoy_base) = {
        let t = Target::spawn(&["--heap-chain", "--decoy"]);
        let h = attach(&mut c, &t);
        let tb = module_base(&mut c, &h, "target");
        let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
        let paths = all_paths(&mut c, &r["id"]);
        let (root_base, decoy_base) = (hex(&t.addr("g_root")) - tb, hex(&t.addr("g_decoy")) - tb);
        assert!(has_path(&paths, root_base, &["0x18", "0x10"]), "{paths:?}");
        assert!(has_path(&paths, decoy_base, &["0x10"]), "{paths:?}");
        (r["id"].clone(), root_base, decoy_base)
        // target dropped (killed) here
    };
    let t2 = Target::spawn(&["--heap-chain"]);
    let h2 = attach(&mut c, &t2);
    let r = c
        .call_timeout("pointer_rescan", json!({"id": id, "handle": h2, "address": t2.addr("heap_value")}), std::time::Duration::from_secs(60))
        .unwrap();
    assert!(r["count"].as_u64().unwrap() >= 1);
    let paths = all_paths(&mut c, &id);
    assert_eq!(paths.len() as u64, r["count"].as_u64().unwrap());
    assert!(has_path(&paths, root_base, &["0x18", "0x10"]), "{paths:?}");
    assert!(!has_path(&paths, decoy_base, &["0x10"]), "{paths:?}");
}

#[test]
fn rescan_without_address_reuses_the_original_target() {
    let t = Target::spawn(&["--heap-chain", "--decoy"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
    let before = r["count"].as_u64().unwrap();
    let again = c.call_timeout("pointer_rescan", json!({"id": r["id"], "handle": h}), std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(again["count"].as_u64().unwrap(), before);
    // A different address keeps nothing that pointed at the original one.
    let other = c
        .call_timeout("pointer_rescan", json!({"id": r["id"], "handle": h, "address": format!("{:#x}", hex(&t.addr("heap_value")) + 0x20)}), std::time::Duration::from_secs(60))
        .unwrap();
    assert_eq!(other["count"], 0);
}

#[test]
fn bare_rescan_after_an_explicit_one_uses_the_last_good_address() {
    let t = Target::spawn(&["--heap-chain", "--decoy"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let hv = t.addr("heap_value");
    let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": hv}), std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(r["truncated"], false);
    let count = r["count"].as_u64().unwrap();
    // Explicit rescan with a new (valid) address: the same paths resolve to the same address.
    let a = c.call_timeout("pointer_rescan", json!({"id": r["id"], "handle": h, "address": hv}), std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(a["count"].as_u64().unwrap(), count);
    let b = c.call_timeout("pointer_rescan", json!({"id": r["id"], "handle": h}), std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(b["count"].as_u64().unwrap(), count);
}

#[test]
fn bare_rescan_after_restart_keeps_the_paths() {
    let d = Daemon::start();
    let mut c = d.client();
    let id = {
        let t = Target::spawn(&["--heap-chain"]);
        let h = attach(&mut c, &t);
        c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap()["id"].clone()
    };
    let t2 = Target::spawn(&["--heap-chain"]);
    let h2 = attach(&mut c, &t2);
    let first = c.call_timeout("pointer_rescan", json!({"id": id, "handle": h2, "address": t2.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
    assert!(first["count"].as_u64().unwrap() >= 1);
    let bare = c.call_timeout("pointer_rescan", json!({"id": id, "handle": h2}), std::time::Duration::from_secs(60)).unwrap();
    assert_eq!(bare["count"], first["count"]);
}

#[test]
fn depth_limit_is_respected() {
    let t = Target::spawn(&["--heap-chain", "--decoy"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let tb = module_base(&mut c, &h, "target");
    let r = c
        .call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value"), "max_depth": 1}), std::time::Duration::from_secs(60))
        .unwrap();
    let paths = all_paths(&mut c, &r["id"]);
    assert!(has_path(&paths, hex(&t.addr("g_decoy")) - tb, &["0x10"]), "{paths:?}");
    assert!(!has_path(&paths, hex(&t.addr("g_root")) - tb, &["0x18", "0x10"]), "{paths:?}");
    assert!(paths.iter().all(|(_, _, o)| o.len() == 1), "{paths:?}");
}

#[test]
fn results_paging_and_unknown_id() {
    let t = Target::spawn(&["--heap-chain", "--decoy"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
    let id = r["id"].clone();
    let count = r["count"].as_u64().unwrap();
    assert!(count >= 2);
    let p = c.call("pointer_results", json!({"id": id, "offset": 1, "limit": 1})).unwrap();
    assert_eq!(p["count"].as_u64().unwrap(), count);
    assert_eq!(p["results"].as_array().unwrap().len(), 1);
    let full = all_paths(&mut c, &id);
    assert_eq!(p["results"][0]["base"].as_str().unwrap(), format!("{:#x}", full[1].1));
    // Shallower paths sort first.
    assert!(full.windows(2).all(|w| w[0].2.len() <= w[1].2.len()), "{full:?}");
    let e = c.call("pointer_results", json!({"id": id, "limit": 1001})).unwrap_err();
    assert_eq!(e.0, -32602);
    c.call("pointer_end", json!({"id": id})).unwrap();
    assert_eq!(c.call("pointer_results", json!({"id": id})).unwrap_err().0, -32009);
    assert_eq!(c.call("pointer_end", json!({"id": id})).unwrap_err().0, -32009);
    assert_eq!(c.call("pointer_rescan", json!({"id": id, "handle": h})).unwrap_err().0, -32009);
}

#[test]
fn invalid_limits_are_rejected_and_capability_listed() {
    let t = Target::spawn(&["--heap-chain"]);
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    assert!(caps.as_array().unwrap().iter().any(|v| v == "pointer_scan"));
    let h = attach(&mut c, &t);
    let a = t.addr("heap_value");
    for bad in [json!({"max_depth": 8}), json!({"max_depth": 0}), json!({"max_offset": "0x10001"}), json!({"max_results": 100001})] {
        let mut p = json!({"handle": h, "address": a});
        p.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        assert_eq!(c.call("pointer_scan", p).unwrap_err().0, -32602);
    }
}

#[test]
fn sessions_belong_to_the_connection_not_the_handle() {
    let t = Target::spawn(&["--heap-chain"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c.call_timeout("pointer_scan", json!({"handle": h, "address": t.addr("heap_value")}), std::time::Duration::from_secs(60)).unwrap();
    c.call("detach", json!({"handle": h})).unwrap();
    let p = c.call("pointer_results", json!({"id": r["id"], "limit": 1})).unwrap();
    assert!(p["count"].as_u64().unwrap() >= 1);
    // Another connection does not see it.
    let mut c2 = d.client();
    assert_eq!(c2.call("pointer_results", json!({"id": r["id"]})).unwrap_err().0, -32009);
}
