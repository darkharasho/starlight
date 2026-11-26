mod common;
use common::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

struct L {
    c: Client,
    id: Value,
    h: Value,
}

fn open(t: &Target) -> (Daemon, L) {
    let d = Daemon::start();
    let mut c = d.client();
    let h = c.call("attach", json!({"pid": t.pid})).unwrap()["handle"].clone();
    let id = c.call("lua_open", json!({"handle": h})).unwrap()["id"].clone();
    (d, L { c, id, h })
}

impl L {
    fn run_with(&mut self, chunk: &str, extra: Value) -> Value {
        let mut p = json!({"id": self.id, "chunk": chunk, "name": "test", "symbols": {}});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        self.c.call("lua_run", p).unwrap()
    }
    fn run(&mut self, chunk: &str) -> Value {
        self.run_with(chunk, json!({}))
    }
    fn ret(&mut self, chunk: &str) -> Value {
        let r = self.run(chunk);
        assert_eq!(r["ok"], true, "{chunk}: {r}");
        r["returned"].clone()
    }
}

#[test]
fn run_returns_string() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(l.ret("return 'nop'"), "nop");
    assert_eq!(l.ret("return 5"), Value::Null);
    assert_eq!(l.ret("local x = 1"), Value::Null);
}

#[test]
fn state_persists() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    l.ret("function f() return 'x' end");
    assert_eq!(l.ret("return f()"), "x");
}

#[test]
fn globals_are_overridable() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    l.ret("function showMessage(t) shown = t end");
    let r = l.run("showMessage('a') return shown");
    assert_eq!(r["returned"], "a");
    assert_eq!(r["notices"], json!([]));
}

#[test]
fn api_names_are_case_insensitive() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(l.ret("return tostring(GetCEVersion()) .. tostring(getceversion())"), "7.57.5");
}

#[test]
fn sandbox() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(
        l.ret("return tostring(io) .. tostring(os.execute) .. tostring(require) .. tostring(dofile) .. tostring(debug) .. tostring(package) .. tostring(loadstring)"),
        "nilnilnilnilnilnilnil"
    );
    assert_eq!(l.ret("return type(os.clock())"), "number");
    assert_eq!(l.ret("local f, e = load(string.dump(function() end)) return tostring(f)"), "nil");
    assert_eq!(l.ret("return load('return 1+1')() == 2 and 'ok' or 'no'"), "ok");
}

#[test]
fn budget_aborts_infinite_loop() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let start = Instant::now();
    let r = l.run("while true do end");
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(r["ok"], false);
    assert!(r["error"].as_str().unwrap().contains("time limit"), "{r}");
    // The connection still answers, and the state still runs.
    let h = l.h.clone();
    l.c.call("read", json!({"handle": h, "address": t.addr("g_health"), "length": 4})).unwrap();
    assert_eq!(l.ret("return 'alive'"), "alive");
    let r = l.run("sleep(100000)");
    assert_eq!(r["ok"], false);
    assert!(start.elapsed() < Duration::from_secs(6));
}

#[test]
fn notices() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = l.run("showMessage('hi') print('p', 2) shellExecute('https://x.y') return tostring(messageDialog('q', mtConfirmation, mbYes, mbNo) == mrYes)");
    assert_eq!(r["returned"], "true");
    assert_eq!(
        r["notices"],
        json!([
            {"kind": "message", "text": "hi"},
            {"kind": "message", "text": "p 2"},
            {"kind": "link", "text": "https://x.y"},
            {"kind": "message", "text": "q"},
        ])
    );
    assert_eq!(l.ret("return tostring(messageDialog('ok?', mtInformation, mbOK) == mrOk)"), "true");
}

#[test]
fn inert() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(
        l.ret("getMainForm().Menu.Items.add(createMenuItem(nil)); local x = getMainForm().Panel4; x.Visible = false; return tostring(getCEVersion())"),
        "7.5"
    );
    assert_eq!(l.ret("return tostring(LaunchMonoDataCollector())"), "0");
    assert_eq!(l.ret("local s = createStringlist(); s.add('a'); s:add('b'); return s[1] .. s.Count"), "b2");
    assert_eq!(l.ret("return synchronize(function(a) return a end, 'z')"), "z");
}

