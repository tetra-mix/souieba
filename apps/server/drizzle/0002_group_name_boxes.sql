CREATE TABLE `group_name_boxes` (
	`group_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`box` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`group_id`, `agent_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `groups` ADD `name_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `invites` ADD `name_box` text;