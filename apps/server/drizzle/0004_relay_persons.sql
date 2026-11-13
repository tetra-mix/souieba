CREATE TABLE `relay_device_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `relay_devices`(`device_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_device_challenges_expires` ON `relay_device_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_device_deliveries` (
	`message_id` text NOT NULL,
	`device_id` text NOT NULL,
	`person_id` text NOT NULL,
	`box` text,
	`delivered_at` text,
	PRIMARY KEY(`message_id`, `device_id`),
	FOREIGN KEY (`message_id`) REFERENCES `relay_person_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_device_deliveries_device` ON `relay_device_deliveries` (`device_id`,`delivered_at`);--> statement-breakpoint
CREATE INDEX `relay_device_deliveries_person` ON `relay_device_deliveries` (`person_id`);--> statement-breakpoint
CREATE TABLE `relay_device_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `relay_devices`(`device_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_device_sessions_expires` ON `relay_device_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`sign_key` text NOT NULL,
	`enc_key_version` integer NOT NULL,
	`cert` text NOT NULL,
	`revocation` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `relay_persons`(`person_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_devices_sign_key_unique` ON `relay_devices` (`sign_key`);--> statement-breakpoint
CREATE INDEX `relay_devices_person` ON `relay_devices` (`person_id`);--> statement-breakpoint
CREATE TABLE `relay_person_blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `relay_persons`(`person_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `relay_person_connections` (
	`requester_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`requester_id`, `recipient_id`),
	FOREIGN KEY (`requester_id`) REFERENCES `relay_persons`(`person_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `relay_persons`(`person_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relay_person_connections_status_check" CHECK("relay_person_connections"."status" IN ('pending','accepted'))
);
--> statement-breakpoint
CREATE INDEX `relay_person_connections_recipient` ON `relay_person_connections` (`recipient_id`,`status`);--> statement-breakpoint
CREATE TABLE `relay_person_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`sender_device` text NOT NULL,
	`body` text,
	`created_at` text NOT NULL,
	`visible_at` text NOT NULL,
	`delivery_expires_at` text NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `relay_persons`(`person_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `relay_person_messages_sender` ON `relay_person_messages` (`sender_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `relay_person_messages_expires` ON `relay_person_messages` (`delivery_expires_at`);--> statement-breakpoint
CREATE TABLE `relay_persons` (
	`person_id` text PRIMARY KEY NOT NULL,
	`person_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_persons_person_key_unique` ON `relay_persons` (`person_key`);