#[test]
fn syntaxcheck_and_memrec() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(l.run_with("return tostring(syntaxcheck)", json!({"syntaxcheck": true}))["returned"], "true");
    assert_eq!(l.run_with("return tostring(syntaxcheck)", json!({}))["returned"], "false");
    let r = l.run_with("memrec.Color = 5; return memrec.Description", json!({"memrec": {"id": 3, "description": "God", "value": "1"}}));
    assert_eq!(r["returned"], "God");
    assert_eq!(l.ret("return tostring(process ~= nil and process ~= '')"), "true");
}

#[test]
fn errors_report_line() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = l.run("\n\nerror('boom')");
    assert_eq!(r["ok"], false);
    assert_eq!(r["line"], 3);
    assert_eq!(r["error"], "boom");
    let r = l.run("this is not lua");
    assert_eq!(r["ok"], false);
    assert_eq!(r["line"], 1);
}

#[test]
fn close_and_unknown_id() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let id = l.id.clone();
    l.c.call("lua_close", json!({"id": id})).unwrap();
    assert!(l.c.call("lua_run", json!({"id": id, "chunk": "return 1"})).is_err());
}

fn syms(t: &Target, names: &[&str]) -> Value {
    let mut m = serde_json::Map::new();
    for n in names {
        m.insert(n.to_string(), Value::String(t.addr(n)));
    }
    json!({ "symbols": m })
}

#[test]
fn read_write_numbers() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let s = syms(&t, &["g_health", "g_speed", "g_pi", "g_souls", "g_name"]);
    assert_eq!(l.run_with("return tostring(readInteger('g_health'))", s.clone())["returned"], "100");
    assert_eq!(l.run_with("writeInteger('g_health', 1234) return tostring(readInteger('g_health'))", s.clone())["returned"], "1234");
    assert_eq!(l.run_with("return tostring(readFloat('g_speed'))", s.clone())["returned"], "1.5");
    assert_eq!(l.run_with("writeFloat('g_speed', 2.25) return tostring(readFloat('g_speed'))", s.clone())["returned"], "2.25");
    assert_eq!(l.run_with("return string.format('%.5f', readDouble('g_pi'))", s.clone())["returned"], "3.14159");
    assert_eq!(l.run_with("return tostring(readQword('g_souls'))", s.clone())["returned"], "50000");
    assert_eq!(
        l.run_with("writeInteger('g_health', -1) return readInteger('g_health') .. ' ' .. readInteger('g_health', true)", s.clone())["returned"],
        "4294967295 -1"
    );
    assert_eq!(l.run_with("return tostring(readSmallInteger('g_health'))", s.clone())["returned"], "65535");
    assert_eq!(l.run_with("local b = readBytes('g_name', 4, true) return #b .. ':' .. b[1]", s.clone())["returned"], "4:72");
    assert_eq!(l.run_with("local a, b = readBytes('g_name', 2) return a .. ',' .. b", s.clone())["returned"], "72,101");
    assert_eq!(l.run_with("return readString('g_name')", s.clone())["returned"], "Hero");
    assert_eq!(l.run_with("writeString('g_name', 'Zed') writeBytes('g_name+3', 0) return readString('g_name', 16)", s.clone())["returned"], "Zed");
    assert_eq!(l.run_with("writeBytes('g_name', {0x41, 0x42}) return readString('g_name', 2)", s.clone())["returned"], "AB");
}

#[test]
fn bad_addresses() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(l.ret("return tostring(readInteger(0))"), "nil");
    assert_eq!(l.ret("return tostring(writeInteger(0, 1))"), "false");
    assert_eq!(l.ret("return tostring(readInteger('nosuch+10'))"), "nil");
    assert_eq!(l.ret("return tostring(getAddressSafe('nosuch+10'))"), "nil");
    let r = l.run("return getAddress('nosuch+10')");
    assert_eq!(r["ok"], false);
    assert!(r["error"].as_str().unwrap().contains("nosuch"), "{r}");
}

