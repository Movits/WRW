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
CREATE TABLE `modelos_de_resumo_proprios` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`nome` varchar(60) NOT NULL,
	`icone` varchar(16) NOT NULL,
	`instrucoes` varchar(1500) NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `modelos_de_resumo_proprios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `preferencias_do_resumo` (
	`owner_id` varchar(128) NOT NULL,
	`modelo_padrao` varchar(16) NOT NULL DEFAULT 'general',
	`modelo_proprio_padrao_id` varchar(36),
	`estilo_padrao` varchar(10) NOT NULL DEFAULT 'balanced',
	`ajuste_do_tamanho` int NOT NULL DEFAULT 0,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `preferencias_do_resumo_owner_id` PRIMARY KEY(`owner_id`)
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
CREATE TABLE `resumos_refeitos` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `resumos_refeitos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `custom_template_id` varchar(36);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `ai_template` varchar(8);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `style` varchar(10) DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `instructions` varchar(500);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `length_feedback` varchar(8);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_edited` json;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_edited_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_revision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_style` varchar(16);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_previous_style` varchar(16);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_text` text;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_source_url` varchar(2048);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_source_title` varchar(300);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_queries` json;--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_status` varchar(12);--> statement-breakpoint
ALTER TABLE `meeting_summary_items` ADD `complement_at` bigint;--> statement-breakpoint
ALTER TABLE `meetings` ADD `summary_request` json;--> statement-breakpoint
CREATE INDEX `buscas_do_complemento_owner_created_idx` ON `buscas_do_complemento` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_attachments_meeting_idx` ON `meeting_attachments` (`meeting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_attachments_owner_expires_idx` ON `meeting_attachments` (`owner_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `modelos_de_resumo_proprios_owner_idx` ON `modelos_de_resumo_proprios` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumo_em_audio_owner_created_idx` ON `resumo_em_audio` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumo_em_audio_meeting_idx` ON `resumo_em_audio` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `resumos_refeitos_owner_created_idx` ON `resumos_refeitos` (`owner_id`,`created_at`);