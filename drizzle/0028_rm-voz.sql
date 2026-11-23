CREATE TABLE `buscas_do_complemento` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`situacao` varchar(12) NOT NULL DEFAULT 'pendente',
	`modelo` varchar(80),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `buscas_do_complemento_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `resumo_em_audio` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`language` varchar(12) NOT NULL,
	`text_hash` varchar(64) NOT NULL,
	`situacao` varchar(12) NOT NULL DEFAULT 'pendente',
	`storage_key` varchar(512),
	`bytes` int,
	`duration_ms` int,
	`modelo` varchar(80),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `resumo_em_audio_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_text` text;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_source_url` varchar(2048);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_source_title` varchar(300);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_queries` json;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_status` varchar(12);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_at` bigint;--> statement-breakpoint
CREATE INDEX `buscas_do_complemento_owner_created_idx` ON `buscas_do_complemento` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumo_em_audio_owner_created_idx` ON `resumo_em_audio` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumo_em_audio_meeting_idx` ON `resumo_em_audio` (`owner_id`,`meeting_id`);