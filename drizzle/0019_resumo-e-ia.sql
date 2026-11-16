CREATE TABLE `meeting_summary_translations` (
	`id` varchar(36) NOT NULL,
	`summary_id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`language` varchar(12) NOT NULL,
	`source_version` int NOT NULL,
	`content` json NOT NULL,
	`model` varchar(80),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_summary_translations_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_summary_translations_owner_meeting_language_idx` UNIQUE(`owner_id`,`meeting_id`,`language`)
);
--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map` json;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_status` varchar(12);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_generated_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_error` varchar(40);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `origin` varchar(12) DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `edited_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `status_before_ignore` varchar(12);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `done_at_before_ignore` bigint;--> statement-breakpoint
CREATE INDEX `meeting_summaries_mind_map_status_locked_idx` ON `meeting_summaries` (`mind_map_status`,`locked_until`);