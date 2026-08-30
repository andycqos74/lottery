import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentProviderError, TransientProviderError } from '@qosfc/ports';
import { RandomOrgRandomnessSource } from './random-org.js';

describe('RandomOrgRandomnessSource (GAP-21)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws pickK distinct numbers from the sequences permutation', async () => {
    const permutation = Array.from({ length: 20 }, (_, i) => i + 1).reverse().join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(permutation, { status: 200 })));

    const source = new RandomOrgRandomnessSource();
    const result = await source.generateWinningNumbers({ drawId: 'draw-1', poolN: 20, pickK: 4 });

    expect(result.numbers).toHaveLength(4);
    expect(new Set(result.numbers).size).toBe(4);
    // toSelection sorts ascending; the permutation's first 4 (reversed) are 20,19,18,17.
    expect(result.numbers).toEqual([17, 18, 19, 20]);
    expect(result.evidence.source).toBe('random_org');
    expect(result.evidence.evidence['rawResponse']).toBe(permutation);
  });

  it('records the raw response and endpoint as evidence, hashed as the seed', async () => {
    const permutation = Array.from({ length: 20 }, (_, i) => i + 1).join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(permutation, { status: 200 })));

    const source = new RandomOrgRandomnessSource();
    const result = await source.generateWinningNumbers({ drawId: 'draw-2', poolN: 20, pickK: 4 });

    expect(result.evidence.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(String(result.evidence.evidence['endpoint'])).toContain('/sequences/');
  });

  it('treats a quota-exceeded body as transient (retryable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Error: quota exceeded', { status: 200 })));
    const source = new RandomOrgRandomnessSource();
    await expect(source.generateWinningNumbers({ drawId: 'd', poolN: 20, pickK: 4 })).rejects.toThrow(TransientProviderError);
  });

  it('treats an unexpected response shape as permanent (not retryable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not a permutation at all', { status: 200 })));
    const source = new RandomOrgRandomnessSource();
    await expect(source.generateWinningNumbers({ drawId: 'd', poolN: 20, pickK: 4 })).rejects.toThrow(PermanentProviderError);
  });

  it('refuses to pick more numbers than the pool holds', async () => {
    const source = new RandomOrgRandomnessSource();
    await expect(source.generateWinningNumbers({ drawId: 'd', poolN: 4, pickK: 20 })).rejects.toThrow(RangeError);
  });
});
