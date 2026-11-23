ALTER TABLE `meeting_summaries` ADD `mind_map_edited` json;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_edited_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_revision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_summaries` ADD `mind_map_style` varchar(16);