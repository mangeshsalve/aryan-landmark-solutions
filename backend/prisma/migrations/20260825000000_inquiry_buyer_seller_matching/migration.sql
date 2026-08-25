-- Phase 11 — Buyer/Seller matching foundation.
--
-- IMPORTANT: `npx prisma migrate diff` naively generates DROP COLUMN
-- "type" + ADD COLUMN "type" for this change (converting a String? column
-- to an enum-backed one), which would silently discard every existing
-- inquiry's `type` value. This hand-written migration instead normalizes
-- the existing free-text values and converts the column in place with a
-- USING cast, so no data is lost.
--
-- Inspected inquiries.type in the actual project database before writing
-- this: only two distinct values existed across all rows, 'Sell' and
-- 'SELL' (inconsistent casing, no 'Buy'/'BUYER' rows yet). Both are
-- normalized to 'SELLER' below. 'Buy'/'BUYER' variants are handled
-- defensively even though none currently exist, for any other
-- environment. Any other unrecognized value is set to NULL (preserved as
-- "unclassified") rather than guessed at.

-- Step 1: normalize existing free-text values while the column is still
-- varchar, before the type conversion below.
UPDATE "inquiries" SET "type" = 'SELLER' WHERE "type" IS NOT NULL AND lower(trim("type")) IN ('sell', 'seller');
UPDATE "inquiries" SET "type" = 'BUYER'  WHERE "type" IS NOT NULL AND lower(trim("type")) IN ('buy', 'buyer');
UPDATE "inquiries" SET "type" = NULL     WHERE "type" IS NOT NULL AND "type" NOT IN ('SELLER', 'BUYER');

-- Step 2: create the enum type.
CREATE TYPE "inquiry_type" AS ENUM ('BUYER', 'SELLER');

-- Step 3: convert the column in place (data-preserving — every remaining
-- non-NULL value at this point is already an exact enum label).
ALTER TABLE "inquiries" ALTER COLUMN "type" TYPE "inquiry_type" USING ("type"::text::"inquiry_type");

-- Step 4: additive, nullable buyer-matching fields — safe for existing
-- rows (all NULL until a client sets them).
ALTER TABLE "inquiries" ADD COLUMN "preferred_city" VARCHAR(100);
ALTER TABLE "inquiries" ADD COLUMN "preferred_pincode" VARCHAR(10);
ALTER TABLE "inquiries" ADD COLUMN "max_budget" DECIMAL(18,2);

-- Step 5: index justified by the matching query's WHERE type = 'BUYER'
-- filter (InquiriesService.findMatches).
CREATE INDEX "idx_inquiries_type" ON "inquiries"("type");
