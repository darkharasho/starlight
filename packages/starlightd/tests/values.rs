mod common;
use common::*;
use serde_json::{json, Value};
use std::time::Duration;

const SCAN_TIMEOUT: Duration = Duration::from_secs(30);

fn attach(c: &mut Client, t: &Target) -> Value {
    c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone()
}

fn first(c: &mut Client, params: Value) -> (Value, u64) {
    let r = c.call_timeout("scan_first", params, SCAN_TIMEOUT).unwrap();
    (r["scan"].clone(), r["count"].as_u64().unwrap())
}

fn next(c: &mut Client, params: Value) -> u64 {
    c.call_timeout("scan_next", params, SCAN_TIMEOUT).unwrap()["count"].as_u64().unwrap()
}

/// Every result of `scan`, paging 1000 at a time: (address, value).
fn all_results(c: &mut Client, scan: &Value) -> Vec<(String, Value)> {
    let mut out = vec![];
    loop {
        let r = c.call("scan_results", json!({"scan": scan, "offset": out.len(), "limit": 1000})).unwrap();
        let page = r["results"].as_array().unwrap();
        if page.is_empty() {
            break;
        }
        out.extend(page.iter().map(|e| (e["address"].as_str().unwrap().to_string(), e["value"].clone())));
        if out.len() as u64 >= r["count"].as_u64().unwrap() {
            break;
        }
    }
    out
}

fn value_at(results: &[(String, Value)], addr: &str) -> Option<Value> {
    results.iter().find(|(a, _)| a == addr).map(|(_, v)| v.clone())
}

#[test]
fn exact_int32_finds_g_health() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, count) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "100"}));
    assert!(count >= 1);
    let results = all_results(&mut c, &scan);
    assert_eq!(results.len() as u64, count);
    assert_eq!(value_at(&results, &t.addr("g_health")), Some(json!("100")));
}

#[test]
fn next_scan_narrows_after_write() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, first_count) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "100"}));
    c.call("write", json!({"handle": h, "address": t.addr("g_health"), "bytes": "65000000"})).unwrap();
    let count = next(&mut c, json!({"scan": scan, "mode": "increased"}));
    assert!(count < first_count, "{count} !< {first_count}");
    let results = all_results(&mut c, &scan);
    assert_eq!(value_at(&results, &t.addr("g_health")), Some(json!("101")));
    // A value typed after the write narrows further.
    assert!(next(&mut c, json!({"scan": scan, "mode": "exact", "value": "101"})) >= 1);
    assert!(value_at(&all_results(&mut c, &scan), &t.addr("g_health")).is_some());
}

#[test]
fn unknown_then_changed_finds_counter() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, unknown_count) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "unknown"}));
    // The writer thread's stack alone is 8 MiB, so this starts as a dense (on-disk) session.
    assert!(unknown_count > 1_000_000, "{unknown_count}");
    std::thread::sleep(Duration::from_millis(200));
    let changed = next(&mut c, json!({"scan": scan, "mode": "changed"}));
    assert!(changed >= 1 && changed < unknown_count, "{changed}");
    std::thread::sleep(Duration::from_millis(200));
    let increased = next(&mut c, json!({"scan": scan, "mode": "increased"}));
    assert!(increased >= 1 && increased <= changed);
    let results = all_results(&mut c, &scan);
    assert!(value_at(&results, &t.addr("g_counter")).is_some(), "g_counter missing from {} results", results.len());
}

#[test]
fn unchanged_keeps_static_values() {
    let t = Target::spawn(&["--writer"]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "unknown"}));
    std::thread::sleep(Duration::from_millis(200));
    next(&mut c, json!({"scan": scan, "mode": "unchanged"}));
    let count = next(&mut c, json!({"scan": scan, "mode": "exact", "value": "100"}));
    assert!(count >= 1);
    let results = all_results(&mut c, &scan);
    assert!(value_at(&results, &t.addr("g_health")).is_some());
    assert!(value_at(&results, &t.addr("g_counter")).is_none(), "a changing value survived unchanged");
}

#[test]
fn results_are_paged() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, count) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "0"}));
    assert!(count > 3, "{count}");
    let r = c.call("scan_results", json!({"scan": scan, "limit": 2})).unwrap();
    assert_eq!(r["count"].as_u64().unwrap(), count);
    assert_eq!(r["results"].as_array().unwrap().len(), 2);
    let r2 = c.call("scan_results", json!({"scan": scan, "offset": 1, "limit": 2})).unwrap();
    assert_eq!(r2["results"][0]["address"], r["results"][1]["address"], "offset 1 starts at the second result");
    let e = c.call("scan_results", json!({"scan": scan, "limit": 5000})).unwrap_err();
    assert_eq!(e.0, -32602);
}

