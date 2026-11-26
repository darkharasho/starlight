import type { EngineClient } from './client.js';

export type Bits = 32 | 64;

/**
 * A process's bitness without attaching: `processBits` is how starlightd calls into it,
 * `codeBits` the game code's (pointer size, assembler), null while the game exe isn't mapped yet.
 * With `mainModule`, only that exe decides `codeBits`.
 */
export async function processInfo(
  client: EngineClient,
  pid: number,
  mainModule?: string,
): Promise<{ processBits: Bits; codeBits: Bits | null }> {
  const r = await client.call<{ process_bits: Bits; code_bits: Bits | null }>('process_info', {
    pid,
    ...(mainModule !== undefined ? { main_module: mainModule } : {}),
  });
  return { processBits: r.process_bits, codeBits: r.code_bits };
}
