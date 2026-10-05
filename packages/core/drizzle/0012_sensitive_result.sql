ALTER TABLE `operations` ADD `sensitive_result` text;--> statement-breakpoint
ALTER TABLE `plugin_instances` ADD `catalog_plugin_version` text;--> statement-breakpoint
-- A successful sync before this release came from the installed version, and no such catalog needs core
-- masking (older SDKs mask their own; SDK 0.4+ refuses older cores). Saves every endpoint a blocking resync.
UPDATE `plugin_instances` SET `catalog_plugin_version` = (
  SELECT `version` FROM `plugins` WHERE `plugins`.`id` = `plugin_instances`.`plugin_id`
) WHERE `last_synced_at` IS NOT NULL AND `last_sync_status` = 'ok';