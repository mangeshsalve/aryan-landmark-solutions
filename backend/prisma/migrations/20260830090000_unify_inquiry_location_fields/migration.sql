-- Unify Inquiry location fields for BUYER and SELLER (this phase).
--
-- Previously: inquiries.preferred_city/preferred_pincode were BUYER-only
-- (always NULL on a SELLER row) — a SELLER's location lived entirely on
-- the linked property, reached via property_id. Now: inquiries.city/
-- state/pincode/locality are used by BOTH types. For BUYER, this is a
-- rename with the existing values preserved exactly. For SELLER, this
-- requires a genuine backfill — SELLER rows have never had these columns
-- populated before, so without backfilling every existing SELLER inquiry
-- would immediately fail the new pincode-mandatory matching gate.
--
-- Renames are metadata-only in Postgres (no table rewrite, no data risk),
-- unlike a naive `prisma migrate diff`, which would likely propose a
-- destructive DROP+ADD instead — same reasoning as the SQ_YD/SQ_M and
-- inquiry_type migrations before this one.

ALTER TABLE "inquiries" RENAME COLUMN "preferred_city" TO "city";
ALTER TABLE "inquiries" RENAME COLUMN "preferred_pincode" TO "pincode";
ALTER TABLE "inquiries" ADD COLUMN "state" VARCHAR(100);
ALTER TABLE "inquiries" ADD COLUMN "locality" VARCHAR(150);

-- Backfill: every existing SELLER inquiry gets its location snapshot from
-- its currently-linked property. Only `locality` (never `address`) feeds
-- inquiries.locality, per this phase's explicit decision — a property
-- with no locality set leaves the inquiry's locality NULL rather than
-- falling back to the noisier free-text address field. Lightweight SELLER
-- inquiries with no property_id are untouched (all four columns stay
-- NULL, same as before).
UPDATE "inquiries" i
SET "city" = p."city",
    "state" = p."state",
    "pincode" = p."pincode",
    "locality" = p."locality"
FROM "properties" p
WHERE i."property_id" = p."id"
  AND i."type" = 'SELLER';

-- Pincode is now the mandatory matching gate for both directions (was
-- city, reached via a join through properties, for the SELLER side) —
-- indexed directly since it's a plain inquiries column now.
CREATE INDEX "idx_inquiries_type_pincode" ON "inquiries" ("type", "pincode");
