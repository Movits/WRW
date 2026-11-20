CREATE TABLE `meeting_documents` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`storage_url` varchar(512) NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`expires_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `meeting_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_documents_meeting_unique` UNIQUE(`meeting_id`)
);
--> statement-breakpoint
CREATE INDEX `meeting_documents_owner_expires_idx` ON `meeting_documents` (`owner_id`,`expires_at`);