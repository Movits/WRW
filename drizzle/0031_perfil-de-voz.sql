CREATE TABLE `voice_profile_consents` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`evento` varchar(12) NOT NULL,
	`origem` varchar(20) NOT NULL,
	`versao_do_texto` varchar(40) NOT NULL,
	`idioma` varchar(12),
	`texto_exibido` text,
	`texto_hash` varchar(64),
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	`created_at` bigint NOT NULL,
	CONSTRAINT `voice_profile_consents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `voice_profiles` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`mime_type` varchar(32) NOT NULL,
	`bytes` int NOT NULL,
	`duration_ms` int NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `voice_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `voice_profiles_owner_unique` UNIQUE(`owner_id`)
);
--> statement-breakpoint
CREATE INDEX `voice_profile_consents_owner_created_idx` ON `voice_profile_consents` (`owner_id`,`created_at`);