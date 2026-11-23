//! Cheat Engine-style Intel-syntax x86-64 assembler built on iced-x86 (MIT).
//!
//! `assemble(source, address, resolve)` turns CE-style assembly text into machine code for
//! `address`. It reads back everything `disasm` prints, so `assemble(disassemble(x))`
//! round-trips. M4's Auto Assembler compiler extends the subset below.
//!
//! # Accepted subset
//!
//! - One statement per line. `label:` may stand alone or prefix an instruction. Comments are
//!   `//…`, `;…` and `{ … }` (which may span lines). Mnemonics, registers and size keywords are
//!   case-insensitive; labels are matched case-insensitively too.
//! - Prefixes: `lock`, `rep`, `repe`/`repz`, `repne`/`repnz`.
//! - Registers: every 8/16/32/64-bit GPR (including `r8b`–`r15b` (also `r8l`), `r8w`–`r15w`,
//!   `r8d`–`r15d`, `spl`/`bpl`/`sil`/`dil` and `ah`/`bh`/`ch`/`dh`), `xmm0`–`xmm15`, and `fs`/`gs`
//!   as segment overrides.
//! - Numbers are hex by default (`10` = 16), `0x` is accepted, `#` marks decimal (`#10` = 10) and a
//!   leading `-` negates. An identifier that is a valid hex number is a number unless it is a
//!   register, a label in the source, or a symbol `resolve` knows.
//! - Memory: `[base + index*scale ± disp]` with any subset of the parts, an optional size keyword
//!   `byte|word|dword|qword|xmmword` with an optional `ptr`, and `fs:`/`gs:` overrides written as
//!   `gs:[30]` or `[gs:30]`. A displacement from `80000000` to `FFFFFFFF` wraps as signed 32-bit
//!   (`[rax+FFFFFFFF]` = `[rax-1]`), as in CE.
//! - Size-less memory operands: when no register or keyword fixes the size and the instruction
//!   has forms of several sizes:
//!   - with an immediate operand it is `dword` (D2: `mov [rax],1` is a dword store); if the
//!     immediate doesn't fit a dword form it is an error;
//!   - near indirect `jmp`/`call` and `push`/`pop` of memory are `qword` (far `m16:xx` branches
//!     are never chosen);
//!   - multi-byte `nop` is `dword` (the disassembler prints `nop [rax+rax]` without a size);
//!   - anything else (`inc [rax]`, `cvtsi2sd xmm0,[rax]`, `movzx eax,[rdi]`) is an error.
//! - Operand size: 16-bit (`66`-prefixed) forms are only chosen when a 16-bit register or `word`
//!   is written, so `push 1234` is the 8-byte `push` (`68 34 12 00 00`).
//! - Prefixes are rejected on instructions that can't take them (`lock` also needs a memory
//!   destination).
//! - Memory addressing rule for an operand with no base or index register:
//!   - `[label]`, `[symbol]`, `[symbol±disp]` are always RIP-relative (an error if out of rel32 range);
//!   - a plain number `[1234]` is RIP-relative when the target is within ±2 GiB of `address`,
//!     otherwise absolute `disp32` (or a 64-bit `moffs` for the `mov` accumulator forms);
//!   - with an `fs:`/`gs:` override it is always absolute (`gs:[30]` → `65 … 04 25 30 00 00 00`).
//!
//!   So a disassembled absolute `[disp32]` operand near `address` assembles back to the
//!   RIP-relative form: the text round-trips, the bytes may not.
//! - Symbols: labels in the source first, then the `resolve` callback, which is given the bare
//!   name (`name`, `module.dll`, or a quoted `"Module Name.dll"`); `name+hex` / `name-hex` add an
//!   offset.
//! - Branches: `jmp`/`call`/`jcc` to labels, symbols or numbers. Short or near is chosen by
//!   iced's `BlockEncoder`; a target out of rel32 range is an error. Aliases: `jz/je`, `jnz/jne`,
//!   `jc/jb/jnae`, `jnc/jae/jnb`, `jna/jbe`, `jnbe/ja`, `jnge/jl`, `jnl/jge`, `jng/jle`, `jnle/jg`,
//!   `jpe/jp`, `jpo/jnp`, the same for `setcc`/`cmovcc`, and `retn` → `ret`.
//! - Data: `db`, `dw`, `dd`, `dq` with comma- or space-separated items; `db 'text'` emits the
//!   string's bytes; `dd (float)1.5` and `dq (double)1.5` emit IEEE values.
//! - Encoding: the candidates are every 64-bit-mode `Code` whose mnemonic matches and whose
//!   operands accept the parsed ones; each is encoded and the shortest wins (ties: first in iced's
//!   table order, which prefers the `op rm, reg` forms compilers emit).
//! - Not supported yet: string instructions (`movsb`, `rep stosd`, …), x87, AVX registers,
//!   labels inside data items.
pub mod encode;
pub mod parse;

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub bytes: Vec<u8>,
    /// Every label defined in the source, at its final address.
    pub labels: BTreeMap<String, u64>,
}