#[test]
fn expressions() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let health = u64::from_str_radix(t.addr("g_health").trim_start_matches("0x"), 16).unwrap();
    // pbase holds a pointer to g_health: write it into g_souls.
    let s = json!({ "symbols": { "pBase": t.addr("g_souls"), "hp": t.addr("g_health") } });
    l.run_with(&format!("writeQword('pBase', {health})"), s.clone());
    let got = |l: &mut L, e: &str| -> u64 {
        let r = l.run_with(&format!("return string.format('%x', getAddress('{e}'))"), s.clone());
        u64::from_str_radix(r["returned"].as_str().unwrap_or_else(|| panic!("{e}: {r}")), 16).unwrap()
    };
    assert_eq!(got(&mut l, "hp+4"), health + 4);
    assert_eq!(got(&mut l, "HP-0x10"), health - 0x10);
    assert_eq!(got(&mut l, "[pBase]"), health);
    assert_eq!(got(&mut l, "[pBase]+#16"), health + 16);
    let base = got(&mut l, "target");
    assert_eq!(got(&mut l, "target+10"), base + 0x10);
    assert_eq!(got(&mut l, "\"target\"+10"), base + 0x10);
    assert_eq!(l.run_with("return tostring(readInteger('[pBase]'))", s.clone())["returned"], "100");
    assert_eq!(l.run_with(&format!("return tostring(readInteger({health}))"), s.clone())["returned"], "100");
    assert_eq!(l.run_with("return getNameFromAddress(getAddress('target+10'))", s.clone())["returned"], "target+10");
}

#[test]
fn register_effects() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = l.run("registerSymbol('foo', 0x1234) return string.format('%x', getAddress('FOO'))");
    assert_eq!(r["returned"], "1234");
    assert_eq!(r["effects"], json!([{ "op": "registerSymbol", "name": "foo", "address": "0x1234" }]));
    // Each run gets the table's symbols from the app, which applied the first run's effect.
    let r = l.run_with("registerSymbol('bar', 'foo+2') unregisterSymbol('foo') error('later')", json!({"symbols": {"foo": "0x1234"}}));
    assert_eq!(r["ok"], false);
    assert_eq!(
        r["effects"],
        json!([{ "op": "registerSymbol", "name": "bar", "address": "0x1236" }, { "op": "unregisterSymbol", "name": "foo" }])
    );
}

#[test]
fn open_process() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    assert_eq!(l.ret("return tostring(openProcess('target'))"), "true");
    assert_eq!(l.ret("return tostring(openProcess('TARGET'))"), "true");
    assert_eq!(l.ret("return tostring(openProcess('other.exe'))"), "false");
    assert_eq!(l.ret("return tostring(getOpenedProcessID())"), t.pid.to_string());
    assert_eq!(l.ret("return tostring(targetIs64Bit())"), "true");
}

#[test]
fn aob() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let marker = t.addr("g_aob_marker").trim_start_matches("0x").to_uppercase();
    let want = format!("{:X}", u64::from_str_radix(&marker, 16).unwrap());
    let r = l.ret("local r = aobScanModule('target', 'DEADBEEFCAFEBABE12345678') return r.Count .. ' ' .. r[0]");
    assert_eq!(r, format!("1 {want}"));
    let r = l.ret("local r = AOBScanModule('target', 'DE AD BE EF ?? ?? BA BE 12 34 56 78') return r.getString(0)");
    assert_eq!(r, want);
    assert_eq!(l.ret("return string.format('%X', aobScanModuleUnique('target', 'DE AD BE EF CA FE BA BE 12 34 56 78'))"), want);
    assert_eq!(l.ret("return tostring(aobScanModule('target', 'DE AD 01 02 03 04 05 06 07 08 09 0A'))"), "nil");
    // aobScan without a module looks at executable memory only (like the AA compiler's aobscan); the marker is data.
    assert_eq!(l.ret("return tostring(aobScan('DE AD BE EF CA FE BA BE 12 34 56 78'))"), "nil");
}

#[test]
fn api_list_matches() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let api: Value = serde_json::from_str(include_str!("../../ct-importer/src/lua-api.json")).unwrap();
    for k in ["real", "inert"] {
        for name in api[k].as_array().unwrap() {
            let name = name.as_str().unwrap();
            assert_eq!(l.ret(&format!("return type({name})")), "function", "{name} is missing");
        }
    }
}

/// Each of these would hang a run or flood memory without the budget's guards.
fn ends_in_time(l: &mut L, chunk: &str) -> Value {
    let start = Instant::now();
    let r = l.run(chunk);
    assert!(start.elapsed() < Duration::from_secs(4), "{chunk} took {:?}", start.elapsed());
    assert_eq!(r["ok"], false, "{chunk}: {r}");
    r
}

