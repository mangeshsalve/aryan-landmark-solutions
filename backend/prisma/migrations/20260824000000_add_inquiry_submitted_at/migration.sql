-- This is the first migration ever created for this project: every prior
-- phase's schema (the other 5 tables, and every inquiries column besides
-- submitted_at) was applied directly from docs/database/schema.sql rather
-- than through `prisma migrate` (see CLAUDE.md's "Environment note" — the
-- Prisma engine binaries were previously network-blocked in this sandbox).
-- This migration therefore assumes a database already provisioned from
-- schema.sql and only adds the one new column below; it does not attempt
-- to retroactively create a baseline migration for the other 5 tables.
--
-- Safe for an existing database with inquiries rows: ADD COLUMN with no
-- NOT NULL / no DEFAULT means every existing row gets submitted_at = NULL
-- ("not yet submitted") automatically. No column is renamed or dropped,
-- and no other table is touched.

-- AlterTable
ALTER TABLE "inquiries" ADD COLUMN     "submitted_at" TIMESTAMPTZ(6);
