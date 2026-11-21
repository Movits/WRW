ALTER TABLE `meeting_summaries` ADD `suggested_title` varchar(200);--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `suggested_title_status` varchar(12);--> statement-breakpoint
ALTER TABLE `meetings` ADD `etiquetas` json;--> statement-breakpoint
ALTER TABLE `meetings` ADD `onde_foi` varchar(120);--> statement-breakpoint
CREATE INDEX `meetings_owner_context_idx` ON `meetings` (`owner_id`,`context_id`);