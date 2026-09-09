-- =====================================================================
-- Phase 26 — adds an explicit, nullable ACTUAL-OWNER relationship on
-- properties, referencing the real CUSTOMER who owns the property.
--
-- Deliberately NOT `created_by` (the staff member who entered the
-- listing — a different concept entirely) and NOT inferred from any
-- SELLER inquiry (fragile: not guaranteed to exist, not guaranteed
-- unique) — see the Phase 21/26 discovery reports for why both of those
-- were explicitly rejected. This is a genuinely new, independently-set
-- relationship: unassigned unless a staff member explicitly picks a
-- customer as the owner via the property create/edit form.
--
-- `owner_customer_id` is TEXT, not INTEGER: every id in this schema —
-- including `users.id`, the column this one references — is a
-- crypto.randomUUID()-generated TEXT UUID (see 0001_initial_schema.sql's
-- `users` table and every other `*_id` foreign key in this file for the
-- same pattern, e.g. `inquiries.customer_id`). An INTEGER column could
-- never hold a valid reference to it.
--
-- No CHECK constraint ties this to `user_type = 'CUSTOMER'` — SQLite/D1
-- CHECK constraints cannot perform cross-table lookups, and this project
-- has never used one for that purpose (see `inquiries.customer_id`,
-- which has the identical "must reference a CUSTOMER" rule enforced
-- only in the application layer, not the schema). The Worker route
-- enforces the CUSTOMER-only rule at write time instead, matching that
-- existing precedent.
--
-- Existing properties get `owner_customer_id = NULL` (SQLite's implicit
-- default for a newly added nullable column with no explicit DEFAULT) —
-- no data is invented, no existing row is touched or invalidated.
-- =====================================================================

ALTER TABLE properties ADD COLUMN owner_customer_id TEXT REFERENCES users(id);

CREATE INDEX idx_properties_owner ON properties (owner_customer_id);
