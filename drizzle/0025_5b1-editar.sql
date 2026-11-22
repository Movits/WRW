ALTER TABLE `meeting_transcripts` ADD `original_transcript` mediumtext;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `original_segments` json;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `edited_at` bigint;--> statement-breakpoint
ALTER TABLE `meeting_transcripts` ADD `revision` int DEFAULT 0 NOT NULL;