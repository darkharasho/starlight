import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CatalogIndexSchema, StarlightTrainerSchema,
  type CatalogIndex, type CatalogIndexEntry, type StarlightTrainer,
} from '@starlight/catalog/schema';

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

export async function writeTrainer(catalogDir: string, id: string, trainer: StarlightTrainer): Promise<void> {
  const validated = StarlightTrainerSchema.parse(trainer);
  const path = join(catalogDir, 'trainers', `${id}.json`);
  await atomicWrite(path, JSON.stringify(validated, null, 2) + '\n');
}

export async function writeIndex(catalogDir: string, entries: CatalogIndexEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const index: CatalogIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    games: sorted,
  };
  const validated = CatalogIndexSchema.parse(index);
  const path = join(catalogDir, 'index.json');
  await atomicWrite(path, JSON.stringify(validated, null, 2) + '\n');
}