#[test]
fn pcall_cannot_swallow_the_time_limit() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = ends_in_time(&mut l, "while true do pcall(function() while true do end end) end");
    assert!(r["error"].as_str().unwrap().contains("time limit"), "{r}");
    ends_in_time(&mut l, "while true do xpcall(function() while true do end end, function(e) return e end) end");
    // pcall still works for ordinary errors.
    assert_eq!(l.ret("local ok = pcall(error, 'x') return tostring(ok)"), "false");
}

#[test]
fn c_functions_are_bounded() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    ends_in_time(&mut l, "return string.rep('', 1 << 62)");
    ends_in_time(&mut l, "return string.rep('ab', 1 << 40)");
    ends_in_time(&mut l, "return ('x'):rep(1 << 62)");
    ends_in_time(&mut l, "table.move({}, 1, math.maxinteger - 10, 1)");
    ends_in_time(&mut l, "return string.find(string.rep('a', 20000), '.-.-.-.-.-.-.-b')");
    ends_in_time(&mut l, "return ('a'):rep(20000):match('.-.-.-.-.-.-.-b')");
    // Ordinary use still works.
    assert_eq!(l.ret("return string.rep('ab', 3, '-') .. #string.rep('x', 1000)"), "ab-ab-ab1000");
    assert_eq!(l.ret("return tostring(string.find('player hp 100', '%d+'))"), "11");
    assert_eq!(l.ret("local t = table.move({1,2,3}, 1, 3, 2) return tostring(t[4])"), "3");
}

#[test]
fn notices_and_effects_are_capped() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = l.run("local s = string.rep('x', 100000) for i = 1, 500 do print(s) end return 'done'");
    assert_eq!(r["returned"], "done");
    let n = r["notices"].as_array().unwrap();
    assert!(n.len() <= 21, "{} notices", n.len());
    assert!(n.iter().all(|x| x["text"].as_str().unwrap().len() <= 4100));
    let r = l.run("for i = 1, 5000 do registerSymbol('s' .. i, i) end");
    assert_eq!(r["ok"], false);
    assert!(r["effects"].as_array().unwrap().len() <= 1000);
}

#[test]
fn binary_chunks_are_refused() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let r = l.run("\u{1b}LuaS\u{0}");
    assert_eq!(r["ok"], false, "{r}");
}

#[test]
fn std_list_matches() {
    let t = Target::spawn(&[]);
    let (_d, mut l) = open(&t);
    let api: Value = serde_json::from_str(include_str!("../../ct-importer/src/lua-api.json")).unwrap();
    for name in api["base"].as_array().unwrap() {
        let name = name.as_str().unwrap();
        assert_eq!(l.ret(&format!("return type({name})")), "function", "{name} is missing");
    }
    for (lib, members) in api["libs"].as_object().unwrap() {
        for m in members.as_array().unwrap() {
            let m = m.as_str().unwrap();
            assert_ne!(l.ret(&format!("return type({lib}.{m})")), "nil", "{lib}.{m} is missing");
        }
    }
    assert_eq!(l.ret("return tostring(coroutine)"), "nil");
    assert_eq!(l.ret("return select('#', unpack({1, 2, 3}))"), Value::Null);
    assert_eq!(l.ret("return tostring(select('#', unpack({1, 2, 3})))"), "3");
}

#[test]
fn readpointer_is_4_bytes_on_i386() {
    let t = Target::spawn32(&[]);
    let (_d, mut l) = open(&t);
    let s = syms(&t, &["p1", "p2", "gold"]);
    let hex = |v: &str| u64::from_str_radix(v.trim_start_matches("0x"), 16).unwrap();
    let got = l.run_with("return string.format('%x', readPointer('p1'))", s.clone())["returned"].clone();
    assert_eq!(hex(got.as_str().unwrap()), hex(&t.addr("p2")));
    let got = l.run_with("return string.format('%x', getAddress('[[p1]]'))", s.clone())["returned"].clone();
    assert_eq!(hex(got.as_str().unwrap()), hex(&t.addr("gold")));
    assert_eq!(l.run_with("writePointer('p2', readPointer('p2')) return tostring(readInteger('gold'))", s.clone())["returned"], "1234");
    assert_eq!(l.ret("return tostring(targetIs64Bit())"), "false");
    let t64 = Target::spawn(&[]);
    let (_d2, mut l2) = open(&t64);
    assert_eq!(l2.ret("return tostring(targetIs64Bit())"), "true");
}
