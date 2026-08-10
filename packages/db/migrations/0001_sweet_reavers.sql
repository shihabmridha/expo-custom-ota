DROP INDEX `signing_keys_app_keyid_unique`;--> statement-breakpoint
CREATE INDEX `signing_keys_app_keyid_idx` ON `application_signing_keys` (`application_id`,`key_id`);