export interface ImportStats {
  total: number;
  supported: number;
  unsupported: number;
  categories: number;
}

export function emptyStats(): ImportStats {
  return { total: 0, supported: 0, unsupported: 0, categories: 0 };
}
