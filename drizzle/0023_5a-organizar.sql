ALTER TABLE `meetings` ADD `etiquetas` json;--> statement-breakpoint
ALTER TABLE `meetings` ADD `onde_foi` varchar(120);--> statement-breakpoint
CREATE INDEX `meetings_owner_context_idx` ON `meetings` (`owner_id`,`context_id`);