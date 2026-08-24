-- Baseline migration — represents the schema every environment of this
-- project actually started from (docs/database/schema.sql), captured as a
-- real Prisma migration for the first time.
--
-- Why this exists: Phases 1-8.1 (see CLAUDE.md's "Environment note") set
-- up the original 6 tables by applying docs/database/schema.sql directly
-- against Postgres — the Prisma engine binaries were network-blocked in
-- that sandbox, so no `prisma migrate` ever ran. Only the two later
-- additive columns (submitted_at, properties.is_public) exist as real
-- Prisma migrations. Without this file, `prisma migrate deploy` against a
-- brand-new empty database would try to run those two ALTER TABLE
-- migrations against tables that don't exist yet, and fail immediately.
--
-- This file's CREATE TABLE/INDEX/FOREIGN KEY statements were generated
-- from prisma/schema.prisma via `prisma migrate diff --from-empty`, then
-- hand-augmented with the pgcrypto extension, gen_random_uuid() id
-- defaults, and the four CHECK constraints + two partial/expression
-- unique indexes that schema.sql defines but Prisma's schema DSL cannot
-- express (chk_users_identity, uq_users_email, the properties numeric/
-- coordinate CHECKs, chk_attachment_relationship,
-- chk_attachment_document_type, chk_attachment_size,
-- uq_property_primary_photo) — see CLAUDE.md's "Environment note" for
-- why these have only ever lived in application-layer validation until
-- now. A fresh database that runs this migration gets the exact same
-- database-level guarantees as schema.sql, not a weaker subset.
--
-- DEPLOYMENT NOTE — READ BEFORE RUNNING AGAINST ANY EXISTING DATABASE:
-- Any database that was set up by directly applying docs/database/
-- schema.sql (i.e. every environment this project has used so far)
-- ALREADY HAS these tables. Running this migration.sql against such a
-- database as a normal migration would fail on the first
-- `CREATE TABLE "users"` (already exists) or worse, if run partially,
-- leave duplicate objects. For those databases, this migration must be
-- marked as already applied WITHOUT executing it:
--
--   npx prisma migrate resolve --applied 20260101000000_baseline_initial_schema
--
-- Only after that should `prisma migrate deploy` be run, which will then
-- correctly apply just the two already-existing incremental migrations
-- (add_inquiry_submitted_at, add_property_is_public) if they haven't been
-- applied yet, or no-op if they have. This resolve step is NOT run by
-- this change — it must be run once, deliberately, by whoever operates
-- each existing environment. See README.md's deployment section.
--
-- A genuinely brand-new empty database needs no such step: running
-- `prisma migrate deploy` applies this baseline for real, then the two
-- incremental migrations, in order, reaching the exact current schema.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "user_type" AS ENUM ('APPLICATION_USER', 'CUSTOMER', 'MASTER');

-- CreateEnum
CREATE TYPE "application_role" AS ENUM ('ADMIN', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "property_category" AS ENUM ('RESIDENTIAL', 'INDUSTRIAL', 'COMMERCIAL', 'AGRICULTURAL');

-- CreateEnum
CREATE TYPE "property_status" AS ENUM ('AVAILABLE', 'SOLD', 'ON_HOLD', 'INACTIVE');

-- CreateEnum
CREATE TYPE "attachment_type" AS ENUM ('PHOTO', 'DOCUMENT', 'RECORDING');

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('SEVEN_TWELVE', 'SALE_DEED', 'PROPERTY_CARD', 'NOC', 'OTHER');

-- CreateEnum
CREATE TYPE "inquiry_status" AS ENUM ('NEW', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "inquiry_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" VARCHAR(50),
    "user_type" "user_type" NOT NULL,
    "role" "application_role",
    "name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(255),
    "mobile" VARCHAR(20),
    "alternate_mobile" VARCHAR(20),
    "address" TEXT,
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "password_hash" TEXT,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_users_identity" CHECK (
        ("user_type" = 'APPLICATION_USER' AND "user_id" IS NOT NULL AND "password_hash" IS NOT NULL AND "role" IS NOT NULL)
        OR
        ("user_type" = 'CUSTOMER' AND "user_id" IS NULL AND "password_hash" IS NULL AND "role" IS NULL)
        OR
        ("user_type" = 'MASTER' AND "user_id" IS NOT NULL AND "password_hash" IS NOT NULL AND "role" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_code" VARCHAR(50) NOT NULL,
    "property_type" VARCHAR(50) NOT NULL,
    "category" "property_category" NOT NULL,
    "area" DECIMAL(14,2),
    "area_unit" VARCHAR(20),
    "price" DECIMAL(18,2),
    "price_unit" VARCHAR(20),
    "gat_no_details" VARCHAR(255),
    "description" TEXT,
    "address" TEXT,
    "locality" VARCHAR(150),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "map_url" TEXT,
    "status" "property_status" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "properties_area_check" CHECK ("area" IS NULL OR "area" >= 0),
    CONSTRAINT "properties_price_check" CHECK ("price" IS NULL OR "price" >= 0),
    CONSTRAINT "properties_latitude_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
    CONSTRAINT "properties_longitude_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inquiry_number" VARCHAR(50) NOT NULL,
    "customer_id" UUID NOT NULL,
    "property_id" UUID,
    "type" VARCHAR(50),
    "priority" "inquiry_priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "inquiry_status" NOT NULL DEFAULT 'NEW',
    "external_reference" VARCHAR(255),
    "handled_by_user_id" UUID,
    "assigned_to_user_id" UUID,
    "remarks" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID,
    "inquiry_id" UUID,
    "attachment_type" "attachment_type" NOT NULL,
    "document_type" "document_type",
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(150) NOT NULL,
    "file_size_bytes" BIGINT,
    "r2_bucket" VARCHAR(255) NOT NULL,
    "r2_object_key" VARCHAR(1024) NOT NULL,
    "file_url" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_attachment_relationship" CHECK (
        ("attachment_type" = 'PHOTO' AND "property_id" IS NOT NULL)
        OR
        ("attachment_type" = 'DOCUMENT' AND "property_id" IS NOT NULL)
        OR
        ("attachment_type" = 'RECORDING' AND "inquiry_id" IS NOT NULL)
    ),
    CONSTRAINT "chk_attachment_document_type" CHECK (
        ("attachment_type" = 'DOCUMENT' AND "document_type" IS NOT NULL)
        OR
        ("attachment_type" IN ('PHOTO', 'RECORDING') AND "document_type" IS NULL)
    ),
    CONSTRAINT "chk_attachment_size" CHECK ("file_size_bytes" IS NULL OR "file_size_bytes" >= 0)
);

-- CreateTable
CREATE TABLE "inquiry_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inquiry_id" UUID NOT NULL,
    "assigned_from_user_id" UUID,
    "assigned_to_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "created_by" UUID NOT NULL,

    CONSTRAINT "inquiry_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_user_id_key" ON "users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_email" ON "users"(lower("email")) WHERE "email" IS NOT NULL;

-- CreateIndex
CREATE INDEX "idx_users_mobile" ON "users"("mobile");

-- CreateIndex
CREATE INDEX "idx_users_type_status" ON "users"("user_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "properties_property_code_key" ON "properties"("property_code");

-- CreateIndex
CREATE INDEX "idx_properties_status" ON "properties"("status");

-- CreateIndex
CREATE INDEX "idx_properties_city" ON "properties"("city");

-- CreateIndex
CREATE INDEX "idx_properties_category" ON "properties"("category");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_inquiry_number_key" ON "inquiries"("inquiry_number");

-- CreateIndex
CREATE INDEX "idx_inquiries_customer" ON "inquiries"("customer_id");

-- CreateIndex
CREATE INDEX "idx_inquiries_property" ON "inquiries"("property_id");

-- CreateIndex
CREATE INDEX "idx_inquiries_status" ON "inquiries"("status");

-- CreateIndex
CREATE INDEX "idx_inquiries_assigned" ON "inquiries"("assigned_to_user_id");

-- CreateIndex
CREATE INDEX "idx_inquiries_handled" ON "inquiries"("handled_by_user_id");

-- CreateIndex
CREATE INDEX "idx_inquiries_public" ON "inquiries"("is_public");

-- CreateIndex
CREATE INDEX "idx_inquiries_created" ON "inquiries"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_r2_object_key_key" ON "attachments"("r2_object_key");

-- CreateIndex
CREATE INDEX "idx_attachments_property" ON "attachments"("property_id");

-- CreateIndex
CREATE INDEX "idx_attachments_inquiry" ON "attachments"("inquiry_id");

-- CreateIndex
CREATE INDEX "idx_attachments_type" ON "attachments"("attachment_type");

-- CreateIndex
CREATE INDEX "idx_attachments_inquiry_type" ON "attachments"("inquiry_id", "attachment_type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_property_primary_photo" ON "attachments"("property_id") WHERE "attachment_type" = 'PHOTO' AND "is_primary" = TRUE;

-- CreateIndex
CREATE INDEX "idx_inquiry_assignments_inquiry" ON "inquiry_assignments"("inquiry_id", "assigned_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_entity" ON "audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_user" ON "audit_logs"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_handled_by_user_id_fkey" FOREIGN KEY ("handled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_assigned_from_user_id_fkey" FOREIGN KEY ("assigned_from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_assignments" ADD CONSTRAINT "inquiry_assignments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
