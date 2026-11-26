CREATE TABLE `entidade_membros` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`entidade_id` int NOT NULL,
	`contact_id` bigint,
	`pais_documento` varchar(2) NOT NULL,
	`tipo_documento` varchar(10) NOT NULL,
	`documento_hmac` varchar(64) NOT NULL,
	`documento_cifrado` text,
	`contato_cifrado` text,
	`cnae_principal` varchar(7),
	`cnaes_secundarios` json,
	`referencia_da_entidade` varchar(100),
	`preciso_origem` varchar(20),
	`preciso_declarado_em` bigint,
	`lote_id` int,
	`estado` varchar(12) NOT NULL DEFAULT 'importado',
	`ativacao_hash` varchar(64),
	`ativacao_expira_em` bigint,
	`ativado_user_id` int,
	`ativado_em` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `entidade_membros_id` PRIMARY KEY(`id`),
	CONSTRAINT `em_ativacao_unique` UNIQUE(`ativacao_hash`),
	CONSTRAINT `em_contact_unique` UNIQUE(`contact_id`),
	CONSTRAINT `em_entidade_documento_unique` UNIQUE(`entidade_id`,`documento_hmac`)
);
--> statement-breakpoint
CREATE TABLE `entidades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`nome` varchar(200) NOT NULL,
	`tipo` varchar(20) NOT NULL,
	`pais` varchar(2) NOT NULL,
	`convenio_estado` varchar(20) NOT NULL DEFAULT 'em_negociacao',
	`convenio_inicio` bigint,
	`convenio_fim` bigint,
	`convenio_referencia` varchar(120),
	`mostrar_nome_no_match` boolean NOT NULL DEFAULT false,
	`disponivel_por_padrao` boolean NOT NULL DEFAULT true,
	`convite_hash` varchar(64),
	`convite_cifrado` text,
	`convite_gerado_em` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `entidades_id` PRIMARY KEY(`id`),
	CONSTRAINT `entidades_owner_unique` UNIQUE(`owner_id`),
	CONSTRAINT `entidades_convite_unique` UNIQUE(`convite_hash`)
);
--> statement-breakpoint
CREATE TABLE `importacao_documentos_vistos` (
	`importacao_id` int NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`documento_hmac` varchar(64) NOT NULL,
	`linha` int NOT NULL,
	CONSTRAINT `idv_pk` PRIMARY KEY(`importacao_id`,`documento_hmac`)
);
--> statement-breakpoint
CREATE TABLE `importacoes_de_entidade` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`entidade_id` int NOT NULL,
	`arquivo_sha256` varchar(64) NOT NULL,
	`modo` varchar(10) NOT NULL,
	`estado` varchar(15) NOT NULL DEFAULT 'em_andamento',
	`total_linhas` int NOT NULL,
	`linhas_processadas` int NOT NULL DEFAULT 0,
	`criados` int NOT NULL DEFAULT 0,
	`atualizados` int NOT NULL DEFAULT 0,
	`recusados` int NOT NULL DEFAULT 0,
	`com_aviso` int NOT NULL DEFAULT 0,
	`por_codigo` json,
	`iniciada_em` bigint NOT NULL,
	`concluida_em` bigint,
	CONSTRAINT `importacoes_de_entidade_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pedidos_pela_entidade` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`entidade_id` int NOT NULL,
	`membro_id` bigint NOT NULL,
	`conexao_id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`mensagem` varchar(500),
	`estado` varchar(16) NOT NULL DEFAULT 'na_entidade',
	`canal` varchar(10),
	`expira_em` bigint NOT NULL,
	`encaminhado_em` bigint,
	`decidido_em` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `pedidos_pela_entidade_id` PRIMARY KEY(`id`),
	CONSTRAINT `pe_conexao_solicitante_unique` UNIQUE(`conexao_id`,`userId`,`membro_id`)
);
--> statement-breakpoint
ALTER TABLE `contact_assets` ADD `origem` varchar(20);--> statement-breakpoint
ALTER TABLE `users` ADD `isEntidade` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `em_ativado_user_idx` ON `entidade_membros` (`ativado_user_id`);--> statement-breakpoint
CREATE INDEX `em_documento_idx` ON `entidade_membros` (`documento_hmac`);--> statement-breakpoint
CREATE INDEX `em_entidade_estado_idx` ON `entidade_membros` (`entidade_id`,`estado`);--> statement-breakpoint
CREATE INDEX `em_owner_idx` ON `entidade_membros` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idv_owner_idx` ON `importacao_documentos_vistos` (`owner_id`);--> statement-breakpoint
CREATE INDEX `ie_entidade_idx` ON `importacoes_de_entidade` (`entidade_id`,`iniciada_em`);--> statement-breakpoint
CREATE INDEX `pe_entidade_estado_idx` ON `pedidos_pela_entidade` (`entidade_id`,`estado`);--> statement-breakpoint
CREATE INDEX `pe_solicitante_idx` ON `pedidos_pela_entidade` (`userId`,`created_at`);--> statement-breakpoint
CREATE INDEX `pe_owner_idx` ON `pedidos_pela_entidade` (`owner_id`);