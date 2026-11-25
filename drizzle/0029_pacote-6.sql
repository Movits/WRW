CREATE TABLE `contas_google` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`google_sub` varchar(255) NOT NULL,
	`email_google` varchar(320),
	`created_at` bigint NOT NULL,
	`ultimo_uso_em` bigint,
	CONSTRAINT `contas_google_id` PRIMARY KEY(`id`),
	CONSTRAINT `contas_google_user_unique` UNIQUE(`userId`),
	CONSTRAINT `contas_google_sub_unique` UNIQUE(`google_sub`)
);
--> statement-breakpoint
CREATE TABLE `meeting_folder_members` (
	`id` varchar(36) NOT NULL,
	`folder_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`userId` int,
	`role` enum('member','reader') NOT NULL,
	`status` enum('invited','active') NOT NULL,
	`source` enum('link','connection') NOT NULL,
	`invite_token_hash` varchar(64),
	`invited_at` bigint NOT NULL,
	`expires_at` bigint,
	`accepted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_folder_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_folder_members_folder_user_unique` UNIQUE(`folder_id`,`userId`),
	CONSTRAINT `meeting_folder_members_token_unique` UNIQUE(`invite_token_hash`)
);
--> statement-breakpoint
CREATE TABLE `meeting_folder_tasks` (
	`id` varchar(36) NOT NULL,
	`folder_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`texto` varchar(500) NOT NULL,
	`responsavel` varchar(120),
	`prazo` date,
	`feita` boolean NOT NULL DEFAULT false,
	`feita_em` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_folder_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_participants` (
	`id` varchar(36) NOT NULL,
	`meeting_id` varchar(36) NOT NULL,
	`owner_id` varchar(128) NOT NULL,
	`userId` int,
	`status` enum('invited','active') NOT NULL,
	`source` enum('link','connection') NOT NULL,
	`invite_token_hash` varchar(64),
	`invited_at` bigint NOT NULL,
	`expires_at` bigint,
	`accepted_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `meeting_participants_id` PRIMARY KEY(`id`),
	CONSTRAINT `meeting_participants_meeting_user_unique` UNIQUE(`meeting_id`,`userId`),
	CONSTRAINT `meeting_participants_token_unique` UNIQUE(`invite_token_hash`)
);
--> statement-breakpoint
ALTER TABLE `agenda_reunioes` ADD `folder_id` varchar(36);--> statement-breakpoint
ALTER TABLE `meetings` ADD `speaker_accounts` json;--> statement-breakpoint
ALTER TABLE `meetings` ADD `speaker_merges` json;--> statement-breakpoint
CREATE INDEX `meeting_folder_members_user_status_idx` ON `meeting_folder_members` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `meeting_folder_members_owner_folder_idx` ON `meeting_folder_members` (`owner_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `meeting_folder_tasks_owner_folder_idx` ON `meeting_folder_tasks` (`owner_id`,`folder_id`,`feita`,`prazo`);--> statement-breakpoint
CREATE INDEX `meeting_participants_user_status_idx` ON `meeting_participants` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `meeting_participants_owner_meeting_idx` ON `meeting_participants` (`owner_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `agenda_reunioes_owner_folder_idx` ON `agenda_reunioes` (`owner_id`,`folder_id`);