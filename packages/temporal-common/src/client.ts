/**
 * Temporal client and connection options, assembled in one place so every
 * process — API, workers, bootstrap scripts — connects with the same codec,
 * the same namespace, and the same TLS posture.
 */
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import { EncryptionCodec } from './codec/encryption-codec.js';
import { FileKeyProvider, type KeyProvider } from './codec/key-provider.js';
import { NAMESPACE } from './task-queues.js';

export interface TemporalConnectionConfig {
  readonly address: string;
  readonly namespace: string;
  /** Absent means encryption is OFF, which is only permissible outside production. */
  readonly keyProvider?: KeyProvider;
  readonly tls?: ConnectionOptions['tls'];
}

/**
 * Read connection settings from the environment.
 *
 * Refuses to produce an unencrypted production configuration. TG-11 resolved to
 * "identifier-only AND a codec"; a deployment that quietly dropped the codec
 * would look identical from the outside until someone read the history.
 */
export function connectionConfigFromEnv(env = process.env): TemporalConnectionConfig {
  const address = env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233';
  const namespace = env['TEMPORAL_NAMESPACE'] ?? NAMESPACE;
  const keyDir = env['TEMPORAL_CODEC_KEY_DIR'];
  const activeKeyId = env['TEMPORAL_CODEC_ACTIVE_KEY_ID'];
  const isProduction = env['NODE_ENV'] === 'production';

  if (!keyDir || !activeKeyId) {
    if (isProduction) {
      throw new Error(
        'TEMPORAL_CODEC_KEY_DIR and TEMPORAL_CODEC_ACTIVE_KEY_ID are required in production. ' +
          'Refusing to start without payload encryption (TG-11) — workflow history would be written in plaintext.',
      );
    }
    return { address, namespace };
  }

  return { address, namespace, keyProvider: new FileKeyProvider(keyDir, activeKeyId) };
}

export async function createConnection(config: TemporalConnectionConfig): Promise<Connection> {
  return Connection.connect({
    address: config.address,
    ...(config.tls ? { tls: config.tls } : {}),
  });
}

export async function createClient(config: TemporalConnectionConfig): Promise<Client> {
  const connection = await createConnection(config);
  return new Client({
    connection,
    namespace: config.namespace,
    ...(config.keyProvider
      ? { dataConverter: { payloadCodecs: [new EncryptionCodec(config.keyProvider)] } }
      : {}),
  });
}
