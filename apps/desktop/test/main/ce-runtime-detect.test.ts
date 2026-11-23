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

async function putWinCe(rel: string): Promise<string> {
  const d = join(dir, rel);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'cheatengine-x86_64.exe'), 'MZ');
  return d;
}

async function putCeServer(mode = 0o755): Promise<string> {
  const d = join(dir, 'ceserver-7.5');
  await mkdir(d, { recursive: true });
  const bin = join(d, 'ceserver');
  await writeFile(bin, '#!/bin/sh\n');
  await chmod(bin, mode);
  return bin;
}

describe('detectCeRuntime', () => {
  it('lists both parts as missing when nothing is installed', async () => {
    const r = await detectCeRuntime({ runtimeRoot: join(dir, 'absent') });
    expect(r).toEqual({ status: 'not-installed', missing: ['windows-ce', 'ceserver'] });
  });

  it('is ready with Windows CE and ceserver installed', async () => {
    const winCeDir = await putWinCe('CheatEngineWindows75');
    const ceserver = await putCeServer();
    const r = await detectCeRuntime({ runtimeRoot: dir });
    expect(r).toEqual({ status: 'ready', winCeDir, winCeExe: join(winCeDir, 'cheatengine-x86_64.exe'), ceserver });
  });

  it('uses the Windows CE an older install put inside the Linux CE', async () => {
    const winCeDir = await putWinCe(join('CheatEngineLinux766-4', 'windowsbin'));
    await putCeServer();
    const r = await detectCeRuntime({ runtimeRoot: dir });
    expect(r).toMatchObject({ status: 'ready', winCeDir });
  });

  it('prefers the current Windows CE location over the legacy one', async () => {
    await putWinCe(join('CheatEngineLinux766-4', 'windowsbin'));
    const winCeDir = await putWinCe('CheatEngineWindows75');
    await putCeServer();
    expect(await detectCeRuntime({ runtimeRoot: dir })).toMatchObject({ winCeDir });
  });

  it('asks for only ceserver when an older install already has Windows CE', async () => {
    await putWinCe(join('CheatEngineLinux766-4', 'windowsbin'));
    expect(await detectCeRuntime({ runtimeRoot: dir })).toEqual({ status: 'not-installed', missing: ['ceserver'] });
  });

  it('treats a ceserver that is not executable as missing', async () => {
    await putWinCe('CheatEngineWindows75');
    await putCeServer(0o644);
    expect(await detectCeRuntime({ runtimeRoot: dir })).toEqual({ status: 'not-installed', missing: ['ceserver'] });
  });
});
