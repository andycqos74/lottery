/**
 * GAP-21, resolved (client decision, see docs/gap-register.md): draw numbers
 * from RANDOM.ORG's true-random HTTP client interface —
 * https://www.random.org/clients/http/ — rather than a software CSPRNG.
 *
 * ⚠ This runs inside an ACTIVITY, never in workflow code (T-6.1). See
 * `packages/ports/src/randomness.ts` for why, and `eslint.config.js` for how
 * that is enforced.
 *
 * Uses the `sequences` endpoint, not `integers`: sequences returns a random
 * PERMUTATION of 1..poolN with no repeats, which is exactly "pickK distinct
 * numbers without replacement" — `integers` draws independently and can repeat.
 * The response has no cryptographic signature (that needs RANDOM.ORG's Signed /
 * JSON-RPC API and an API key, which is a materially different, paid product
 * from what was decided here); the evidence recorded is the raw response body
 * and request parameters, which is what the free HTTP client interface offers.
 */
import { createHash } from 'node:crypto';
import { toSelection } from '@qosfc/domain';
import { TransientProviderError, PermanentProviderError, type DrawResult, type RandomnessSource } from '@qosfc/ports';

const DEFAULT_BASE_URL = 'https://www.random.org';
const PROVIDER = 'random_org';

export interface RandomOrgConfig {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class RandomOrgRandomnessSource implements RandomnessSource {
  readonly kind = 'random_org' as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: RandomOrgConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  async generateWinningNumbers(request: {
    readonly drawId: string;
    readonly poolN: number;
    readonly pickK: number;
  }): Promise<DrawResult> {
    const { drawId, poolN, pickK } = request;
    if (pickK > poolN) {
      throw new RangeError(`Cannot pick ${pickK} distinct numbers from a pool of ${poolN}.`);
    }

    const params = new URLSearchParams({
      min: '1',
      max: String(poolN),
      col: '1',
      format: 'plain',
      rnd: 'new',
    });
    const url = `${this.baseUrl}/sequences/?${params.toString()}`;
    const body = await this.fetchText(url);

    const permutation = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number(line));

    if (permutation.length !== poolN || permutation.some((n) => !Number.isInteger(n))) {
      throw new PermanentProviderError(
        `Expected a ${poolN}-number permutation, got: ${body.slice(0, 200)}`,
        PROVIDER,
        'unexpected_response_shape',
      );
    }

    const numbers = toSelection(permutation.slice(0, pickK));
    const generatedAt = new Date().toISOString();

    return {
      numbers,
      evidence: {
        source: this.kind,
        // No signature is available on this interface (see file header) — the
        // "seed" of record is the raw response body itself, so a stored draw is
        // independently reproducible from what RANDOM.ORG actually returned.
        seed: createHash('sha256').update(body).digest('hex'),
        generatedAt,
        evidence: {
          endpoint: url,
          rawResponse: body,
          poolN,
          pickK,
          drawId,
          resultDigest: createHash('sha256').update(`${drawId}:${body}:${numbers.join(',')}`).digest('hex'),
        },
      },
    };
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();

      // The plain HTTP interface can return HTTP 200 with an "Error:" body — the
      // documented shape for a quota or parameter problem on this endpoint.
      if (!response.ok || text.trimStart().startsWith('Error:')) {
        const message = text.trim() || `${response.status} ${response.statusText}`;
        // A quota/rate error is worth retrying later; anything else (a bad
        // parameter, a shape RANDOM.ORG has changed) is not.
        if (/quota|rate|exceeded/i.test(message) || (response.status >= 500 && response.status < 600)) {
          throw new TransientProviderError(message, PROVIDER);
        }
        throw new PermanentProviderError(message, PROVIDER, 'random_org_error');
      }
      return text;
    } catch (error) {
      if (error instanceof PermanentProviderError || error instanceof TransientProviderError) throw error;
      throw new TransientProviderError(error instanceof Error ? error.message : String(error), PROVIDER, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
