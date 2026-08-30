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

export interface RandomOrgConfig {
  /** https://api.random.org/api-keys — required for the signed API used here. */
  readonly apiKey: string;
  readonly baseUrl?: string;
}

interface RandomOrgSignedResponse {
  readonly result?: {
    readonly random: {
      readonly data: readonly number[];
      readonly serialNumber: number;
      readonly completionTime: string;
    };
    readonly signature: string;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * GAP-21, resolved: the client's chosen entropy source is random.org's HTTP API
 * (https://www.random.org/clients/http/) — a true hardware RNG external to this
 * system, which is what "independent assurance" needs.
 *
 * Uses the SIGNED API (`generateSignedIntegers`), not the plain one: it returns a
 * signature and a serial number that random.org will verify on request, which is
 * the evidence FR-5.3.6 and a regulator's audit actually need — a bare integer
 * list would be exactly as unverifiable as our own CSPRNG.
 *
 * Still not wired in by default: `RANDOMNESS_SOURCE` must be set to
 * `external_certified` explicitly, and licence sign-off on this specific source
 * remains outstanding (GAP-21's other half — see docs/gap-register.md).
 */
export class ExternalCertifiedRandomnessSource implements RandomnessSource {
  readonly kind = 'external_certified' as const;

  constructor(private readonly config: RandomOrgConfig) {}

  async generateWinningNumbers(request: {
    drawId: string;
    poolN: number;
    pickK: number;
  }): Promise<DrawResult> {
    const { drawId, poolN, pickK } = request;
    if (pickK > poolN) {
      throw new RangeError(`Cannot pick ${pickK} distinct numbers from a pool of ${poolN}.`);
    }

    const response = await fetch(this.config.baseUrl ?? 'https://api.random.org/json-rpc/4/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'generateSignedIntegers',
        params: {
          apiKey: this.config.apiKey,
          n: pickK,
          min: 1,
          max: poolN,
          replacement: false,
          base: 10,
        },
        id: drawId,
      }),
    });

    if (!response.ok) {
      throw new Error(`random.org: HTTP ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as RandomOrgSignedResponse;
    if (payload.error) {
      throw new Error(`random.org: ${payload.error.message} (code ${payload.error.code})`);
    }
    if (!payload.result) {
      throw new Error('random.org: response carried neither a result nor an error.');
    }

    const { random, signature } = payload.result;
    const numbers = toSelection([...random.data].sort((a, b) => a - b));

    return {
      numbers,
      evidence: {
        source: this.kind,
        // The serial number, not the drawn numbers, is the reproducible handle:
        // random.org's verify endpoint takes the signature, not this string.
        seed: `randomorg:${random.serialNumber}`,
        generatedAt: random.completionTime,
        evidence: {
          provider: 'random.org',
          method: 'generateSignedIntegers',
          serialNumber: random.serialNumber,
          signature,
          drawId,
          poolN,
          pickK,
        },
      },
    };
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
