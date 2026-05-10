import { z } from 'zod';
import { StarlightTrainerSchema } from '@starlight/ct-importer';

export const CatalogIndexEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steamAppId: z.number().int().nullable(),
  processName: z.array(z.string().min(1)),
  platform: z.array(z.enum(['windows', 'linux', 'macos'])).min(1),
  tags: z.array(z.string()).optional(),
  trainerPath: z.string().regex(/^trainers\/[a-z0-9-]+\.json$/),
  trainerUpdatedAt: z.string().optional(),
  trainerSource: z.string().url().optional(),
});

export const CatalogIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  games: z.array(CatalogIndexEntrySchema),
});

export type CatalogIndexEntry = z.infer<typeof CatalogIndexEntrySchema>;
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

// Re-export trainer schema for catalog-host consumers
export { StarlightTrainerSchema };
export type { StarlightTrainer } from '@starlight/ct-importer';
