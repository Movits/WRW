CREATE TABLE `dispositivos_de_push` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`sessao_id` int NOT NULL,
	`token` varchar(255) NOT NULL,
	`plataforma` varchar(8) NOT NULL,
	`idioma` varchar(12) NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `dispositivos_de_push_id` PRIMARY KEY(`id`),
	CONSTRAINT `dispositivos_de_push_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
ALTER TABLE `platform_notifications` ADD `pushEnviadoEm` timestamp;--> statement-breakpoint
CREATE INDEX `dispositivos_de_push_user_idx` ON `dispositivos_de_push` (`userId`);--> statement-breakpoint
CREATE INDEX `pnotif_created_idx` ON `platform_notifications` (`createdAt`);