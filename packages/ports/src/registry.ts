/**
 * The composition root's contract.
 *
 * Which adapter set is in use is decided in exactly one place, from environment
 * variables, and nothing downstream knows the answer. Swapping a sandbox provider
 * for a live one is a new adapter plus an env var — no workflow or activity code
 * changes, which is the whole point of §5 of the build plan.
 */
import type { PaymentGateway } from './payment-gateway.js';
import type { BacsBureau } from './bacs-bureau.js';
import type { BankFeed } from './bank-feed.js';
import type { Notifier, PrintHandoff } from './notifier.js';
import type { RandomnessSource } from './randomness.js';

export interface ProviderRegistry {
  readonly paymentGateway: PaymentGateway;
  readonly bacsBureau: BacsBureau;
  readonly bankFeed: BankFeed;
  readonly notifier: Notifier;
  readonly printHandoff: PrintHandoff;
  readonly randomness: RandomnessSource;
}

/** Every adapter names itself so a running system can be asked what it is talking to. */
export interface ProviderDescriptor {
  readonly port: keyof ProviderRegistry;
  readonly providerName: string;
  readonly isSandbox: boolean;
}

export function describeRegistry(registry: ProviderRegistry): ProviderDescriptor[] {
  return [
    { port: 'paymentGateway', providerName: registry.paymentGateway.providerName, isSandbox: isSandbox(registry.paymentGateway.providerName) },
    { port: 'bacsBureau', providerName: registry.bacsBureau.providerName, isSandbox: isSandbox(registry.bacsBureau.providerName) },
    { port: 'bankFeed', providerName: registry.bankFeed.providerName, isSandbox: isSandbox(registry.bankFeed.providerName) },
    { port: 'notifier', providerName: registry.notifier.providerName, isSandbox: isSandbox(registry.notifier.providerName) },
    { port: 'printHandoff', providerName: registry.printHandoff.providerName, isSandbox: isSandbox(registry.printHandoff.providerName) },
    { port: 'randomness', providerName: registry.randomness.kind, isSandbox: false },
  ];
}

export const SANDBOX_PREFIX = 'sandbox:';
export const isSandbox = (providerName: string): boolean => providerName.startsWith(SANDBOX_PREFIX);

/**
 * Refuse to run a production deployment against dummy providers.
 *
 * The sandbox exists so the internal flow can be built and verified before the
 * PSP and Bacs decisions land. The corresponding risk is that it is still wired
 * in on the day real money starts moving — a mistake that would look like
 * everything working. This makes that impossible rather than unlikely.
 */
export function assertNoSandboxInProduction(registry: ProviderRegistry, nodeEnv = process.env['NODE_ENV']): void {
  if (nodeEnv !== 'production') return;
  const sandboxed = describeRegistry(registry).filter((d) => d.isSandbox);
  if (sandboxed.length > 0) {
    throw new Error(
      `Refusing to start in production with sandbox providers: ` +
        sandboxed.map((d) => `${d.port}=${d.providerName}`).join(', ') +
        `. These are dummy systems; real money would not move and real payments would be silently fabricated.`,
    );
  }
}
