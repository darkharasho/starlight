import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectCeRuntime } from '../../src/main/ce-runtime-detect.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-cedetect-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('detectCeRuntime', () => {
  it('returns not-installed when runtime dir is missing', async () => {
    const r = await detectCeRuntime({ runtimeRoot: join(dir, 'absent') });
    expect(r.status).toBe('not-installed');
  });

  it('returns not-installed when binary is missing', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const r = await detectCeRuntime({
      runtimeRoot: dir,
      extractedDir: 'CheatEngineLinux766-4',
      binaryRelative: 'cheatengine-x86_64',
    });
    expect(r.status).toBe('not-installed');
  });

  it('returns ready with absolute paths when binary exists and is executable', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const bin = join(ceDir, 'cheatengine-x86_64');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o755);
    const r = await detectCeRuntime({
      runtimeRoot: dir,
      extractedDir: 'CheatEngineLinux766-4',
      binaryRelative: 'cheatengine-x86_64',
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.binary).toBe(bin);
    expect(r.installDir).toBe(ceDir);
  });

  it('returns not-installed when binary exists but is not executable', async () => {
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const bin = join(ceDir, 'cheatengine-x86_64');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o644);
    const r = await detectCeRuntime({
      runtimeRoot: dir,
      extractedDir: 'CheatEngineLinux766-4',
      binaryRelative: 'cheatengine-x86_64',
    });
    expect(r.status).toBe('not-installed');
  });

  it('uses sensible defaults for extractedDir and binaryRelative when not specified', async () => {
    // Defaults: extractedDir='CheatEngineLinux766-4', binaryRelative='cheatengine-x86_64'
    const ceDir = join(dir, 'CheatEngineLinux766-4');
    await mkdir(ceDir, { recursive: true });
    const bin = join(ceDir, 'cheatengine-x86_64');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o755);
    const r = await detectCeRuntime({ runtimeRoot: dir });
    expect(r.status).toBe('ready');
  });
});
