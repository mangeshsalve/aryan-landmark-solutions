-- Phase 16A — Follow-up management.
--
-- Adds a new `follow_ups` table (7th table — explicitly authorized by
-- this phase; see CLAUDE.md's "exactly 6 tables" constraint and its
-- carve-out for an unambiguous instruction to add one). Purely additive:
-- no existing table is altered, no existing column is dropped, no
-- existing row is touched.
--
-- One inquiry has many follow-ups (inquiry_id NOT NULL — a follow-up is
-- only ever created against an inquiry that already exists, unlike
-- attachments there is no ownerless/lightweight case here).

CREATE TYPE "follow_up_status" AS ENUM ('PENDING', 'COMPLETED');

CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inquiry_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "follow_up_status" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "reminder_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_follow_ups_inquiry" ON "follow_ups"("inquiry_id");

CREATE INDEX "idx_follow_ups_scheduled" ON "follow_ups"("scheduled_at");

-- Same cascade behavior as attachments.inquiry_id / inquiry_assignments.inquiry_id.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same actor-tracking pattern as inquiries.created_by / inquiry_assignments.created_by.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same actor-tracking pattern as inquiries.updated_by.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
