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
ALTER TABLE `meetings` ADD `summary_request` json;--> statement-breakpoint
CREATE INDEX `modelos_de_resumo_proprios_owner_idx` ON `modelos_de_resumo_proprios` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumos_refeitos_owner_created_idx` ON `resumos_refeitos` (`owner_id`,`created_at`);