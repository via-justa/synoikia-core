CREATE TABLE `role_instances` (
	`role_id` text NOT NULL,
	`instance_id` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_instances_idx` ON `role_instances` (`role_id`,`instance_id`);--> statement-breakpoint
CREATE TABLE `role_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`group_id` text,
	`operation_id` text,
	`level` text NOT NULL,
	`changed_at` integer,
	`changed_by` text,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `operation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_levels_group_idx` ON `role_levels` (`role_id`,`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_levels_op_idx` ON `role_levels` (`role_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`can_set_own_levels` integer DEFAULT false NOT NULL,
	`can_manage_own_rules` integer DEFAULT false NOT NULL,
	`can_see_status` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `user_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`group_id` text,
	`operation_id` text,
	`level` text NOT NULL,
	`changed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `plugin_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `operation_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_levels_group_idx` ON `user_levels` (`user_id`,`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_levels_op_idx` ON `user_levels` (`user_id`,`operation_id`);--> statement-breakpoint
ALTER TABLE `pending_approvals` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `pre_approval_rules` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `users` ADD `role_id` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
-- The built-in Admin role: every existing user keeps full administration.
INSERT INTO `roles` (`id`, `name`, `built_in`, `can_set_own_levels`, `can_manage_own_rules`, `can_see_status`)
  VALUES ('admin', 'Admin', 1, 1, 1, 1);--> statement-breakpoint
-- Every credential has an owner whose role decides its reach: tokens without a creator go to the oldest enabled user.
UPDATE `mcp_tokens` SET `created_by` = (SELECT `id` FROM `users` ORDER BY `disabled`, `created_at`, `id` LIMIT 1)
  WHERE `created_by` IS NULL;
