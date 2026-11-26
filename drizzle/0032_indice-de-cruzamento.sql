CREATE TABLE `chaves_de_cruzamento` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`lado` varchar(8) NOT NULL,
	`item_id` bigint NOT NULL,
	`contact_id` bigint NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`chave` varchar(16) NOT NULL,
	`versao` int NOT NULL DEFAULT 1,
	CONSTRAINT `chaves_de_cruzamento_id` PRIMARY KEY(`id`),
	CONSTRAINT `cdc_lado_item_chave_unique` UNIQUE(`lado`,`item_id`,`chave`)
);
--> statement-breakpoint
CREATE TABLE `fila_de_cruzamento` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`user_id` int NOT NULL,
	`tipo` varchar(10) NOT NULL,
	`estado` varchar(12) NOT NULL DEFAULT 'pendente',
	`cursor` bigint NOT NULL DEFAULT 0,
	`de_novo` boolean NOT NULL DEFAULT false,
	`vivo` boolean DEFAULT true,
	`processados` int NOT NULL DEFAULT 0,
	`conexoes` int NOT NULL DEFAULT 0,
	`por_contraparte` text,
	`tentativas` int NOT NULL DEFAULT 0,
	`erro` varchar(300),
	`lock_token` varchar(36),
	`locked_until` bigint,
	`criada_em` bigint NOT NULL,
	`atualizada_em` bigint NOT NULL,
	CONSTRAINT `fila_de_cruzamento_id` PRIMARY KEY(`id`),
	CONSTRAINT `fdc_dona_tipo_vivo_unique` UNIQUE(`owner_id`,`tipo`,`vivo`)
);
--> statement-breakpoint
CREATE INDEX `cdc_lado_chave_contato_idx` ON `chaves_de_cruzamento` (`lado`,`chave`,`contact_id`);--> statement-breakpoint
CREATE INDEX `cdc_contato_idx` ON `chaves_de_cruzamento` (`contact_id`);--> statement-breakpoint
CREATE INDEX `cdc_owner_idx` ON `chaves_de_cruzamento` (`owner_id`);--> statement-breakpoint
CREATE INDEX `fdc_estado_idx` ON `fila_de_cruzamento` (`estado`,`criada_em`);--> statement-breakpoint
CREATE INDEX `fdc_dona_idx` ON `fila_de_cruzamento` (`owner_id`,`tipo`,`estado`);