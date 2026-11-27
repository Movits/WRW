CREATE TABLE `recording_notice_acceptances` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`versao_do_aviso` varchar(32) NOT NULL,
	`idioma` varchar(12),
	`ip_address` varchar(45),
	`user_agent` varchar(500),
	`created_at` bigint NOT NULL,
	CONSTRAINT `recording_notice_acceptances_id` PRIMARY KEY(`id`),
	CONSTRAINT `recording_notice_acceptances_owner_versao_unique` UNIQUE(`owner_id`,`versao_do_aviso`)
);
