-- Safe for an existing database with properties rows: NOT NULL DEFAULT
-- false means every existing row backfills to is_public = false
-- automatically (i.e. no existing property becomes publicly visible as a
-- side effect of this migration). No column is renamed or dropped, and no
-- other table is touched.
--
-- This is distinct from inquiries.is_public — see database-design.md's
-- "properties" section for why the two flags are not interchangeable.

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "idx_properties_public" ON "properties"("is_public");
