CREATE TABLE `chaves_de_acesso` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`credencial_id` varchar(512) NOT NULL,
	`chave_publica` text NOT NULL,
	`contador` bigint NOT NULL DEFAULT 0,
	`transportes` json,
	`tipo_do_aparelho` varchar(16) NOT NULL,
	`sincronizada` boolean NOT NULL DEFAULT false,
	`identificador_da_usuaria` varchar(64) NOT NULL,
	`aaguid` varchar(36),
	`apelido` varchar(60),
	`created_at` bigint NOT NULL,
	`ultimo_uso_em` bigint,
	CONSTRAINT `chaves_de_acesso_id` PRIMARY KEY(`id`),
	CONSTRAINT `chaves_de_acesso_credencial_unique` UNIQUE(`credencial_id`)
);
--> statement-breakpoint
CREATE TABLE `desafios_de_chave_de_acesso` (
	`id` varchar(36) NOT NULL,
	`desafio` varchar(128) NOT NULL,
	`finalidade` varchar(12) NOT NULL,
	`userId` int,
	`identificador_da_usuaria` varchar(64),
	`expira_em` bigint NOT NULL,
	`consumido_em` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `desafios_de_chave_de_acesso_id` PRIMARY KEY(`id`),
	CONSTRAINT `desafios_de_chave_de_acesso_desafio_unique` UNIQUE(`desafio`)
);
--> statement-breakpoint
CREATE INDEX `chaves_de_acesso_user_idx` ON `chaves_de_acesso` (`userId`);--> statement-breakpoint
CREATE INDEX `desafios_de_chave_de_acesso_expira_idx` ON `desafios_de_chave_de_acesso` (`expira_em`);--> statement-breakpoint
CREATE INDEX `desafios_de_chave_de_acesso_user_idx` ON `desafios_de_chave_de_acesso` (`userId`);