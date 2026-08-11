CREATE TABLE `device_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_id_source` text NOT NULL,
	`user_id` text,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`runtime_version` text NOT NULL,
	`current_update_id` text,
	`current_update_since` integer,
	`embedded_update_id` text,
	`last_served_update_id` text,
	`last_served_at` integer,
	`confirmed_update_id` text,
	`request_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_installs_platform_check" CHECK(platform IN ('ios', 'android')),
	CONSTRAINT "device_installs_client_id_source_check" CHECK(client_id_source IN ('eas', 'extra', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_installs_app_client_unique` ON `device_installs` (`application_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `device_installs_app_current_idx` ON `device_installs` (`application_id`,`current_update_id`);--> statement-breakpoint
CREATE INDEX `device_installs_app_seen_idx` ON `device_installs` (`application_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `device_installs_app_user_idx` ON `device_installs` (`application_id`,`user_id`) WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `device_update_events` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`client_id` text NOT NULL,
	`update_id` text NOT NULL,
	`kind` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_update_events_kind_check" CHECK(kind IN ('served', 'confirmed')),
	CONSTRAINT "device_update_events_platform_check" CHECK(platform IN ('ios', 'android'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_update_events_unique` ON `device_update_events` (`application_id`,`client_id`,`update_id`,`kind`);--> statement-breakpoint
CREATE INDEX `device_update_events_app_update_idx` ON `device_update_events` (`application_id`,`update_id`,`kind`);--> statement-breakpoint
CREATE INDEX `device_update_events_app_created_idx` ON `device_update_events` (`application_id`,`created_at`);