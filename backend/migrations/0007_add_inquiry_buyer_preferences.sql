-- =====================================================================
-- Phase 40B — adds the buyer-preference fields the redesigned
-- percentage-based matching engine needs (see routes/inquiries.ts's
-- GET /inquiries/:inquiryId/matches). All four columns are additive and
-- nullable: every existing inquiry row gets NULL for each (SQLite's
-- implicit default for a newly added nullable column with no explicit
-- DEFAULT) — no data is invented, no existing row is touched or
-- invalidated, and no backfill is performed. A NULL value for any of
-- these means "no preference stated", which the matching engine treats
-- as "exclude this dimension from scoring", never as a failed match.
--
-- Deliberately NOT adding a seller-side price or area *range* — the
-- approved design keeps the seller side as-is (properties.price,
-- properties.area/area_unit, already existing, unchanged by this
-- migration).
--
-- min_budget_minor_units mirrors the existing max_budget_minor_units
-- column exactly (same INTEGER-minor-units convention, same >=0 CHECK
-- shape).
--
-- desired_property_type is plain nullable TEXT, deliberately NOT an
-- enum — properties.property_type itself remains free text (no CHECK
-- constraint), and this column must stay comparable to it without
-- introducing a new controlled-vocabulary requirement on either side.
--
-- desired_min_area is plain nullable REAL, mirroring properties.area's
-- own CHECK shape.
--
-- desired_area_unit reuses the *exact* six-value enum
-- properties.area_unit already uses (SQ_FT/SQ_YD/SQ_M/ACRE/GUNTHA/
-- HECTARE) — no new unit is introduced, and no new enum is invented.
-- =====================================================================

ALTER TABLE inquiries ADD COLUMN min_budget_minor_units INTEGER CHECK (min_budget_minor_units IS NULL OR min_budget_minor_units >= 0);
ALTER TABLE inquiries ADD COLUMN desired_property_type TEXT;
ALTER TABLE inquiries ADD COLUMN desired_min_area REAL CHECK (desired_min_area IS NULL OR desired_min_area >= 0);
ALTER TABLE inquiries ADD COLUMN desired_area_unit TEXT CHECK (desired_area_unit IS NULL OR desired_area_unit IN ('SQ_FT','SQ_YD','SQ_M','ACRE','GUNTHA','HECTARE'));
