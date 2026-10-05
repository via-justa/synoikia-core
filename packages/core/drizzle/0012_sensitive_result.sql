ALTER TABLE `operations` ADD `sensitive_result` text;--> statement-breakpoint
ALTER TABLE `plugin_instances` ADD `catalog_plugin_version` text;--> statement-breakpoint
-- Catalogs synced before this release came from the plugin version installed now, and none of them
-- needs core to mask results: plugins built before SDK 0.4 mask their own, and an SDK 0.4+ plugin on an
-- older core refuses to sync and to run any operation that declares `sensitiveResult`. Recording the
-- version keeps upgrades from forcing a blocking resync of every endpoint; the next bundle change
-- (install, update, files copied in and a restart) still does.
UPDATE `plugin_instances` SET `catalog_plugin_version` = (
  SELECT `version` FROM `plugins` WHERE `plugins`.`id` = `plugin_instances`.`plugin_id`
) WHERE `last_synced_at` IS NOT NULL;