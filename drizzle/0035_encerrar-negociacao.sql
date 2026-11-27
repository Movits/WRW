CREATE TABLE `deal_closures` (
	`id` int AUTO_INCREMENT NOT NULL,
	`roomId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`closedByUserId` int NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'BRL',
	`dealValue` decimal(14,2) NOT NULL,
	`intermediationFee` decimal(14,2) NOT NULL,
	`commissionPercent` decimal(5,2) NOT NULL,
	`commissionAmount` decimal(14,2) NOT NULL,
	`notes` text,
	`closedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deal_closures_id` PRIMARY KEY(`id`),
	CONSTRAINT `deal_closure_room_unique` UNIQUE(`roomId`)
);
--> statement-breakpoint
ALTER TABLE `platform_notifications` MODIFY COLUMN `type` enum('new_match','interest_received','gold_granted','gold_revoked','opportunity_approved','opportunity_rejected','new_message','compliance_update','system','lembrete','reuniao_pronta','deal_closed') NOT NULL;--> statement-breakpoint
CREATE INDEX `deal_closure_opportunity_idx` ON `deal_closures` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `deal_closure_closed_by_idx` ON `deal_closures` (`closedByUserId`);