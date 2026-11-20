ALTER TABLE `meetings` ADD `share_password_hash` varchar(128);--> statement-breakpoint
ALTER TABLE `meetings` ADD `share_password_failures` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meetings` ADD `share_password_failed_at` bigint;--> statement-breakpoint
ALTER TABLE `meetings` ADD `share_password_locked_until` bigint;--> statement-breakpoint
ALTER TABLE `meetings` ADD `share_audio` boolean DEFAULT true NOT NULL;