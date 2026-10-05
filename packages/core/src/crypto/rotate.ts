import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { notifierChannels, oidcConfig, pluginInstances, sessions, users } from '../db/schema.js';
import { aad } from './index.js';
import type { SecretBox } from './index.js';

/** Master-key rotation (design §7.2): decrypt everything, then re-encrypt in one transaction (a wrong
 * key changes nothing); sessions are cleared since their pepper derives from the key. */

export interface RotationResult {
  users: number;
  oidc: number;
  instances: number;
  notifiers: number;
  sessionsCleared: number;
}

export function rotateSecrets(db: Db, from: SecretBox, to: SecretBox): RotationResult {
  const reencrypt = (blob: Buffer, table: string, column: string, id: string) => {
    const ad = aad(table, column, id);
    return to.encrypt(from.decrypt(blob, ad), ad);
  };
  return db.transaction((tx) => {
    const userRows = tx
      .select()
      .from(users)
      .all()
      .filter((u) => u.totpSecretEnc);
    const oidcRows = tx
      .select()
      .from(oidcConfig)
      .all()
      .filter((o) => o.clientSecretEnc);
    const instanceRows = tx
      .select()
      .from(pluginInstances)
      .all()
      .filter((i) => i.secretsEnc);
    const notifierRows = tx
      .select()
      .from(notifierChannels)
      .all()
      .filter((n) => n.secretsEnc);

    // Decrypt-and-re-encrypt everything before writing anything.
    const updates = [
      ...userRows.map((u) => {
        const v = reencrypt(u.totpSecretEnc!, 'users', 'totp_secret_enc', u.id);
        return () => tx.update(users).set({ totpSecretEnc: v }).where(eq(users.id, u.id)).run();
      }),
      ...oidcRows.map((o) => {
        const v = reencrypt(o.clientSecretEnc!, 'oidc_config', 'client_secret_enc', String(o.id));
        return () => tx.update(oidcConfig).set({ clientSecretEnc: v }).where(eq(oidcConfig.id, o.id)).run();
      }),
      ...instanceRows.map((i) => {
        const v = reencrypt(i.secretsEnc!, 'plugin_instances', 'secrets_enc', i.id);
        return () => tx.update(pluginInstances).set({ secretsEnc: v }).where(eq(pluginInstances.id, i.id)).run();
      }),
      ...notifierRows.map((n) => {
        const v = reencrypt(n.secretsEnc!, 'notifier_channels', 'secrets_enc', n.id);
        return () => tx.update(notifierChannels).set({ secretsEnc: v }).where(eq(notifierChannels.id, n.id)).run();
      }),
    ];
    for (const apply of updates) apply();
    const sessionsCleared = tx.delete(sessions).run().changes;
    return {
      users: userRows.length,
      oidc: oidcRows.length,
      instances: instanceRows.length,
      notifiers: notifierRows.length,
      sessionsCleared,
    };
  });
}
