CREATE TABLE `agenda_reunioes` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`inicio_em` bigint NOT NULL,
	`duracao_minutos` int NOT NULL,
	`fuso` varchar(64) NOT NULL,
	`local` varchar(500),
	`participantes` json NOT NULL,
	`lembrete_minutos` int,
	`meeting_id` varchar(36),
	`google` varchar(16),
	`google_convites` boolean NOT NULL DEFAULT false,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `agenda_reunioes_id` PRIMARY KEY(`id`),
	CONSTRAINT `agenda_reunioes_meeting_unique` UNIQUE(`meeting_id`)
);
--> statement-breakpoint
CREATE TABLE `google_agenda_conexoes` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`google_sub` varchar(255) NOT NULL,
	`email_google` varchar(320),
	`refresh_token_cifrado` text NOT NULL,
	`escopos` varchar(1000) NOT NULL,
	`falha` varchar(32),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `google_agenda_conexoes_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_agenda_conexoes_user_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `lembretes` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`origem` varchar(8) NOT NULL,
	`origem_id` varchar(36) NOT NULL,
	`disparar_em` bigint NOT NULL,
	`expira_em` bigint NOT NULL,
	`disparado_em` bigint,
	`lock_token` varchar(36),
	`locked_until` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `lembretes_id` PRIMARY KEY(`id`),
	CONSTRAINT `lembretes_owner_origem_unique` UNIQUE(`owner_id`,`origem`,`origem_id`)
);
--> statement-breakpoint
CREATE TABLE `proximas_acoes` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`texto` text NOT NULL,
	`detalhe` text,
	`responsavel` varchar(120),
	`prazo` date,
	`prazo_dito` varchar(120),
	`contact_id` bigint,
	`meeting_id` varchar(36),
	`item_id` varchar(36),
	`trecho` text,
	`origem` varchar(8) NOT NULL,
	`feita` boolean NOT NULL DEFAULT false,
	`feita_em` bigint,
	`google` varchar(16),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `proximas_acoes_id` PRIMARY KEY(`id`),
	CONSTRAINT `proximas_acoes_owner_item_unique` UNIQUE(`owner_id`,`item_id`)
);
--> statement-breakpoint
ALTER TABLE `platform_notifications` MODIFY COLUMN `type` enum('new_match','interest_received','gold_granted','gold_revoked','opportunity_approved','opportunity_rejected','new_message','compliance_update','system','lembrete','reuniao_pronta') NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_notifications` ADD `parametros` json;--> statement-breakpoint
CREATE INDEX `agenda_reunioes_owner_inicio_idx` ON `agenda_reunioes` (`owner_id`,`inicio_em`);--> statement-breakpoint
CREATE INDEX `google_agenda_conexoes_sub_idx` ON `google_agenda_conexoes` (`google_sub`);--> statement-breakpoint
CREATE INDEX `lembretes_disparo_idx` ON `lembretes` (`disparado_em`,`disparar_em`);--> statement-breakpoint
CREATE INDEX `lembretes_lock_idx` ON `lembretes` (`lock_token`);--> statement-breakpoint
CREATE INDEX `proximas_acoes_owner_feita_prazo_idx` ON `proximas_acoes` (`owner_id`,`feita`,`prazo`);--> statement-breakpoint
CREATE INDEX `proximas_acoes_owner_meeting_idx` ON `proximas_acoes` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `proximas_acoes_owner_contact_idx` ON `proximas_acoes` (`owner_id`,`contact_id`);