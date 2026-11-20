CREATE TABLE `resumo_por_email` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`lote_id` varchar(36) NOT NULL,
	`destinatario` varchar(320),
	`origem` varchar(16) NOT NULL,
	`idioma` varchar(12) NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'pendente',
	`automatico` boolean NOT NULL DEFAULT false,
	`tentativas` int NOT NULL DEFAULT 0,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	`enviado_em` bigint,
	CONSTRAINT `resumo_por_email_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `resumoPorEmailAutomatico` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `resumo_por_email_owner_created_idx` ON `resumo_por_email` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `resumo_por_email_meeting_created_idx` ON `resumo_por_email` (`meeting_id`,`created_at`);