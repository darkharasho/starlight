/**
 * What the game page drives a loaded table through: Cheat Engine's bridge or
 * Starlight's own engine. Both take the CE bridge's commands and answer in its
 * reply shapes (see ce-control-script.ts).
 */
export type BackendMethod =
  | 'ping' | 'status' | 'list_records' | 'refresh' | 'set_active' | 'check_script'
  | 'load_table' | 'set_value' | 'set_speed' | 'set_hotkeys' | 'shutdown';

export interface BackendCommand {
  method: string;
  params?: unknown;
}

export interface TableBackend {
  readonly kind: 'ce' | 'native';
  send(cmd: BackendCommand): Promise<unknown>;
  close(): Promise<void>;
}
