import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Minisign verification (design §4.3) with Node's Ed25519: legacy `Ed` and prehashed `ED`, always
 * checking the trusted comment's signature. https://jedisct1.github.io/minisign/ */

export interface MinisignPublicKey {
  /** 8-byte key id as minisign prints it (`minisign -V` / the `.pub` comment): 16 upper-case hex digits. */
  keyId: string;
  key: KeyObject;
  /** The base64 key line, normalized. */
  base64: string;
}

export class MinisignError extends Error {}

/** Minisign prints key ids as a little-endian u64. */
const keyIdHex = (bytes: Buffer) => Buffer.from(bytes).reverse().toString('hex').toUpperCase();

/** Accepts the bare base64 key line or a whole `.pub` file (with its untrusted comment). */
export function parsePublicKey(text: string): MinisignPublicKey {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('untrusted comment:'))[0];
  const raw = line && /^[A-Za-z0-9+/]+={0,2}$/.test(line) ? Buffer.from(line, 'base64') : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new MinisignError('Not a minisign Ed25519 public key');
  }
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
    format: 'jwk',
  });
  return { keyId: keyIdHex(raw.subarray(2, 10)), key, base64: raw.toString('base64') };
}

export interface VerifiedSignature {
  keyId: string;
  prehashed: boolean;
  trustedComment: string;
}

/** Throws MinisignError unless `signature` is a valid minisign signature of `data` by `publicKey`. */
export function verifySignature(data: Buffer, signature: string, publicKey: MinisignPublicKey): VerifiedSignature {
  const lines = signature.split(/\r?\n/).map((l) => l.trim());
  if (lines.length < 4 || !lines[0]!.startsWith('untrusted comment:') || !lines[2]!.startsWith('trusted comment: ')) {
    throw new MinisignError('Malformed minisign signature');
  }
  const sig = Buffer.from(lines[1]!, 'base64');
  const globalSig = Buffer.from(lines[3]!, 'base64');
  if (sig.length !== 74 || globalSig.length !== 64) throw new MinisignError('Malformed minisign signature');
  const alg = sig.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed' && alg !== 'ED') throw new MinisignError(`Unsupported signature algorithm ${alg}`);
  const keyId = keyIdHex(sig.subarray(2, 10));
  if (keyId !== publicKey.keyId) {
    throw new MinisignError(`Signed by key ${keyId}, expected ${publicKey.keyId}`);
  }
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const bare = sig.subarray(10);
  if (!verify(null, signed, publicKey.key, bare)) throw new MinisignError('Signature does not match the file');
  const trustedComment = lines[2]!.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([bare, Buffer.from(trustedComment, 'utf8')]), publicKey.key, globalSig)) {
    throw new MinisignError('Trusted comment signature is invalid');
  }
  return { keyId, prehashed: alg === 'ED', trustedComment };
}
