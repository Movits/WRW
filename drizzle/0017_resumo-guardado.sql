CREATE TABLE `meeting_summaries` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`transcript_id` varchar(36),
	`status` varchar(12) NOT NULL DEFAULT 'pending',
	`template` varchar(16) NOT NULL DEFAULT 'general',
	`language` varchar(12),
	`emoji` varchar(16),
	`model` varchar(80),
	`version` int NOT NULL DEFAULT 0,
	`generated_at` bigint,
	`attempts` int NOT NULL DEFAULT 0,
	`locked_until` bigint,
	`lock_token` varchar(36),
	`last_error` varchar(40),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_summaries_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_summaries_meeting_unique` UNIQUE(`meeting_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_summary_items` (
	`id` varchar(36) NOT NULL,
	`summary_id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`section` varchar(12) NOT NULL,
	`position` int NOT NULL,
	`subject` varchar(120),
	`text` text NOT NULL,
	`assignee` varchar(120),
	`due` varchar(120),
	`excerpt` text NOT NULL,
	`start_seconds` int,
	`confidence` decimal(4,3) NOT NULL DEFAULT '0.000',
	`status` varchar(12) NOT NULL DEFAULT 'pending',
	`done` boolean NOT NULL DEFAULT false,
	`decided_at` bigint,
	`done_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_summary_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `meeting_summaries_owner_meeting_idx` ON `meeting_summaries` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_summaries_status_locked_idx` ON `meeting_summaries` (`status`,`locked_until`);--> statement-breakpoint
CREATE INDEX `meeting_summary_items_summary_position_idx` ON `meeting_summary_items` (`summary_id`,`position`);--> statement-breakpoint
CREATE INDEX `meeting_summary_items_owner_meeting_idx` ON `meeting_summary_items` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_summary_items_owner_section_status_idx` ON `meeting_summary_items` (`owner_id`,`section`,`status`);