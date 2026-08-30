/**
 * Minimal HTTP client for the sandbox adapters.
 *
 * These talk to a real service over a real network on purpose (build plan §5):
 * in-process fakes never exercise webhook delivery, connection failures, or
 * async settlement, so the first live integration is where those bugs surface.
 *
 * Errors are mapped onto the port's TransientProviderError /
 * PermanentProviderError, because failure semantics belong to the port — that is
 * what keeps retry behaviour identical when a live provider replaces this one.
 */
import { PermanentProviderError, TransientProviderError } from '@qosfc/ports';

export interface SandboxHttpOptions {
  readonly baseUrl: string;
  readonly provider: string;
  readonly timeoutMs?: number;
}

export async function sandboxRequest<T>(
  options: SandboxHttpOptions,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : {};

    if (response.ok) return payload as T;

    // 4xx is the provider saying "this will never work": a declined card, a
    // rejected mandate, a validation failure. Retrying burns the budget and
    // delays the business path FR-14.2 requires be triggered immediately.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      const detail = payload as { reasonCode?: string; reason?: string };
      throw new PermanentProviderError(
        detail.reason ?? `${response.status} ${response.statusText}`,
        options.provider,
        detail.reasonCode ?? `http_${response.status}`,
      );
    }

    throw new TransientProviderError(`${response.status} ${response.statusText}`, options.provider);
  } catch (error) {
    if (error instanceof PermanentProviderError || error instanceof TransientProviderError) throw error;
    // Timeouts, DNS failures, connection resets — all worth another attempt.
    throw new TransientProviderError(
      error instanceof Error ? error.message : String(error),
      options.provider,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
