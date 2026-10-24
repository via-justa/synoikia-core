ALTER TABLE `users` ADD `kind` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `oidc_email` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_email_idx` ON `users` (lower("oidc_email"));--> statement-breakpoint
-- ADR-0025: an identity that still signs in makes an SSO account, without password or app. One that cannot (SSO off,
-- another issuer) goes instead, and its user keeps the password, so the upgrade locks nobody out.
CREATE TEMP TABLE `identity_live` AS
  SELECT u.`id`, (EXISTS (SELECT 1 FROM `oidc_config` c WHERE c.`enabled` = 1
      AND rtrim(c.`issuer`, '/') = rtrim(u.`oidc_issuer`, '/'))) AS `live`
  FROM `users` u WHERE u.`oidc_subject` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `audit_log` (`at`, `kind`, `decision`, `actor_kind`, `actor_id`, `detail`)
  SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER), 'auth', 'password_removed_sso_account', 'system', u.`id`,
    json_object('username', u.`username`, 'passwordRemoved', json(CASE WHEN u.`password_hash` IS NULL THEN 'false' ELSE 'true' END),
      'totpRemoved', json(CASE WHEN u.`totp_enabled` = 1 THEN 'true' ELSE 'false' END), 'migration', '0020_account_kinds')
  FROM `users` u JOIN `identity_live` l ON l.`id` = u.`id`
  WHERE (l.`live` = 1 OR u.`password_hash` IS NULL)
    AND (u.`password_hash` IS NOT NULL OR u.`totp_enabled` = 1 OR u.`recovery_codes_hash` IS NOT NULL);
--> statement-breakpoint
INSERT INTO `audit_log` (`at`, `kind`, `decision`, `actor_kind`, `actor_id`, `detail`)
  SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER), 'auth', 'oidc_identity_removed', 'system', u.`id`,
    json_object('username', u.`username`, 'issuer', u.`oidc_issuer`, 'migration', '0020_account_kinds')
  FROM `users` u JOIN `identity_live` l ON l.`id` = u.`id`
  WHERE l.`live` = 0 AND u.`password_hash` IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `oidc_issuer` = NULL, `oidc_subject` = NULL
  WHERE `id` IN (SELECT `id` FROM `identity_live` WHERE `live` = 0) AND `password_hash` IS NOT NULL;
--> statement-breakpoint
UPDATE `users` SET `kind` = 'sso', `password_hash` = NULL, `totp_secret_enc` = NULL, `totp_enabled` = 0,
    `totp_last_step` = NULL, `recovery_codes_hash` = NULL
  WHERE `oidc_subject` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `identity_live`;
