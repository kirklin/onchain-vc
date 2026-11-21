CREATE TABLE "chain_events" (
	"chain_id" integer NOT NULL,
	"contract" text NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"transaction_hash" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"deal_id" numeric(78, 0),
	"account" text,
	"args" jsonb NOT NULL,
	CONSTRAINT "chain_events_chain_id_block_number_log_index_pk" PRIMARY KEY("chain_id","block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"chain_id" integer NOT NULL,
	"source" text NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	CONSTRAINT "indexer_cursors_chain_id_source_pk" PRIMARY KEY("chain_id","source")
);
--> statement-breakpoint
CREATE TABLE "meeting_notes" (
	"chain_id" integer NOT NULL,
	"deal_id" integer NOT NULL,
	"round" integer NOT NULL,
	"phase" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"in_favour" boolean,
	"score" integer,
	"tools" jsonb NOT NULL,
	"terms" jsonb,
	"cid" text,
	"transaction_hash" text,
	"confirm_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_notes_chain_id_deal_id_round_phase_role_pk" PRIMARY KEY("chain_id","deal_id","round","phase","role")
);
--> statement-breakpoint
CREATE INDEX "chain_events_chain_id_deal_id_block_number_log_index_index" ON "chain_events" USING btree ("chain_id","deal_id","block_number","log_index");--> statement-breakpoint
CREATE INDEX "chain_events_chain_id_name_block_number_index" ON "chain_events" USING btree ("chain_id","name","block_number");--> statement-breakpoint
CREATE INDEX "chain_events_chain_id_account_index" ON "chain_events" USING btree ("chain_id","account");