import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyCloudflareAccess } from '../src/auth/mcp-auth.js';

/** Cloudflare Access assertions (design §6.2 `external` mode; review test gap 9). */
describe('verifyCloudflareAccess', () => {
  const TEAM = 'home.cloudflareaccess.com';
  const AUD = 'aud-tag-123';

  async function team() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(opts.iss ?? `https://${TEAM}`)
        .setAudience(opts.aud ?? AUD)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(privateKey);
    return { keys, sign };
  }

  it('accepts a valid assertion and returns its email (or subject)', async () => {
    const { keys, sign } = await team();
    await expect(verifyCloudflareAccess(TEAM, AUD, await sign({ email: 'me@example.com' }), keys)).resolves.toBe(
      'me@example.com',
    );
    await expect(verifyCloudflareAccess(`https://${TEAM}/`, AUD, await sign({ sub: 'svc-1' }), keys)).resolves.toBe(
      'svc-1',
    );
  });

  it('names a service token by its client ID, since its subject is empty', async () => {
    const { keys, sign } = await team();
    await expect(
      verifyCloudflareAccess(TEAM, AUD, await sign({ sub: '', common_name: 'abc.access' }), keys),
    ).resolves.toBe('service:abc.access');
  });

  it('refuses an assertion that names nobody, and an email that could pose as a service token', async () => {
    const { keys, sign } = await team();
    for (const claims of [{}, { sub: '' }, { email: '' }])
      await expect(verifyCloudflareAccess(TEAM, AUD, await sign(claims), keys)).resolves.toBeNull();
    await expect(
      verifyCloudflareAccess(TEAM, AUD, await sign({ email: 'service:abc.access', sub: 'u-1' }), keys),
    ).resolves.toBe('u-1');
  });

  it('rejects a wrong audience, a wrong issuer, an expired token, another key and garbage', async () => {
    const { keys, sign } = await team();
    const other = await team();
    const cases = [
      await sign({ email: 'a@b.c' }, { aud: 'someone-elses-app' }),
      await sign({ email: 'a@b.c' }, { iss: 'https://evil.cloudflareaccess.com' }),
      await sign({ email: 'a@b.c' }, { exp: '-1m' }),
      await other.sign({ email: 'a@b.c' }),
      'not-a-jwt',
    ];
    for (const assertion of cases) await expect(verifyCloudflareAccess(TEAM, AUD, assertion, keys)).resolves.toBeNull();
  });
});
