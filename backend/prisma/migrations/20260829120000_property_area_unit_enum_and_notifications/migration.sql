-- Property area_unit: free-text -> controlled enum.
--
-- IMPORTANT: `prisma migrate diff` would naively propose an ALTER COLUMN
-- straight to the new enum type, which fails outright against real data —
-- existing rows hold inconsistent free-text spellings ('SQ.FT', 'sq.ft',
-- 'SQ FT', all meaning the same thing). This hand-written migration
-- normalizes those values first, while the column is still text, then
-- converts it in place with a USING cast — same technique as the Phase 11
-- inquiries.type migration. No row's semantic value changes, no data is
-- lost: every current row normalizes to a real, correct enum value.
--
-- Inspected the actual project database before writing this: the only
-- values that exist today are 'SQ.FT' (x2), 'sq.ft', and 'SQ FT' — all
-- normalize to SQ_FT below. ACRE/GUNTHA/HECTARE normalization is included
-- defensively for any other environment's data, even though no such value
-- currently exists here. Anything unrecognized normalizes to NULL
-- (preserved as "unset", never guessed at) rather than blocking the
-- migration.

UPDATE "properties"
SET "area_unit" = 'SQ_FT'
WHERE "area_unit" IS NOT NULL
  AND regexp_replace(lower(trim("area_unit")), '[^a-z]', '', 'g') IN ('sqft', 'sqfeet', 'squarefeet', 'squarefoot');

UPDATE "properties"
SET "area_unit" = 'ACRE'
WHERE "area_unit" IS NOT NULL
  AND regexp_replace(lower(trim("area_unit")), '[^a-z]', '', 'g') IN ('acre', 'acres');

UPDATE "properties"
SET "area_unit" = 'GUNTHA'
WHERE "area_unit" IS NOT NULL
  AND regexp_replace(lower(trim("area_unit")), '[^a-z]', '', 'g') IN ('guntha', 'gunthas');

UPDATE "properties"
SET "area_unit" = 'HECTARE'
WHERE "area_unit" IS NOT NULL
  AND regexp_replace(lower(trim("area_unit")), '[^a-z]', '', 'g') IN ('hectare', 'hectares', 'ha');

UPDATE "properties"
SET "area_unit" = NULL
WHERE "area_unit" IS NOT NULL
  AND "area_unit" NOT IN ('SQ_FT', 'ACRE', 'GUNTHA', 'HECTARE');

CREATE TYPE "property_area_unit" AS ENUM ('SQ_FT', 'ACRE', 'GUNTHA', 'HECTARE');

ALTER TABLE "properties"
  ALTER COLUMN "area_unit" TYPE "property_area_unit"
  USING ("area_unit"::text::"property_area_unit");

-- notifications — new table (in-app notifications, starting with
-- ADMIN-initiated inquiry assignment). Purely additive: no existing
-- table/column is touched.

CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "entity_type" VARCHAR(100),
    "entity_id" UUID,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_notifications_user" ON "notifications"("user_id", "is_read", "created_at" DESC);

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
