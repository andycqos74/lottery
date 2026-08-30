/**
 * Cryptographically secure draw generation.
 *
 * ⚠ This runs inside an ACTIVITY, never in workflow code (T-6.1). See
 * `packages/ports/src/randomness.ts` for why that distinction is the most
 * important one in the system, and `eslint.config.js` for how it is enforced.
 *
 * GAP-21 ⛔ remains open: whether a software CSPRNG is an ACCEPTABLE entropy
 * source, and whether independent assurance is required, is a licence-condition
 * question for the registering authority. This implementation exists so the draw
 * can be built and tested; it is not selected by default — `RANDOMNESS_SOURCE`
 * must be set explicitly, and the composition root refuses `unset`.
 */
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { toSelection, type Selection } from '@qosfc/domain';
import type { DrawResult, RandomnessSource } from '@qosfc/ports';

export class CsprngRandomnessSource implements RandomnessSource {
  readonly kind = 'csprng' as const;

  async generateWinningNumbers(request: {
    drawId: string;
    poolN: number;
    pickK: number;
  }): Promise<DrawResult> {
    const { drawId, poolN, pickK } = request;
    if (pickK > poolN) {
      throw new RangeError(`Cannot pick ${pickK} distinct numbers from a pool of ${poolN}.`);
    }

    // A recorded seed, so the draw is reproducible from stored data alone
    // (NFR-1, FR-5.3.6) — and bound to this draw, so a result cannot be
    // transplanted from one draw to another.
    const seedBytes = randomBytes(32);
    const seed = seedBytes.toString('hex');

    const numbers = this.drawDistinct(poolN, pickK);

    return {
      numbers,
      evidence: {
        source: this.kind,
        seed,
        generatedAt: new Date().toISOString(),
        evidence: {
          algorithm: 'node:crypto randomInt (rejection sampling, no modulo bias)',
          poolN,
          pickK,
          drawId,
          // Binds seed, draw and result together: any later alteration of the
          // stored numbers no longer matches this digest.
          resultDigest: createHash('sha256')
            .update(`${drawId}:${seed}:${numbers.join(',')}`)
            .digest('hex'),
        },
      },
    };
  }

  /**
   * Partial Fisher–Yates over the pool.
   *
   * `crypto.randomInt` rejection-samples internally, so there is no modulo bias —
   * every one of the C(20,4) = 4,845 combinations is equally likely. Drawing by
   * repeatedly generating a number and discarding duplicates would also be
   * uniform but has unbounded worst-case running time; this does not.
   */
  private drawDistinct(poolN: number, pickK: number): Selection {
    const pool = Array.from({ length: poolN }, (_, i) => i + 1);
    for (let i = 0; i < pickK; i++) {
      const j = i + randomInt(poolN - i);
      const a = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = a;
    }
    return toSelection(pool.slice(0, pickK));
  }
}

/**
 * GAP-21 placeholders. Present so the shape of each option is visible and so the
 * composition root can name them — but they throw, because shipping a plausible
 * stand-in for a regulator-facing control is exactly what technical spec §15.2
 * forbids.
 */
export class ExternalCertifiedRandomnessSource implements RandomnessSource {
  readonly kind = 'external_certified' as const;
  async generateWinningNumbers(): Promise<DrawResult> {
    throw new Error(
      'GAP-21: no certified third-party draw service has been selected or integrated. ' +
        'Choose a provider with the licensing authority before enabling this source.',
    );
  }
}

export class ManualPhysicalDrawSource implements RandomnessSource {
  readonly kind = 'manual_physical_draw' as const;
  async generateWinningNumbers(): Promise<DrawResult> {
    throw new Error(
      'GAP-21: a physical draw is entered by an operator under dual control, not generated. ' +
        'DrawWorkflow must raise a human task and await the signed-off numbers instead of calling this.',
    );
  }
}
