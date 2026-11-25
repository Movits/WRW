ALTER TABLE `meetings` ADD `share_token` varchar(64);--> statement-breakpoint
ALTER TABLE `meetings` ADD CONSTRAINT `meetings_share_token_unique` UNIQUE(`share_token`);