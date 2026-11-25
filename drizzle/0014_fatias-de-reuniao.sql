CREATE TABLE `meeting_audio_slices` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`seq` int NOT NULL,
	`status` enum('uploading','received','transcribed','failed') NOT NULL DEFAULT 'uploading',
	`storage_key` varchar(512) NOT NULL,
	`storage_url` varchar(512) NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`duration_ms` int NOT NULL,
	`offset_ms` bigint,
	`attempts` int NOT NULL DEFAULT 0,
	`locked_until` bigint,
	`lock_token` varchar(36),
	`last_error` varchar(500),
	`result` json,
	`model` varchar(80),
	`expires_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_audio_slices_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_audio_slices_meeting_seq_unique` UNIQUE(`meeting_id`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `meeting_transcript_translations` MODIFY COLUMN `translated_text` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` MODIFY COLUMN `transcript` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `meetings` MODIFY COLUMN `status` enum('draft','recording','processing','ready','failed','deleted','uploading') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `meetings` ADD `audio_pipeline` enum('single','slices') DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `meetings` ADD `origem` varchar(16);--> statement-breakpoint
ALTER TABLE `meetings` ADD `consent_notice_version` varchar(32);--> statement-breakpoint
ALTER TABLE `meetings` ADD `expected_slices` int;--> statement-breakpoint
ALTER TABLE `meetings` ADD `attempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meetings` ADD `locked_until` bigint;--> statement-breakpoint
ALTER TABLE `meetings` ADD `lock_token` varchar(36);--> statement-breakpoint
CREATE INDEX `meeting_audio_slices_status_locked_idx` ON `meeting_audio_slices` (`status`,`locked_until`);--> statement-breakpoint
CREATE INDEX `meeting_audio_slices_owner_meeting_idx` ON `meeting_audio_slices` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_audio_slices_expires_idx` ON `meeting_audio_slices` (`expires_at`);--> statement-breakpoint
CREATE INDEX `meetings_pipeline_status_idx` ON `meetings` (`audio_pipeline`,`status`);