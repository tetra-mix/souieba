ALTER TABLE `agents` DROP COLUMN `cert`;--> statement-breakpoint
ALTER TABLE `group_members` DROP COLUMN `invite_code`;--> statement-breakpoint
ALTER TABLE `group_members` DROP COLUMN `invite_sig`;--> statement-breakpoint
ALTER TABLE `group_members` DROP COLUMN `join_sig`;--> statement-breakpoint
ALTER TABLE `groups` DROP COLUMN `create_sig`;--> statement-breakpoint
ALTER TABLE `invites` DROP COLUMN `invite_commit`;--> statement-breakpoint
ALTER TABLE `invites` DROP COLUMN `invite_sig`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `identity_key`;