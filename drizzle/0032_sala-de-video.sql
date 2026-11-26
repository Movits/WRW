CREATE TABLE `consumo_das_salas` (
	`sala_id` varchar(36) NOT NULL,
	`nome_no_fornecedor` varchar(64) NOT NULL,
	`mes` varchar(7) NOT NULL,
	`criada_em` bigint NOT NULL,
	`expira_em` bigint NOT NULL,
	`encerrada_em` bigint,
	`segundos_pessoa` int NOT NULL DEFAULT 0,
	`medida` boolean NOT NULL,
	CONSTRAINT `consumo_das_salas_sala_id` PRIMARY KEY(`sala_id`),
	CONSTRAINT `consumo_das_salas_nome_unique` UNIQUE(`nome_no_fornecedor`)
);
--> statement-breakpoint
CREATE TABLE `meeting_room_presences` (
	`id` varchar(36) NOT NULL,
	`room_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`userId` int,
	`role` enum('owner','participant','guest') NOT NULL,
	`guest_name` varchar(60),
	`notice_version` varchar(16),
	`notice_accepted_at` bigint,
	`token_issued_at` bigint NOT NULL,
	`token_expires_at` bigint NOT NULL,
	`joined_at` bigint,
	`left_at` bigint,
	`seconds_in_room` int NOT NULL DEFAULT 0,
	`open_session_id` varchar(64),
	`open_session_since` bigint,
	`last_session_id` varchar(64),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_room_presences_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_room_presences_room_user_unique` UNIQUE(`room_id`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `meeting_rooms` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`provider_room_name` varchar(64) NOT NULL,
	`guest_link_hash` varchar(64),
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	`ended_at` bigint,
	CONSTRAINT `meeting_rooms_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_rooms_provider_room_unique` UNIQUE(`provider_room_name`),
	CONSTRAINT `meeting_rooms_guest_link_unique` UNIQUE(`guest_link_hash`)
);
--> statement-breakpoint
CREATE INDEX `consumo_das_salas_mes_idx` ON `consumo_das_salas` (`mes`);--> statement-breakpoint
CREATE INDEX `meeting_room_presences_user_idx` ON `meeting_room_presences` (`userId`);--> statement-breakpoint
CREATE INDEX `meeting_room_presences_owner_room_idx` ON `meeting_room_presences` (`owner_id`,`room_id`);--> statement-breakpoint
CREATE INDEX `meeting_rooms_owner_meeting_idx` ON `meeting_rooms` (`owner_id`,`meeting_id`);