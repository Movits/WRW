CREATE TABLE `meeting_attachments` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`kind` enum('photo','drawing') NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`storage_url` varchar(512) NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `meeting_attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `meeting_attachments_meeting_idx` ON `meeting_attachments` (`meeting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_attachments_owner_expires_idx` ON `meeting_attachments` (`owner_id`,`expires_at`);