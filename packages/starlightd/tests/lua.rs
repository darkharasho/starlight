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
