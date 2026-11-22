CREATE TABLE `perguntas_entre_reunioes` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`situacao` varchar(16) NOT NULL DEFAULT 'pendente',
	`reunioes_escolhidas` int NOT NULL,
	`reunioes_lidas` int NOT NULL,
	`fontes_citadas` int NOT NULL DEFAULT 0,
	`caracteres` int NOT NULL,
	`visual` varchar(12),
	`modelo` varchar(80),
	`avaliacao` varchar(8),
	`avaliada_em` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `perguntas_entre_reunioes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `perguntas_entre_reunioes_owner_created_idx` ON `perguntas_entre_reunioes` (`owner_id`,`created_at`);