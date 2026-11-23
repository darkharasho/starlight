//! Inline hooks (D10). A near-allocated page holds `[hook body][trampoline]`. The trampoline is
//! the function's displaced instructions, re-encoded at their new address, then a jump back to
//! the rest of the function. The function's entry becomes `jmp body`, written as a recorded patch,
//! so it is reverted with every other patch. The page itself is never freed (D9).
use crate::patch::{ApplyError, Patches};
use crate::process::Target;
use crate::rpc::RpcError;
use crate::tracer::Tracer;
use crate::{asm, disasm, mem, remote};
use iced_x86::{BlockEncoder, BlockEncoderOptions, Code, Decoder, DecoderOptions, FlowControl, Formatter, Instruction, InstructionBlock};
use std::sync::Arc;

/// `E9 rel32`.
const ENTRY_LEN: usize = 5;
const PAGE: u64 = 4096;
/// Trampolines start on this boundary after the body.
const ALIGN: u64 = 16;

/// An installed hook.
#[allow(dead_code)] // used by the speed hooks (Tasks 11-12)
#[derive(Debug, Clone)]
pub struct Hook {
    pub func: u64,
    /// The entry jump's patch, in the connection's `Patches`.
    pub patch_id: u32,
    /// Start of the hook body (and of its page).
    pub code: u64,
    pub trampoline: u64,
    /// The original bytes the entry jump replaced.
    pub displaced: Vec<u8>,
}

#[allow(dead_code)] // used by the speed hooks (Tasks 11-12)
#[derive(Debug)]
pub enum HookError {
    /// The function can't be hooked safely; nothing was changed. Holds the reason.
    Skipped(String),
    Rpc(RpcError),
}

impl From<RpcError> for HookError {
    fn from(e: RpcError) -> Self {
        HookError::Rpc(e)
    }
}

/// Hook `func` for `handle`. `body(trampoline)` returns the hook's assembly source; it runs in
/// place of the function and continues the original by jumping to `trampoline`. The caller holds
/// `tracer` so the allocation and the patch share one attach.
#[allow(dead_code)] // used by the speed hooks (Tasks 11-12)
pub fn install(
    t: &Arc<Target>,
    tracer: &Arc<Tracer>,
    patches: &Patches,
    handle: u32,
    func: u64,
    body: &dyn Fn(u64) -> String,
) -> Result<Hook, HookError> {
    let code = disasm::read_code(t, func, 2 * disasm::MAX_INSN_LEN)?;
    let instrs = displaced(&code, func).map_err(HookError::Skipped)?;
    let len: usize = instrs.iter().map(Instruction::len).sum();
    let original = code[..len].to_vec();
    let page = remote::alloc(t, PAGE, Some(func), libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC)?;
    // Until the entry jump is written nothing can run in the page, so it can still be freed.
    let release = |e: HookError| {
        let _ = remote::free(t, page, PAGE);
        e
    };
    let (image, tramp_off) = layout(page, func, &instrs, body).map_err(release)?;
    mem::write_bytes(t, page, &image).map_err(|e| release(e.into()))?;
    let rel = i32::try_from(page as i64 - (func + ENTRY_LEN as u64) as i64)
        .map_err(|_| release(HookError::Skipped(format!("hook page {page:#x} is out of rel32 reach of {func:#x}"))))?;
    let mut entry = vec![0xE9];
    entry.extend_from_slice(&rel.to_le_bytes());
    entry.resize(len, 0x90);
    // Written only if the function still holds the bytes the trampoline was built from.
    let (patch_id, _) = patches.apply_with(handle, t, tracer.clone(), func, &entry, Some(&original)).map_err(|e| match e {
        ApplyError::NotWritten(e) => release(e.into()),
        ApplyError::Changed(_) => release(HookError::Skipped(format!("the code at {func:#x} changed while hooking"))),
        // The entry jump was live for a moment, so a thread may be in the page: it stays (D9).
        ApplyError::Written(e) => e.into(),
    })?;
    Ok(Hook { func, patch_id, code: page, trampoline: page + tramp_off, displaced: original })
}

