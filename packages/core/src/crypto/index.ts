import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Secrets at rest (design §7.2): AES-256-GCM, random nonce per value, AAD binding table/column/row. */

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const MASTER_KEY_FILENAME = 'master.key';

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt value (wrong key, wrong row binding, or corrupted data)') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Associated data for a stored secret, e.g. `aad('plugin_instances', 'secrets_enc', id)`. */
export function aad(table: string, column: string, rowId: string): string {
  return `${table}:${column}:${rowId}`;
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) throw new Error(`Master key must be ${KEY_BYTES} bytes, got ${key.length}`);
    return new SecretBox(Buffer.from(key));
  }

  encrypt(plaintext: string | Buffer, associatedData: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.of(VERSION), nonce, body, cipher.getAuthTag()]);
  }

  decrypt(blob: Buffer, associatedData: string): Buffer {
    if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== VERSION) throw new DecryptionError();
    const nonce = blob.subarray(1, 1 + NONCE_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const body = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new DecryptionError();
    }
  }

  encryptJson(value: unknown, associatedData: string): Buffer {
    return this.encrypt(JSON.stringify(value), associatedData);
  }

  decryptJson<T = unknown>(blob: Buffer, associatedData: string): T {
    return JSON.parse(this.decrypt(blob, associatedData).toString('utf8')) as T;
  }

  /** Purpose-bound subkeys (attestation HMAC, approval links, session pepper) via HKDF-SHA256. */
  deriveKey(purpose: string, length = KEY_BYTES): Buffer {
    return Buffer.from(hkdfSync('sha256', this.key, Buffer.alloc(0), `synoikia:${purpose}`, length));
  }
}

export interface MasterKeyResult {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
  /** Set when the key lives in the data volume, which the design recommends against for production. */
  warning?: string;
}

function decodeKey(raw: string, origin: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`${origin} must be ${KEY_BYTES} bytes of base64 (e.g. \`openssl rand -base64 32\`)`);
  }
  return key;
}

/** `MASTER_KEY` env wins; otherwise read or create `DATA_DIR/master.key` with mode 0600. */
export function loadMasterKey(opts: { envKey?: string; dataDir: string }): MasterKeyResult {
  if (opts.envKey) return { key: decodeKey(opts.envKey, 'MASTER_KEY'), source: 'env' };

  const file = path.join(opts.dataDir, MASTER_KEY_FILENAME);
  const warning = `Master key is stored at ${file}, inside the data volume. Set MASTER_KEY to keep it separate from the database.`;
  if (existsSync(file)) return { key: decodeKey(readFileSync(file, 'utf8'), file), source: 'file', warning };

  mkdirSync(opts.dataDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return { key, source: 'generated', warning };
}
