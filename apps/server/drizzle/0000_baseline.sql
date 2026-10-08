CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text,
	`public_key` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`enc_key` text,
	`sign_key` text,
	`cert` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credentials_kind_check" CHECK("credentials"."kind" IN ('user','agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_token_hash_unique` ON `credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`post_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`received_at` text NOT NULL,
	`received_by_agent_id` text NOT NULL,
	`reserved_by_agent_id` text,
	`reserved_until` text,
	`told_at` text,
	`told_by_agent_id` text,
	`dismissed_at` text,
	PRIMARY KEY(`post_id`, `recipient_user_id`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_recipient` ON `deliveries` (`recipient_user_id`,`told_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text,
	`invite_code` text,
	`invite_sig` text,
	`join_sig` text,
	`joined_at` text NOT NULL,
	`left_at` text,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_members_role_check" CHECK("group_members"."role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE INDEX `group_members_user` ON `group_members` (`user_id`,`left_at`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`create_sig` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `instance_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_by` text,
	`target_user_id` text,
	`auto_friend` integer DEFAULT 1 NOT NULL,
	`expires_at` text NOT NULL,
	`used_by` text,
	`used_at` text,
	`created_at` text NOT NULL,
	`group_id` text,
	`invite_commit` text,
	`invite_sig` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invites_kind_check" CHECK("invites"."kind" IN ('invite','login'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_hash_unique` ON `invites` (`code_hash`);--> statement-breakpoint
CREATE TABLE `post_recipients` (
	`post_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`post_id`, `agent_id`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_recipients_agent` ON `post_recipients` (`agent_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`author_agent_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`visibility` text NOT NULL,
	`envelope` text NOT NULL,
	`visible_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "posts_visibility_check" CHECK("posts"."visibility" IN ('groups','private'))
);
--> statement-breakpoint
CREATE INDEX `posts_owner_created` ON `posts` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `posts_author_period` ON `posts` (`author_agent_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`disabled_at` text,
	`created_at` text NOT NULL,
	`identity_key` text,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('admin','member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);