/// The page image `[body][int3 padding][trampoline]` and the trampoline's offset. The body's
/// length can depend on where the trampoline is (short or near jumps), so the layout is repeated
/// until the body fits in front of it.
fn layout(page: u64, func: u64, instrs: &[Instruction], body: &dyn Fn(u64) -> String) -> Result<(Vec<u8>, u64), HookError> {
    let len: u64 = instrs.iter().map(|i| i.len() as u64).sum();
    let too_large = || HookError::Rpc(RpcError::invalid_params("hook body does not fit in one page"));
    let mut off = ALIGN;
    for _ in 0..8 {
        let src = body(page + off);
        let a = asm::assemble(&src, page, &|_| None).map_err(|e| HookError::Rpc(RpcError::assemble_failed(e.to_string())))?;
        let need = a.bytes.len() as u64;
        if need <= off {
            let tramp = relocate(instrs, page + off, func + len).map_err(HookError::Skipped)?;
            if off + tramp.len() as u64 > PAGE {
                return Err(too_large());
            }
            let mut image = a.bytes;
            image.resize(off as usize, 0xCC);
            image.extend_from_slice(&tramp);
            return Ok((image, off));
        }
        off = need.next_multiple_of(ALIGN);
        if off >= PAGE {
            return Err(too_large());
        }
    }
    Err(HookError::Rpc(RpcError::internal_error("hook layout did not settle")))
}

/// The whole instructions at the start of `code` (which is at `func`) that an entry jump covers.
/// Refuses (D10) calls, relative branches, `ret`, `int3`/traps, and functions shorter than the jump.
fn displaced(code: &[u8], func: u64) -> Result<Vec<Instruction>, String> {
    let mut fmt = disasm::formatter();
    let mut dec = Decoder::with_ip(64, code, func, DecoderOptions::NONE);
    let mut out = vec![];
    let mut len = 0;
    while len < ENTRY_LEN {
        if !dec.can_decode() {
            return Err(format!("only {len} bytes of code readable at {func:#x}"));
        }
        let ins = dec.decode();
        if ins.is_invalid() {
            return Err(format!("undecodable instruction at {:#x}", ins.ip()));
        }
        let mut text = String::new();
        fmt.format(&ins, &mut text);
        let at = format!("`{text}` at {:#x}", ins.ip());
        let ends_inside = len + ins.len() < ENTRY_LEN;
        match ins.flow_control() {
            FlowControl::Next => {}
            FlowControl::Call | FlowControl::IndirectCall => return Err(format!("displaced instructions contain a call: {at}")),
            FlowControl::UnconditionalBranch | FlowControl::ConditionalBranch | FlowControl::XbeginXabortXend => {
                return Err(format!("displaced instructions contain a relative branch: {at}"))
            }
            FlowControl::Return => return Err(format!("function is shorter than {ENTRY_LEN} bytes: {at}")),
            // `jmp reg`/`jmp [mem]` that ends the displaced range relocates; one inside it ends
            // the function before the entry jump does.
            FlowControl::IndirectBranch if ends_inside => {
                return Err(format!("function is shorter than {ENTRY_LEN} bytes: {at}"))
            }
            FlowControl::IndirectBranch => {}
            FlowControl::Interrupt | FlowControl::Exception => {
                return Err(format!("displaced instructions contain a trap: {at}"))
            }
        }
        len += ins.len();
        out.push(ins);
    }
    Ok(out)
}

