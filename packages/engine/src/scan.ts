import type { Session } from './session.js';
import type { FirstScanMode, NextScanMode, ScanType } from './types.js';

export interface FirstScanOptions {
  type: ScanType;
  mode: FirstScanMode;
  value?: string;
  min?: string;
  max?: string;
  encoding?: 'utf-8' | 'utf-16le';
  alignment?: number;
}

export interface NextScanOptions {
  mode: NextScanMode;
  value?: string;
  min?: string;
  max?: string;
}

export interface ScanResult { address: string; value: string | null }

/** Starts a value scan over the game's writable private memory. Values are strings, as typed. */
export async function scanFirst(s: Session, o: FirstScanOptions): Promise<{ scan: number; count: number }> {
  return s.client.call('scan_first', {
    handle: s.handle,
    type: o.type,
    mode: o.mode,
    ...(o.value !== undefined ? { value: o.value } : {}),
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
    ...(o.encoding !== undefined ? { encoding: o.encoding } : {}),
    ...(o.alignment !== undefined ? { alignment: o.alignment } : {}),
  });
}

export async function scanNext(s: Session, scan: number, o: NextScanOptions): Promise<{ count: number }> {
  return s.client.call('scan_next', {
    scan,
    mode: o.mode,
    ...(o.value !== undefined ? { value: o.value } : {}),
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
  });
}

/** A page of the scan's candidates (at most 1000), with their current values read live. */
export async function scanResults(
  s: Session,
  scan: number,
  o: { offset?: number; limit?: number } = {},
): Promise<{ count: number; results: ScanResult[] }> {
  return s.client.call('scan_results', {
    scan,
    ...(o.offset !== undefined ? { offset: o.offset } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
  });
}

export async function scanEnd(s: Session, scan: number): Promise<void> {
  await s.client.call('scan_end', { scan });
}