#[test]
fn float_and_double_and_string() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "float", "mode": "exact", "value": "1.5"}));
    assert_eq!(value_at(&all_results(&mut c, &scan), &t.addr("g_speed")), Some(json!("1.5")));
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "double", "mode": "exact", "value": "3.14"}));
    assert!(value_at(&all_results(&mut c, &scan), &t.addr("g_pi")).is_some());
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "double", "mode": "exact", "value": "3.15"}));
    assert!(value_at(&all_results(&mut c, &scan), &t.addr("g_pi")).is_none(), "3.15 must not match 3.14159");
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "string", "mode": "exact", "value": "Hero"}));
    assert_eq!(value_at(&all_results(&mut c, &scan), &t.addr("g_name")), Some(json!("Hero")));
}

#[test]
fn bytes_scan_with_wildcards_finds_marker() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, count) = first(&mut c, json!({"handle": h, "type": "bytes", "mode": "exact", "value": "DE AD BE EF ?? FE BA BE"}));
    assert!(count >= 1);
    assert_eq!(value_at(&all_results(&mut c, &scan), &t.addr("g_aob_marker")), Some(json!("deadbeefcafebabe")));
}

#[test]
fn bad_scan_params_are_32602() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    for p in [
        json!({"handle": h, "type": "int33", "mode": "exact", "value": "1"}),
        json!({"handle": h, "type": "int32", "mode": "changed"}),
        json!({"handle": h, "type": "int32", "mode": "exact"}),
        json!({"handle": h, "type": "uint8", "mode": "exact", "value": "256"}),
        json!({"handle": h, "type": "string", "mode": "unknown"}),
        json!({"handle": h, "type": "int32", "mode": "exact", "value": "1", "alignment": 3}),
    ] {
        let e = c.call_timeout("scan_first", p.clone(), SCAN_TIMEOUT).unwrap_err();
        assert_eq!(e.0, -32602, "{p}");
    }
    assert_eq!(c.call("scan_next", json!({"scan": 999, "mode": "changed"})).unwrap_err().0, -32009);
    assert_eq!(c.call("scan_end", json!({"scan": 999})).unwrap_err().0, -32009);
}

#[test]
fn scan_next_after_target_exit_is_32002() {
    let mut t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "100"}));
    t.kill();
    let e = c.call_timeout("scan_next", json!({"scan": scan, "mode": "unchanged"}), SCAN_TIMEOUT).unwrap_err();
    assert_eq!(e.0, -32002);
    assert_eq!(c.call("scan_results", json!({"scan": scan})).unwrap_err().0, -32002);
    assert_eq!(c.call("hello", json!({})).unwrap()["protocol"], 3);
    // The session stays registered until it is ended.
    c.call("scan_end", json!({"scan": scan})).unwrap();
    assert_eq!(c.call("scan_results", json!({"scan": scan})).unwrap_err().0, -32009);
}

#[test]
fn detach_ends_scans() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "100"}));
    assert!(c.call("scan_results", json!({"scan": scan})).is_ok());
    c.call("detach", json!({"handle": h})).unwrap();
    assert_eq!(c.call("scan_results", json!({"scan": scan})).unwrap_err().0, -32009);
}

#[test]
fn scan_end_removes_session() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let (scan, _) = first(&mut c, json!({"handle": h, "type": "int32", "mode": "exact", "value": "100"}));
    c.call("scan_end", json!({"scan": scan})).unwrap();
    assert_eq!(c.call("scan_results", json!({"scan": scan})).unwrap_err().0, -32009);
    assert_eq!(c.call("scan_end", json!({"scan": scan})).unwrap_err().0, -32009);
}

#[test]
fn read_many_mixes_good_and_unreadable() {
    let t = Target::spawn(&[]);
    let d = Daemon::start();
    let mut c = d.client();
    let h = attach(&mut c, &t);
    let r = c
        .call("read_many", json!({"handle": h, "items": [
            {"address": t.addr("g_health"), "length": 4},
            {"address": "0x0", "length": 4},
        ]}))
        .unwrap();
    assert_eq!(r["values"], json!(["64000000", null]));
    let e = c.call("read_many", json!({"handle": h, "items": [{"address": "0x1000", "length": 4097}]})).unwrap_err();
    assert_eq!(e.0, -32602);
}

#[test]
fn hello_lists_scan_capabilities() {
    let d = Daemon::start();
    let mut c = d.client();
    let caps = c.call("hello", json!({})).unwrap()["capabilities"].clone();
    let caps: Vec<&str> = caps.as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(caps.contains(&"scan") && caps.contains(&"read_many"), "{caps:?}");
}
