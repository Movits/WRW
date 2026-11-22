CREATE TABLE `meeting_folders` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`name` varchar(60) NOT NULL,
	`icon` varchar(24) NOT NULL,
	`color` varchar(16) NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_folders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `original_transcript` mediumtext;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `original_segments` json;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `edited_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `revision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meetings` ADD `folder_id` varchar(36);--> statement-breakpoint
ALTER TABLE `meetings` ADD `trashed_at` bigint;--> statement-breakpoint
CREATE INDEX `meeting_folders_owner_created_idx` ON `meeting_folders` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meetings_owner_folder_idx` ON `meetings` (`owner_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `meetings_trashed_idx` ON `meetings` (`trashed_at`);