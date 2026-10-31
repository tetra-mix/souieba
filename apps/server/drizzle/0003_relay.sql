CREATE TABLE `relay_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`enc_key` text NOT NULL,
	`enc_key_version` integer NOT NULL,
	`enc_key_sig` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_agents_identity_key_unique` ON `relay_agents` (`identity_key`);--> statement-breakpoint
CREATE TABLE `relay_blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `relay_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_challenges_expires` ON `relay_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_connections` (
	`requester_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`requester_id`, `recipient_id`),
	FOREIGN KEY (`requester_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relay_connections_status_check" CHECK("relay_connections"."status" IN ('pending','accepted'))
);
--> statement-breakpoint
CREATE INDEX `relay_connections_recipient` ON `relay_connections` (`recipient_id`,`status`);--> statement-breakpoint
CREATE TABLE `relay_deliveries` (
	`message_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`box` text,
	`delivered_at` text,
	PRIMARY KEY(`message_id`, `recipient_id`),
	FOREIGN KEY (`message_id`) REFERENCES `relay_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_deliveries_recipient` ON `relay_deliveries` (`recipient_id`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `relay_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`body` text,
	`created_at` text NOT NULL,
	`visible_at` text NOT NULL,
	`delivery_expires_at` text NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_messages_sender` ON `relay_messages` (`sender_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `relay_messages_expires` ON `relay_messages` (`delivery_expires_at`);--> statement-breakpoint
CREATE TABLE `relay_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `relay_agents`(`agent_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_sessions_expires` ON `relay_sessions` (`expires_at`);