/// An assembly error on a 1-based source line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsmError {
    pub line: usize,
    pub message: String,
}

impl AsmError {
    pub fn new(line: usize, message: impl Into<String>) -> Self {
        AsmError { line, message: message.into() }
    }
}

impl std::fmt::Display for AsmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

/// Assemble `source` for `address`. `resolve` names addresses for symbols that aren't labels.
pub fn assemble(source: &str, address: u64, resolve: &dyn Fn(&str) -> Option<u64>) -> Result<Assembled, AsmError> {
    let stmts = parse::parse(source, &|name| resolve(name).is_some())?;
    encode::encode(&stmts, address, resolve)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::disasm;

    fn no_syms(_: &str) -> Option<u64> {
        None
    }

    fn asm_at(src: &str, address: u64) -> Vec<u8> {
        match assemble(src, address, &no_syms) {
            Ok(a) => a.bytes,
            Err(e) => panic!("{src:?}: {e}"),
        }
    }

    fn asm(src: &str) -> Vec<u8> {
        asm_at(src, 0x1000)
    }

    #[test]
    fn hex_by_default_and_hash_decimal() {
        assert_eq!(asm("mov eax,10"), [0xB8, 0x10, 0, 0, 0]);
        assert_eq!(asm("mov eax,#10"), [0xB8, 0x0A, 0, 0, 0]);
        assert_eq!(asm("mov eax,0x10"), [0xB8, 0x10, 0, 0, 0]);
        assert_eq!(asm("mov eax,-1"), [0xB8, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(asm("MOV EAX,FFFFFFFF"), [0xB8, 0xFF, 0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn ce_style_memory_and_sizes() {
        let want = [0xC7, 0x40, 0x10, 0x01, 0, 0, 0];
        assert_eq!(asm("mov dword ptr [rax+10],1"), want);
        assert_eq!(asm("mov [rax+10],1"), want);
        assert_eq!(asm("mov dword [rax+10],1"), want);
        assert_eq!(asm("mov byte ptr [rax+10],1"), [0xC6, 0x40, 0x10, 0x01]);
        assert_eq!(asm("mov [rbp-8],rcx"), [0x48, 0x89, 0x4D, 0xF8]);
        assert_eq!(asm("lea rax,[rcx+rdx*8+100]"), [0x48, 0x8D, 0x84, 0xD1, 0x00, 0x01, 0, 0]);
        assert_eq!(asm("lea rax,[rsp+AB]"), [0x48, 0x8D, 0x84, 0x24, 0xAB, 0, 0, 0]);
        // Size given by a register operand; an unresolvable size is an error.
        assert_eq!(asm("movzx eax,byte ptr [rdi]"), [0x0F, 0xB6, 0x07]);
        assert!(assemble("movzx eax,[rdi]", 0x1000, &no_syms).is_err());
    }

    #[test]
    fn size_less_memory_defaults() {
        // Near indirect branches are qword, never far m16:16.
        assert_eq!(asm("jmp [rax]"), [0xFF, 0x20]);
        assert_eq!(asm("call [rax+10]"), [0xFF, 0x50, 0x10]);
        let a = asm("jmp [v]\nv:\ndq 0");
        assert_eq!(&a[..6], &[0xFF, 0x25, 0x00, 0, 0, 0]);
        assert_eq!(asm("push [rax]"), [0xFF, 0x30]);
        assert_eq!(asm("pop [rax]"), [0x8F, 0x00]);
        // No immediate and several possible sizes: the size must be written.
        for src in ["inc [rax]", "cvtsi2sd xmm0,[rax]", "not [rcx]"] {
            let e = assemble(src, 0x1000, &no_syms).unwrap_err();
            assert!(e.message.contains("size"), "{src}: {e}");
        }
        assert_eq!(asm("inc dword ptr [rax]"), [0xFF, 0x00]);
        assert_eq!(asm("cvtsi2sd xmm0,qword ptr [rax]"), [0xF2, 0x48, 0x0F, 0x2A, 0x00]);
        // An immediate that only a qword form could take is an error, not a silent qword.
        assert!(assemble("mov [rax],FFFFFFFF80000000", 0x1000, &no_syms).is_err());
        assert_eq!(asm("mov qword ptr [rax],FFFFFFFF80000000"), [0x48, 0xC7, 0x00, 0x00, 0x00, 0x00, 0x80]);
    }

    #[test]
    fn push_immediate_is_64_bit() {
        assert_eq!(asm("push 1234"), [0x68, 0x34, 0x12, 0, 0]);
        assert_eq!(asm("push 80"), [0x68, 0x80, 0, 0, 0]);
        assert_eq!(asm("push 10"), [0x6A, 0x10]);
        assert_eq!(asm("push -1"), [0x6A, 0xFF]);
        // 16-bit forms when asked for.
        assert_eq!(asm("push ax"), [0x66, 0x50]);
        assert_eq!(asm("push word ptr [rax]"), [0x66, 0xFF, 0x30]);
    }

    #[test]
    fn prefixes_need_an_instruction_that_takes_them() {
        assert!(assemble("lock mov eax,ecx", 0x1000, &no_syms).is_err());
        assert!(assemble("lock add eax,1", 0x1000, &no_syms).is_err());
        assert!(assemble("rep add eax,ecx", 0x1000, &no_syms).is_err());
        assert_eq!(asm("lock add dword ptr [rax],1"), [0xF0, 0x83, 0x00, 0x01]);
    }

    #[test]
    fn labels_and_short_branches() {
        let a = assemble("a:\n jmp a", 0x1000, &no_syms).unwrap();
        assert_eq!(a.bytes, [0xEB, 0xFE]);
        assert_eq!(a.labels["a"], 0x1000);
        // Forward label past a long body goes near.
        let src = format!("jmp done\n{}done: ret", "nop\n".repeat(200));
        let b = asm(&src);
        assert_eq!(&b[..5], &[0xE9, 200, 0, 0, 0]);
        assert_eq!(b.len(), 5 + 200 + 1);
        // Label prefixing an instruction, and a trailing label.
        let c = assemble("start: nop\njne start\nend:", 0x2000, &no_syms).unwrap();
        assert_eq!(c.bytes, [0x90, 0x75, 0xFD]);
        assert_eq!(c.labels["start"], 0x2000);
        assert_eq!(c.labels["end"], 0x2003);
    }

    #[test]
    fn rip_relative_label_data() {
        let a = assemble("mov rax,[v]\nret\nv:\ndq 1122334455667788", 0x1000, &no_syms).unwrap();
        assert_eq!(
            a.bytes,
            [0x48, 0x8B, 0x05, 0x01, 0, 0, 0, 0xC3, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]
        );
        assert_eq!(a.labels["v"], 0x1008);
        // A label used as an immediate gets its final address.
        let b = assemble("mov rax,v\nret\nv:\ndq 0", 0x1000, &no_syms).unwrap();
        assert_eq!(&b.bytes[..7], &[0x48, 0xC7, 0xC0, 0x08, 0x10, 0, 0]);
    }

    #[test]
    fn symbols_resolve_with_addends() {
        let r = |n: &str| match n {
            "game.exe" => Some(0x140000000u64),
            "Module Name.dll" => Some(0x140100000),
            "ab" => Some(0x140000500),
            _ => None,
        };
        let a = assemble("jmp game.exe+10", 0x140000000, &r).unwrap();
        assert_eq!(a.bytes, [0xEB, 0x0E]);
        let a = assemble("mov eax,[\"Module Name.dll\"+8]", 0x140100000, &r).unwrap();
        assert_eq!(a.bytes, [0x8B, 0x05, 0x02, 0, 0, 0]);
        // `ab` is a symbol here, so it isn't the number 0xAB.
        let a = assemble("mov rax,ab-500", 0x1000, &r).unwrap();
        assert_eq!(a.bytes, [0x48, 0xB8, 0, 0, 0, 0x40, 0x01, 0, 0, 0]);
        let e = assemble("jmp nowhere", 0x1000, &r).unwrap_err();
        assert!(e.message.contains("nowhere"), "{e}");
    }

    #[test]
    fn absolute_memory_is_rip_relative_when_near() {
        // Near `address`: RIP-relative. Far: absolute disp32.
        assert_eq!(asm_at("mov eax,[401000]", 0x400000), [0x8B, 0x05, 0xFA, 0x0F, 0, 0]);
        assert_eq!(asm_at("mov eax,[1000]", 0x7FFF00000000), [0x8B, 0x04, 0x25, 0x00, 0x10, 0, 0]);
    }

    #[test]
    fn segment_override_thread_pointer() {
        assert_eq!(asm("mov rax,gs:[30]"), [0x65, 0x48, 0x8B, 0x04, 0x25, 0x30, 0, 0, 0]);
        assert_eq!(asm("mov rax,[gs:30]"), [0x65, 0x48, 0x8B, 0x04, 0x25, 0x30, 0, 0, 0]);
        assert_eq!(asm("mov rax,fs:[0]"), [0x64, 0x48, 0x8B, 0x04, 0x25, 0, 0, 0, 0]);
        assert_eq!(asm("mov rax,qword ptr fs:[0]"), [0x64, 0x48, 0x8B, 0x04, 0x25, 0, 0, 0, 0]);
    }

    #[test]
    fn sse_and_lock_forms() {
        assert_eq!(asm("cvtsi2sd xmm0,rax"), [0xF2, 0x48, 0x0F, 0x2A, 0xC0]);
        assert_eq!(asm("mulsd xmm0,[rcx]"), [0xF2, 0x0F, 0x59, 0x01]);
        assert_eq!(asm("cvttsd2si rax,xmm0"), [0xF2, 0x48, 0x0F, 0x2C, 0xC0]);
        assert_eq!(asm("lock cmpxchg [rdx],rcx"), [0xF0, 0x48, 0x0F, 0xB1, 0x0A]);
        assert_eq!(asm("pause"), [0xF3, 0x90]);
        assert_eq!(asm("movss xmm15,dword ptr [r8+4]"), [0xF3, 0x45, 0x0F, 0x10, 0x78, 0x04]);
    }

    #[test]
    fn aliases() {
        assert_eq!(asm("a:\njz a"), asm("a:\nje a"));
        assert_eq!(asm("a:\njz a"), [0x74, 0xFE]);
        assert_eq!(asm("a:\njnae a"), asm("a:\njb a"));
        assert_eq!(asm("a:\njc a"), [0x72, 0xFE]);
        assert_eq!(asm("a:\njpo a"), [0x7B, 0xFE]);
        assert_eq!(asm("setz al"), asm("sete al"));
        assert_eq!(asm("setnz al"), [0x0F, 0x95, 0xC0]);
        assert_eq!(asm("cmovnge eax,ecx"), [0x0F, 0x4C, 0xC1]);
        assert_eq!(asm("retn"), [0xC3]);
        assert_eq!(asm("retn 8"), [0xC2, 0x08, 0x00]);
    }

    #[test]
    fn data_with_float_cast() {
        assert_eq!(asm("dd (float)1.5"), [0x00, 0x00, 0xC0, 0x3F]);
        assert_eq!(asm("dq (double)1.5"), [0, 0, 0, 0, 0, 0, 0xF8, 0x3F]);
        assert_eq!(asm("db 'hi',0"), [b'h', b'i', 0]);
        assert_eq!(asm("db 1 2,3"), [1, 2, 3]);
        assert_eq!(asm("dw 1234 #10"), [0x34, 0x12, 0x0A, 0x00]);
        assert_eq!(asm("dd -1"), [0xFF; 4]);
        assert!(assemble("db 100", 0, &no_syms).is_err());
    }

    #[test]
    fn comments_are_ignored() {
        let src = "nop // one\n{ block\n comment } nop ; two\nnop";
        assert_eq!(asm(src), [0x90, 0x90, 0x90]);
        assert_eq!(asm("// nothing but a comment\n"), Vec::<u8>::new());
        assert_eq!(asm("s: ; empty body"), Vec::<u8>::new());
        let e = assemble("{ a\nb }\nbogus", 0, &no_syms).unwrap_err();
        assert_eq!(e.line, 3);
    }

    #[test]
    fn errors_carry_line_numbers() {
        let e = assemble("nop\nmov eax,\n", 0x1000, &no_syms).unwrap_err();
        assert_eq!(e.line, 2);
        let e = assemble("nop\nnop\nfrobnicate eax", 0x1000, &no_syms).unwrap_err();
        assert_eq!(e.line, 3);
        assert!(e.message.contains("frobnicate"), "{e}");
        let e = assemble("nop\nmov eax,rcx", 0x1000, &no_syms).unwrap_err();
        assert_eq!(e.line, 2);
        assert_eq!(e.to_string().split(':').next(), Some("line 2"));
        let e = assemble("a:\na:", 0x1000, &no_syms).unwrap_err();
        assert_eq!(e.line, 2);
    }

    #[test]
    fn out_of_range_branch_is_error() {
        let e = assemble("nop\njmp 7FFF00000000", 0x1000, &no_syms).unwrap_err();
        assert_eq!(e.line, 2);
        assert!(assemble("je 7FFF00000000", 0x1000, &no_syms).is_err());
        assert!(assemble("call 7FFF00000000", 0x1000, &no_syms).is_err());
        let far = |n: &str| (n == "far").then_some(0x7FFF00000000u64);
        assert!(assemble("mov eax,[far]", 0x1000, &far).is_err());
        // In range: a near jump.
        assert_eq!(asm_at("jmp 7FFF00000000", 0x7FFEF0000000), [0xE9, 0xFB, 0xFF, 0xFF, 0x0F]);
    }

    /// (bytes, whether bytes must round-trip exactly; false only for absolute memory operands, R3).
    const CORPUS: &[(&[u8], bool)] = &[
        (&[0x55], true),                                     // push rbp
        (&[0x48, 0x89, 0xE5], true),                         // mov rbp,rsp
        (&[0x48, 0x83, 0xEC, 0x20], true),                   // sub rsp,20
        (&[0x8B, 0x45, 0xFC], true),                         // mov eax,[rbp-4]
        (&[0x89, 0x45, 0xF8], true),                         // mov [rbp-8],eax
        (&[0x48, 0x8D, 0x44, 0x24, 0x08], true),             // lea rax,[rsp+8]
        (&[0x48, 0x8D, 0x04, 0xC8], true),                   // lea rax,[rax+rcx*8]
        (&[0x01, 0xC8], true),                               // add eax,ecx
        (&[0x48, 0x83, 0xC0, 0x01], true),                   // add rax,1
        (&[0x48, 0x05, 0x00, 0x01, 0x00, 0x00], true),       // add rax,100
        (&[0x29, 0xD0], true),                               // sub eax,edx
        (&[0x3D, 0xE8, 0x03, 0x00, 0x00], true),             // cmp eax,3E8
        (&[0x83, 0x7D, 0xFC, 0x00], true),                   // cmp dword ptr [rbp-4],0
        (&[0x85, 0xC0], true),                               // test eax,eax
        (&[0x74, 0x05], true),                               // je (short)
        (&[0x0F, 0x84, 0x00, 0x01, 0x00, 0x00], true),       // je (near)
        (&[0x7F, 0xF0], true),                               // jg (backwards)
        (&[0xEB, 0x10], true),                               // jmp (short)
        (&[0xE8, 0x00, 0x10, 0x00, 0x00], true),             // call
        (&[0xF3, 0x0F, 0x10, 0x45, 0xFC], true),             // movss xmm0,[rbp-4]
        (&[0xF3, 0x0F, 0x11, 0x45, 0xF8], true),             // movss [rbp-8],xmm0
        (&[0xF2, 0x0F, 0x10, 0x01], true),                   // movsd xmm0,[rcx]
        (&[0xF2, 0x0F, 0x59, 0xC1], true),                   // mulsd xmm0,xmm1
        (&[0xF2, 0x48, 0x0F, 0x2A, 0xC0], true),             // cvtsi2sd xmm0,rax
        (&[0xF2, 0x0F, 0x2C, 0xC0], true),                   // cvttsd2si eax,xmm0
        (&[0xF3, 0x0F, 0x5A, 0xC0], true),                   // cvtss2sd xmm0,xmm0
        (&[0x0F, 0xAF, 0xC1], true),                         // imul eax,ecx
        (&[0x6B, 0xC0, 0x0A], true),                         // imul eax,eax,0A
        (&[0x41, 0x5C], true),                               // pop r12
        (&[0x41, 0x54], true),                               // push r12
        (&[0x31, 0xC0], true),                               // xor eax,eax
        (&[0x45, 0x31, 0xC0], true),                         // xor r8d,r8d
        (&[0x83, 0xE0, 0x0F], true),                         // and eax,0F
        (&[0x48, 0x09, 0xD0], true),                         // or rax,rdx
        (&[0xD1, 0xE0], true),                               // shl eax,1
        (&[0x48, 0xC1, 0xE8, 0x04], true),                   // shr rax,4
        (&[0xFF, 0xC0], true),                               // inc eax
        (&[0x48, 0xFF, 0xC9], true),                         // dec rcx
        (&[0xF0, 0x0F, 0xC1, 0x02], true),                   // lock xadd [rdx],eax
        (&[0x0F, 0x94, 0xC0], true),                         // sete al
        (&[0x0F, 0x4C, 0xC1], true),                         // cmovl eax,ecx
        (&[0x40, 0x88, 0xC6], true),                         // mov sil,al
        (&[0x66, 0x89, 0x07], true),                         // mov [rdi],ax
        (&[0xC6, 0x07, 0x01], true),                         // mov byte ptr [rdi],1
        (&[0x48, 0xC7, 0x07, 0xFF, 0xFF, 0xFF, 0xFF], true), // mov qword ptr [rdi],-1
        (&[0x0F, 0xB6, 0x07], true),                         // movzx eax,byte ptr [rdi]
        (&[0x48, 0x63, 0xC8], true),                         // movsxd rcx,eax
        (&[0x4C, 0x8B, 0x44, 0x24, 0x28], true),             // mov r8,[rsp+28]
        (&[0x0F, 0x1F, 0x04, 0x00], true),                   // nop [rax+rax] (size defaults to dword)
        (&[0x65, 0x48, 0x8B, 0x04, 0x25, 0x30, 0, 0, 0], true), // mov rax,gs:[30]
        (&[0xC3], true),                                     // ret
        (&[0x8B, 0x05, 0x10, 0x00, 0x00, 0x00], true),       // mov eax,[rip+10] (RIP-relative stays)
        (&[0x48, 0x8B, 0x04, 0x25, 0x00, 0x10, 0, 0], false), // mov rax,[1000] (absolute → RIP-rel)
        (&[0x0F, 0x28, 0x00], true),                         // movaps xmm0,[rax]
        (&[0x0F, 0x28, 0xC1], true),                         // movaps xmm0,xmm1
        (&[0x66, 0x48, 0x0F, 0x6E, 0xC0], true),             // movq xmm0,rax
        (&[0x66, 0x0F, 0xEF, 0xC0], true),                   // pxor xmm0,xmm0
        (&[0xF2, 0x48, 0x0F, 0x2A, 0x00], true),             // cvtsi2sd xmm0,qword ptr [rax]
        (&[0xFF, 0x25, 0x00, 0x10, 0x00, 0x00], true),       // jmp qword ptr [rip+1000]
        (&[0xFF, 0x50, 0x10], true),                         // call qword ptr [rax+10]
        (&[0x41, 0xFF, 0xD3], true),                         // call r11
        (&[0x48, 0xB8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11], true), // mov rax,imm64
        (&[0xC2, 0x08, 0x00], true),                         // ret 8
        (&[0x64, 0x48, 0x8B, 0x04, 0x25, 0x28, 0, 0, 0], true), // mov rax,fs:[28]
        (&[0x48, 0x98], true),                               // cdqe
        (&[0x0F, 0x0B], true),                               // ud2
        (&[0xCC], true),                                     // int3
        (&[0xF3, 0x90], true),                               // pause
        (&[0x48, 0xA1, 0, 0, 0, 0, 0, 0x7F, 0, 0], false),   // mov rax,[7F0000000000] (moffs)
    ];

    #[test]
    fn round_trips_disassembly_corpus() {
        let ip = 0x401000;
        for (bytes, exact) in CORPUS {
            let d = disasm::decode(bytes, ip, 1);
            assert_eq!(d.len(), 1, "{bytes:02X?}");
            assert_eq!(d[0].length, bytes.len(), "{bytes:02X?} decodes as more than one instruction");
            let text = &d[0].text;
            let out = match assemble(text, ip, &no_syms) {
                Ok(a) => a.bytes,
                Err(e) => panic!("{text:?} ({bytes:02X?}): {e}"),
            };
            let again = disasm::decode(&out, ip, 1);
            assert_eq!(&again[0].text, text, "{bytes:02X?} → {out:02X?}");
            if *exact {
                assert_eq!(&out[..], *bytes, "{text}");
            }
        }
    }
}