/// `instrs` re-encoded at `ip` (RIP-relative operands keep their absolute targets), then a jump
/// to `back`.
fn relocate(instrs: &[Instruction], ip: u64, back: u64) -> Result<Vec<u8>, String> {
    let mut block = instrs.to_vec();
    block.push(Instruction::with_branch(Code::Jmp_rel32_64, back).map_err(|e| e.to_string())?);
    BlockEncoder::encode(64, InstructionBlock::new(&block, ip), BlockEncoderOptions::NONE)
        .map(|r| r.code_buffer)
        .map_err(|e| format!("cannot relocate the displaced instructions to {ip:#x}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::Owner;
    use crate::process::open_target;
    use crate::tracer::tests::TestTarget;
    use std::time::{Duration, Instant};

    fn refusal(code: &[u8]) -> String {
        let mut code = code.to_vec();
        code.resize(32, 0xCC);
        displaced(&code, 0x401000).expect_err("must refuse")
    }

    #[test]
    fn refuses_call_in_displaced_range() {
        // push rbp; call +0
        let r = refusal(&[0x55, 0xE8, 0, 0, 0, 0]);
        assert!(r.contains("call"), "{r}");
        // call qword [rip+0]
        assert!(refusal(&[0xFF, 0x15, 0, 0, 0, 0]).contains("call"));
    }

    #[test]
    fn refuses_branches_and_traps() {
        // test eax,eax; je +5
        assert!(refusal(&[0x85, 0xC0, 0x74, 0x05, 0x90, 0x90]).contains("relative branch"));
        // jmp rel32 as the first instruction
        assert!(refusal(&[0xE9, 0, 0, 0, 0]).contains("relative branch"));
        // nop; int3
        assert!(refusal(&[0x90, 0xCC]).contains("trap"));
    }

    #[test]
    fn refuses_short_function() {
        // xor eax,eax; ret
        let r = refusal(&[0x31, 0xC0, 0xC3]);
        assert!(r.contains("shorter than 5 bytes"), "{r}");
        // jmp rax (an indirect tail jump) inside the range
        assert!(refusal(&[0xFF, 0xE0]).contains("shorter than 5 bytes"));
        // Too little readable code.
        let e = displaced(&[0x90, 0x90], 0x401000).unwrap_err();
        assert!(e.contains("only 2 bytes"), "{e}");
    }

    #[test]
    fn displaces_whole_instructions_and_allows_a_final_indirect_jump() {
        // push rbp; mov rbp,rsp; mov [rbp-4],edi | ...
        let code = [0x55, 0x48, 0x89, 0xE5, 0x89, 0x7D, 0xFC, 0x8B, 0x55, 0xFC];
        let d = displaced(&code, 0x40122C).unwrap();
        assert_eq!(d.iter().map(Instruction::len).collect::<Vec<_>>(), [1, 3, 3]);
        // jmp qword [rip+X] (a thunk) relocates.
        let d = displaced(&[0xFF, 0x25, 0x10, 0, 0, 0, 0xCC], 0x401000).unwrap();
        assert_eq!(d.len(), 1);
    }

    #[test]
    fn relocates_rip_relative_mov() {
        // bump_counter: push rbp; mov rbp,rsp; mov eax,[rip+2EE8] (= g_counter at 404108)
        let func = 0x401216;
        let code = [0x55, 0x48, 0x89, 0xE5, 0x8B, 0x05, 0xE8, 0x2E, 0x00, 0x00, 0x83, 0xC0, 0x01];
        let d = displaced(&code, func).unwrap();
        assert_eq!(d.len(), 3);
        let ip = func + 0x1000_0000;
        let tramp = relocate(&d, ip, func + 10).unwrap();
        let mut dec = Decoder::with_ip(64, &tramp, ip, DecoderOptions::NONE);
        let got: Vec<Instruction> = dec.iter().collect();
        assert_eq!(got.len(), 4, "three displaced instructions and the jump back");
        assert_eq!(&tramp[..4], &code[..4], "position-independent instructions are unchanged");
        assert!(got[2].is_ip_rel_memory_operand());
        assert_eq!(got[2].ip_rel_memory_address(), 0x404108, "the moved mov must read the same g_counter");
        assert_ne!(&tramp[4..10], &code[4..10], "the displacement must be rewritten");
        assert_eq!(got[3].flow_control(), FlowControl::UnconditionalBranch);
        assert_eq!(got[3].near_branch_target(), func + 10);
        // Beyond rel32 reach, iced still keeps the target (here with an addr32 EIP-relative
        // operand, as g_counter is below 4 GiB) and jumps back through `jmp [rip+X]`.
        let far_ip = 0x7f00_0000_0000;
        let far = relocate(&d, far_ip, func + 10).unwrap();
        let got: Vec<Instruction> = Decoder::with_ip(64, &far, far_ip, DecoderOptions::NONE).iter().take(4).collect();
        assert!(got[2].is_ip_rel_memory_operand());
        assert_eq!(got[2].ip_rel_memory_address(), 0x404108);
        assert_eq!(got[3].flow_control(), FlowControl::IndirectBranch);
    }

    fn read_u64(t: &Target, addr: u64) -> u64 {
        u64::from_le_bytes(mem::read_bytes(t, addr, 8).unwrap().try_into().unwrap())
    }

    fn rises(t: &Target, addr: u64) -> bool {
        let a = read_u64(t, addr);
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
            if read_u64(t, addr) > a {
                return true;
            }
        }
        false
    }

    #[test]
    fn inline_hook_runs_body_and_trampoline() {
        // The C test target, launched here; never any other process.
        let tt = TestTarget::spawn(&["--spin"]);
        let t = Arc::new(open_target(tt.pid()).unwrap());
        let (func, calls) = (tt.addrs["spin_target"], tt.addrs["g_spin_calls"]);
        let tracer = t.tracer().unwrap();
        let patches = Patches::new(Arc::new(Owner::default()));
        let counter = remote::alloc(&t, 8, Some(func), libc::PROT_READ | libc::PROT_WRITE).unwrap();
        let original = mem::read_bytes(&t, func, 7).unwrap();
        let hook = install(&t, &tracer, &patches, 1, func, &|tramp| format!("inc qword [{counter:#x}]\njmp {tramp:#x}"))
            .unwrap_or_else(|e| panic!("install: {e:?}"));
        assert_eq!(hook.displaced, original, "push rbp; mov rbp,rsp; mov [rbp-4],edi");
        assert!(hook.code.abs_diff(func) < 1 << 31 && hook.trampoline > hook.code);
        let entry = mem::read_bytes(&t, func, 7).unwrap();
        assert_eq!(entry[0], 0xE9);
        assert_eq!(&entry[5..], [0x90, 0x90]);
        assert!(rises(&t, counter), "the hook body does not run");
        // spin_target still returns to its caller, which keeps counting.
        assert!(rises(&t, calls), "spin_target no longer returns through the trampoline");
        // The body runs once per call (the two reads are a few loop iterations apart).
        let (c0, k0) = (read_u64(&t, counter), read_u64(&t, calls));
        std::thread::sleep(Duration::from_millis(50));
        let (c1, k1) = (read_u64(&t, counter), read_u64(&t, calls));
        let (dc, dk) = (c1 - c0, k1 - k0);
        assert!(dc.abs_diff(dk) <= dk / 50 + 1000, "body ran {dc} times for {dk} calls");

        patches.revert(hook.patch_id, false).unwrap();
        assert_eq!(mem::read_bytes(&t, func, 7).unwrap(), original, "revert did not restore the entry");
        std::thread::sleep(Duration::from_millis(20));
        let stopped = read_u64(&t, counter);
        assert!(rises(&t, calls), "spin_target broke after the revert");
        assert_eq!(read_u64(&t, counter), stopped, "the body still runs after the revert");
        // D9: the hook page stays mapped.
        assert!(mem::read_bytes(&t, hook.code, 1).is_ok());
    }

    #[test]
    fn hook_refusal_changes_nothing() {
        let tt = TestTarget::spawn(&[]);
        let t = Arc::new(open_target(tt.pid()).unwrap());
        let tracer = t.tracer().unwrap();
        let patches = Patches::new(Arc::new(Owner::default()));
        let before = std::fs::read_to_string(format!("/proc/{}/maps", tt.pid())).unwrap();
        // An assembly error in the body: the page is freed again and nothing is patched.
        let e = install(&t, &tracer, &patches, 1, tt.addrs["bump_counter"], &|_| "bogus eax".into()).unwrap_err();
        assert!(matches!(&e, HookError::Rpc(r) if r.code == -32010), "{e:?}");
        assert_eq!(std::fs::read_to_string(format!("/proc/{}/maps", tt.pid())).unwrap(), before, "the page was not freed");
        assert!(patches.revert(1, true).is_err(), "no patch was recorded");
    }

    /// Mapped regions of `pid` as (start, perms).
    fn regions(pid: i32) -> Vec<(u64, String)> {
        std::fs::read_to_string(format!("/proc/{pid}/maps"))
            .unwrap()
            .lines()
            .map(|l| {
                let mut w = l.split_whitespace();
                let start = u64::from_str_radix(w.next().unwrap().split('-').next().unwrap(), 16).unwrap();
                (start, w.next().unwrap().to_string())
            })
            .collect()
    }

    #[test]
    fn hook_page_stays_mapped_once_the_entry_may_have_run() {
        // The session ends while hooking: the entry jump is written, then reverted at once.
        // The game may have entered the page meanwhile, so it must not be unmapped (D9).
        let tt = TestTarget::spawn(&["--spin"]);
        let t = Arc::new(open_target(tt.pid()).unwrap());
        let func = tt.addrs["spin_target"];
        let tracer = t.tracer().unwrap();
        let owner = Arc::new(Owner::default());
        let patches = Patches::new(owner.clone());
        let original = mem::read_bytes(&t, func, 7).unwrap();
        let before = regions(tt.pid());
        owner.run_all();
        let e = install(&t, &tracer, &patches, 1, func, &|tramp| format!("jmp {tramp:#x}")).unwrap_err();
        assert!(matches!(&e, HookError::Rpc(r) if r.code == -32007), "{e:?}");
        assert_eq!(mem::read_bytes(&t, func, 7).unwrap(), original, "the entry was not reverted");
        let new: Vec<_> = regions(tt.pid()).into_iter().filter(|r| !before.contains(r)).collect();
        assert!(new.iter().any(|(a, p)| p == "rwxp" && a.abs_diff(func) < 1 << 31), "the hook page was freed: {new:x?}");
    }
}
