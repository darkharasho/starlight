import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { installCeServer, installWindowsCe } from '../../src/main/ce-runtime-install.js';

let dir: string;
let server: Server;
let port: number;

async function startServer(handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
}

async function makeFakeZip(): Promise<Buffer> {
  const z = new yazl.ZipFile();
  z.addBuffer(Buffer.from('#!/bin/sh\nexit 0\n'), 'ceserver-7.5/ceserver');
  z.addBuffer(Buffer.from('\x7fELF'), 'ceserver-7.5/libceserver-extension_x86_64.so');
  z.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve());
    z.outputStream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-ceinstall-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('installCeServer', () => {
  it('downloads, verifies SHA256, extracts, and marks the binary executable', async () => {
    const zipBytes = await makeFakeZip();
    const sha = createHash('sha256').update(zipBytes).digest('hex');
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zipBytes.length) });
      res.end(zipBytes);
    });
    const events: Array<{ phase: string; current?: number; total?: number }> = [];
    await installCeServer({
      url: `http://127.0.0.1:${port}/ceserver-7.5-linux-x64.zip`,
      sha256: sha,
      runtimeRoot: dir,
      onProgress: (e) => events.push(e),
    });
    expect(events.some(e => e.phase === 'downloading')).toBe(true);
    expect(events.some(e => e.phase === 'verifying')).toBe(true);
    expect(events.some(e => e.phase === 'extracting')).toBe(true);
    expect(events.some(e => e.phase === 'done')).toBe(true);
    const bin = join(dir, 'ceserver-7.5', 'ceserver');
    const s = await stat(bin);
    expect(s.mode & 0o100).not.toBe(0);            // executable bit set
  });

  it('rejects when SHA256 mismatches', async () => {
    const zipBytes = await makeFakeZip();
    await startServer((_req, res) => { res.writeHead(200); res.end(zipBytes); });
    await expect(installCeServer({
      url: `http://127.0.0.1:${port}/x.zip`,
      sha256: 'deadbeef'.repeat(8),
      runtimeRoot: dir,
      onProgress: () => {},
    })).rejects.toThrow(/sha256/i);
  });

  it('rejects when HTTP returns non-200', async () => {
    await startServer((_req, res) => { res.writeHead(404); res.end(); });
    await expect(installCeServer({
      url: `http://127.0.0.1:${port}/x.zip`,
      sha256: 'a'.repeat(64),
      runtimeRoot: dir,
      onProgress: () => {},
    })).rejects.toThrow(/HTTP 404/);
  });
});

async function makeWindowsCeZip(): Promise<Buffer> {
  const z = new yazl.ZipFile();
  // CE app files at the zip root -> extract into destDir
  z.addBuffer(Buffer.from('MZ...winpe'), 'cheatengine-x86_64.exe');
  z.addBuffer(Buffer.from('-- json module'), 'lua/json.lua');
  z.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve());
    z.outputStream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

describe('installWindowsCe', () => {
  it('extracts the Windows CE (incl. lua/json.lua) into destDir', async () => {
    const zipBytes = await makeWindowsCeZip();
    const sha = createHash('sha256').update(zipBytes).digest('hex');
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(zipBytes.length) });
      res.end(zipBytes);
    });
    const destDir = join(dir, 'CheatEngineWindows75');
    await installWindowsCe({
      url: `http://127.0.0.1:${port}/win.zip`,
      sha256: sha,
      destDir,
      onProgress: () => {},
    });
    await stat(join(destDir, 'cheatengine-x86_64.exe'));
    await stat(join(destDir, 'lua', 'json.lua'));
  });

  it('rejects on SHA256 mismatch', async () => {
    const zipBytes = await makeWindowsCeZip();
    await startServer((_req, res) => { res.writeHead(200); res.end(zipBytes); });
    await expect(installWindowsCe({
      url: `http://127.0.0.1:${port}/win.zip`,
      sha256: 'deadbeef'.repeat(8),
      destDir: join(dir, 'CheatEngineWindows75'),
      onProgress: () => {},
    })).rejects.toThrow(/sha256/i);
  });
});
