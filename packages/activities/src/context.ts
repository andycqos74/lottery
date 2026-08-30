/**
 * Activity context: the dependencies every activity implementation needs.
 *
 * Assembled once in the worker's composition root and closed over, so activities
 * are plain functions rather than classes reaching for globals — which keeps them
 * directly unit-testable with a fake registry and a test database.
 */
import type { Pool } from '@qosfc/db';
import type { ProviderRegistry } from '@qosfc/ports';

export interface ActivityContext {
  readonly pool: Pool;
  readonly providers: ProviderRegistry;
}
