import type { StarlightCheat, StarlightSupportedCheat } from '../../shared/ipc.js';
import type { StarlightPatchCheat } from '@starlight/ct-importer';

/* Type-only mirror of ct-importer's isValueCheat/isPatchCheat, so the renderer bundle
 * doesn't pull in the importer's runtime (zod, XML parser). Keep the logic identical. */
export function isValueCheat(c: StarlightCheat): c is StarlightSupportedCheat {
  return !('unsupported' in c && c.unsupported === true) && c.type !== 'patch';
}
export function isPatchCheat(c: StarlightCheat): c is StarlightPatchCheat {
  return !('unsupported' in c && c.unsupported === true) && c.type === 'patch';
}
