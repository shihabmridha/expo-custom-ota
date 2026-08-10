CREATE TABLE `application_signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`key_id` text NOT NULL,
	`certificate_pem` text NOT NULL,
	`certificate_fingerprint` text NOT NULL,
	`certificate_not_after` integer NOT NULL,
	`private_key_ref` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "signing_keys_status_check" CHECK(status IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signing_keys_app_keyid_unique` ON `application_signing_keys` (`application_id`,`key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signing_keys_one_active_per_app` ON `application_signing_keys` (`application_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `signing_keys_app_idx` ON `application_signing_keys` (`application_id`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`update_key` text NOT NULL,
	`description` text,
	`android_package` text,
	`ios_bundle_identifier` text,
	`default_channel` text DEFAULT 'production' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_slug_unique` ON `applications` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `applications_update_key_unique` ON `applications` (`update_key`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`file_extension` text,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_sha256_unique` ON `assets` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_storage_key_unique` ON `assets` (`storage_key`);--> statement-breakpoint
CREATE INDEX `assets_created_at_idx` ON `assets` (`created_at`);--> statement-breakpoint
CREATE TABLE `admins` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_email_unique` ON `admins` (`email`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`ip_hash` text,
	`user_agent` text,
	FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_admin_idx` ON `sessions` (`admin_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_app_name_unique` ON `channels` (`application_id`,`name`);--> statement-breakpoint
CREATE INDEX `channels_app_idx` ON `channels` (`application_id`);--> statement-breakpoint
CREATE TABLE `deployment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`platform` text NOT NULL,
	`runtime_version` text NOT NULL,
	`from_variant_id` text,
	`to_variant_id` text,
	`action` text NOT NULL,
	`actor_admin_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deployment_events_action_check" CHECK(action IN ('publish', 'promote', 'rollback', 'rollback_to_embedded', 'clear'))
);
--> statement-breakpoint
CREATE INDEX `deployment_events_app_idx` ON `deployment_events` (`application_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`platform` text NOT NULL,
	`runtime_version` text NOT NULL,
	`release_variant_id` text,
	`directive` text,
	`directive_commit_time` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_variant_id`) REFERENCES `release_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deployments_platform_check" CHECK(platform IN ('ios', 'android')),
	CONSTRAINT "deployments_directive_check" CHECK(directive IS NULL OR directive = 'rollBackToEmbedded'),
	CONSTRAINT "deployments_target_exclusive_check" CHECK((release_variant_id IS NOT NULL) <> (directive IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_target_unique` ON `deployments` (`application_id`,`channel_id`,`platform`,`runtime_version`);--> statement-breakpoint
CREATE INDEX `deployments_app_channel_idx` ON `deployments` (`application_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `deployments_variant_idx` ON `deployments` (`release_variant_id`);--> statement-breakpoint
CREATE TABLE `release_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`release_variant_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`asset_key` text NOT NULL,
	`type` text NOT NULL,
	`file_extension` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`release_variant_id`) REFERENCES `release_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "release_assets_type_check" CHECK(type IN ('launch', 'asset'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_assets_variant_key_unique` ON `release_assets` (`release_variant_id`,`asset_key`);--> statement-breakpoint
CREATE INDEX `release_assets_asset_idx` ON `release_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `release_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`platform` text NOT NULL,
	`runtime_version` text NOT NULL,
	`update_id` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_signature` text,
	`signing_key_id` text,
	`launch_asset_id` text NOT NULL,
	`expo_config` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`launch_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "release_variants_platform_check" CHECK(platform IN ('ios', 'android'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_variants_update_id_unique` ON `release_variants` (`update_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_variants_release_platform_unique` ON `release_variants` (`release_id`,`platform`);--> statement-breakpoint
CREATE INDEX `release_variants_release_idx` ON `release_variants` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`release_number` integer NOT NULL,
	`message` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`import_status` text DEFAULT 'uploaded' NOT NULL,
	`import_error` text,
	`source_filename` text,
	`source_hash` text,
	`source_storage_key` text,
	`source_size_bytes` integer,
	`idempotency_key` text,
	`rollback_of_release_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "releases_status_check" CHECK(status IN ('draft', 'published', 'archived')),
	CONSTRAINT "releases_import_status_check" CHECK(import_status IN ('uploaded', 'processing', 'assets_uploaded', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_app_number_unique` ON `releases` (`application_id`,`release_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `releases_app_idempotency_unique` ON `releases` (`application_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `releases_app_status_idx` ON `releases` (`application_id`,`status`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`day` text NOT NULL,
	`platform` text NOT NULL,
	`result` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_daily_platform_check" CHECK(platform IN ('ios', 'android'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_daily_unique` ON `usage_daily` (`application_id`,`day`,`platform`,`result`);