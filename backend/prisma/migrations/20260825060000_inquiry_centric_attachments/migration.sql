-- Phase 13B — Inquiry-centric attachments.
--
-- Client-confirmed workflow: an ADMIN taking a call has no time to find or
-- create Customer/Property master records first. The Inquiry itself is now
-- the initial lead container, and its recording/photos/documents must be
-- attachable before any customer/property exists.
--
-- Two schema changes, both purely additive/relaxing — no existing row is
-- modified, no column or table is dropped, no data is at risk:
--
--  1. inquiries.customer_id: NOT NULL -> nullable. Every existing inquiry
--     already has a customer_id, so this is a pure constraint relaxation;
--     no UPDATE is needed. The FK (inquiries_customer_id_fkey) is
--     untouched — a nullable FK column still enforces referential
--     integrity for any non-NULL value.
--
--  2. chk_attachment_relationship: PHOTO/DOCUMENT previously required
--     property_id IS NOT NULL unconditionally. Replaced with
--     property_id IS NOT NULL OR inquiry_id IS NOT NULL, so a PHOTO/
--     DOCUMENT captured during the initial call can reference the inquiry
--     instead of a property that doesn't exist yet. RECORDING is
--     unchanged (inquiry_id required). Every existing PHOTO/DOCUMENT row
--     already satisfies the new, weaker condition (it has property_id
--     set), so no existing row can violate it.

ALTER TABLE "inquiries" ALTER COLUMN "customer_id" DROP NOT NULL;

ALTER TABLE "attachments" DROP CONSTRAINT "chk_attachment_relationship";

ALTER TABLE "attachments" ADD CONSTRAINT "chk_attachment_relationship" CHECK (
    ("attachment_type" = 'PHOTO' AND ("property_id" IS NOT NULL OR "inquiry_id" IS NOT NULL))
    OR
    ("attachment_type" = 'DOCUMENT' AND ("property_id" IS NOT NULL OR "inquiry_id" IS NOT NULL))
    OR
    ("attachment_type" = 'RECORDING' AND "inquiry_id" IS NOT NULL)
);
