ALTER TABLE "providers" ADD COLUMN "codex_client_spoofing" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "claude_client_spoofing" boolean DEFAULT false;