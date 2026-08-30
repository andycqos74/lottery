import { describe, expect, it } from 'vitest';
import { COMBINATIONS } from '@qosfc/domain';
import { CsprngRandomnessSource, ExternalCertifiedRandomnessSource, ManualPhysicalDrawSource } from './csprng.js';

const rng = new CsprngRandomnessSource();
const draw = () => rng.generateWinningNumbers({ drawId: 'test-draw', poolN: 20, pickK: 4 });

describe('draw generation', () => {
  it('produces 4 distinct numbers in 1..20, sorted', async () => {
    for (let i = 0; i < 200; i++) {
      const { numbers } = await draw();
      expect(numbers).toHaveLength(4);
      expect(new Set(numbers).size).toBe(4);
      expect([...numbers].sort((a, b) => a - b)).toEqual([...numbers]);
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...numbers)).toBeLessThanOrEqual(20);
    }
  });

  it('records the provenance a statutory return needs (FR-5.3.6)', async () => {
    const { evidence } = await draw();
    expect(evidence.source).toBe('csprng');
    expect(evidence.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(evidence.generatedAt)).not.toBeNaN();
    expect(evidence.evidence['drawId']).toBe('test-draw');
    expect(evidence.evidence['resultDigest']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the digest to the draw, so a result cannot be transplanted', async () => {
    const a = await rng.generateWinningNumbers({ drawId: 'draw-A', poolN: 20, pickK: 4 });
    const b = await rng.generateWinningNumbers({ drawId: 'draw-B', poolN: 20, pickK: 4 });
    expect(a.evidence.evidence['resultDigest']).not.toBe(b.evidence.evidence['resultDigest']);
  });

  it('never repeats a seed', async () => {
    const seeds = new Set<string>();
    for (let i = 0; i < 500; i++) seeds.add((await draw()).evidence.seed);
    expect(seeds.size).toBe(500);
  });

  /**
   * Not a test of the CSPRNG — a test that the SELECTION algorithm is unbiased.
   * A modulo-biased implementation would skew low numbers measurably here.
   */
  it('is uniform across positions within tolerance', async () => {
    const counts = new Map<number, number>();
    const draws = 12_000;
    for (let i = 0; i < draws; i++) {
      for (const n of (await draw()).numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const expectedPerNumber = (draws * 4) / 20;
    for (let n = 1; n <= 20; n++) {
      const observed = counts.get(n) ?? 0;
      // ±6% at 12k draws is comfortably outside sampling noise but well inside
      // what a biased implementation would produce.
      expect(observed).toBeGreaterThan(expectedPerNumber * 0.94);
      expect(observed).toBeLessThan(expectedPerNumber * 1.06);
    }
  });

  it('covers a wide spread of the 4,845 combinations', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) seen.add((await draw()).numbers.join(','));
    // Coupon-collector: ~4,000 uniform draws over 4,845 outcomes gives roughly
    // 4845·(1−e^(−4000/4845)) ≈ 2,725 distinct. A stuck or biased generator
    // would fall far short of this.
    expect(seen.size).toBeGreaterThan(2400);
    expect(COMBINATIONS).toBe(4845);
  });
});

describe('GAP-21 — unselected sources fail explicitly (spec §15.2)', () => {
  it('the certified third-party source refuses rather than substituting', async () => {
    await expect(new ExternalCertifiedRandomnessSource().generateWinningNumbers()).rejects.toThrow(/GAP-21/);
  });

  it('the physical draw source refuses to generate what an operator must enter', async () => {
    await expect(new ManualPhysicalDrawSource().generateWinningNumbers()).rejects.toThrow(/dual control/);
  });
});
