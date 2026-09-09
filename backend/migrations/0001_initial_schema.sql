-- =====================================================================
-- Phase 1 — Cloudflare D1 / SQLite schema for the REAL backend.
--
-- Source of truth: backend/prisma/schema.prisma, cross-checked against
-- every migration under backend/prisma/migrations/ (most recent state of
-- each column/constraint wins — e.g. chk_attachment_relationship below
-- reflects the Phase 13B relaxation, not the original baseline text).
--
-- backend-d1-test/migrations/0003_core_schema.sql was consulted only as a
-- reference for patterns already proven to work against real D1 (partial/
-- expression unique indexes, CHECK-based enum enforcement, cascade
-- behavior) — it was NOT copied wholesale. Two deliberate departures from
-- it, explained where they occur below: (1) the users table is named
-- `users` here, matching schema.prisma's `@@map("users")` exactly — the
-- POC's `app_users` rename was a defensive choice with no actual SQLite/
-- D1 restriction behind it; (2) money fields use a differentiated
-- representation, not a blanket REAL conversion — see the Decimal section
-- below.
--
-- This migration is SCHEMA ONLY. No application code reads or writes
-- through it yet (Phase 2+). It has been applied to a fresh, local-only
-- D1 database for validation (see the Phase 1 report) — never to
-- production D1, never to backend-d1-test's database.
-- =====================================================================


-- =====================================================================
-- DECIMAL FIELD DECISIONS (Step 2)
-- =====================================================================
-- schema.prisma declares exactly 5 Decimal fields, across 2 tables:
--   properties.area       Decimal(14,2)
--   properties.price      Decimal(18,2)
--   properties.latitude   Decimal(10,7)
--   properties.longitude  Decimal(10,7)
--   inquiries.max_budget  Decimal(18,2)
--
-- SQLite has no native fixed-point decimal type. Rather than converting
-- all five the same way, each is judged on what it's actually used for:
--
-- price / max_budget — MONEY. Both are compared directly against each
-- other in the matching algorithm's budget check (property.price <=
-- inquiry.max_budget) — see backend/src/inquiries/inquiries.service.ts's
-- findOppositeMatches(). IEEE-754 REAL cannot represent most decimal
-- fractions exactly (e.g. 12345.10 can round-trip as
-- 12345.099999999999), which is an unacceptable risk for a value used in
-- a real financial threshold comparison, and is strictly worse than what
-- Postgres's DECIMAL already guarantees today. Chosen representation:
-- INTEGER, storing whole minor currency units (paise; 1 INR = 100 minor
-- units) — exact, no floating-point error, and both fields use the
-- IDENTICAL unit so the direct comparison between them stays exact too.
-- Columns are renamed with a `_minor_units` suffix specifically so a
-- future reader can never mistake a raw stored value for whole rupees.
-- This is a storage-layer decision only — the JSON API contract is
-- unaffected; Phase 2's route layer is responsible for converting
-- rupees<->minor-units at the request/response boundary, exactly the way
-- the current Prisma-based backend already converts Decimal<->Number at
-- its mapper boundary today.
--
-- area — a physical measurement (with an explicit unit column,
-- area_unit), never compared or thresholded anywhere in the current
-- business logic (confirmed: the matching algorithm uses only pincode/
-- city/locality/budget, never area) — purely stored and displayed.
-- Chosen representation: REAL. The only risk is a cosmetic trailing-digit
-- display artifact, not a business-logic correctness risk, and REAL
-- keeps the column a plain number with no unit-conversion burden on the
-- route layer for a field that's never computed against anything.
--
-- latitude / longitude — geographic coordinates, 7 decimal places
-- (~1.1cm precision). REAL (IEEE-754 double) is the universal, industry-
-- standard representation for GPS coordinates (GeoJSON, every mapping
-- API) and has ~15-17 significant digits of precision — vastly more than
-- the 10 digits (3 integer + 7 fractional) this column ever needs, so
-- there is no realistic precision loss for this specific value range,
-- unlike money's genuine risk from repeating binary fractions.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. users — matches schema.prisma's User model / @@map("users") exactly.
-- Named `users`, not `app_users`: no SQLite or D1 reserved-word/tooling
-- restriction on this name was found, so the authoritative schema's own
-- table name is used as-is rather than introducing an unnecessary rename.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                TEXT PRIMARY KEY,
    user_id           TEXT UNIQUE,
    user_type         TEXT NOT NULL CHECK (user_type IN ('APPLICATION_USER','CUSTOMER','MASTER')),
    role              TEXT CHECK (role IS NULL OR role IN ('ADMIN','EMPLOYEE')),
    name              TEXT NOT NULL,
    email             TEXT UNIQUE,
    mobile            TEXT,
    alternate_mobile  TEXT,
    address           TEXT,
    city              TEXT,
    state             TEXT,
    pincode           TEXT,
    password_hash     TEXT,
    status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
    last_login_at     TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by        TEXT,
    updated_by        TEXT,

    -- Mirrors chk_users_identity (baseline migration) exactly: an
    -- APPLICATION_USER must have user_id+password_hash+role; a CUSTOMER
    -- must have none of the three; a MASTER must have user_id+
    -- password_hash but no role.
    CHECK (
        (user_type = 'APPLICATION_USER' AND user_id IS NOT NULL AND password_hash IS NOT NULL AND role IS NOT NULL)
        OR
        (user_type = 'CUSTOMER' AND user_id IS NULL AND password_hash IS NULL AND role IS NULL)
        OR
        (user_type = 'MASTER' AND user_id IS NOT NULL AND password_hash IS NOT NULL AND role IS NULL)
    ),

    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- Mirrors uq_users_email (baseline): case-insensitive uniqueness,
-- NULL-permissive (multiple NULL emails allowed — CUSTOMER rows commonly
-- have no email). LOWER(email) also serves as the D1-compatible
-- replacement for Prisma's `mode: 'insensitive'` filter used at login.
CREATE UNIQUE INDEX uq_users_email ON users (LOWER(email)) WHERE email IS NOT NULL;
-- users_user_id_key (baseline) — plain UNIQUE, already declared inline above.
CREATE INDEX idx_users_mobile ON users (mobile);
CREATE INDEX idx_users_type_status ON users (user_type, status);


-- ---------------------------------------------------------------------
-- 2. properties
-- ---------------------------------------------------------------------
CREATE TABLE properties (
    id                    TEXT PRIMARY KEY,
    property_code         TEXT NOT NULL UNIQUE,
    property_type         TEXT NOT NULL,
    category              TEXT NOT NULL CHECK (category IN ('RESIDENTIAL','INDUSTRIAL','COMMERCIAL','AGRICULTURAL')),
    area                  REAL CHECK (area IS NULL OR area >= 0),
    -- Current enum list per schema.prisma's PropertyAreaUnit (SQ_YD/SQ_M
    -- already merged in — these were added additively after the baseline).
    area_unit             TEXT CHECK (area_unit IS NULL OR area_unit IN ('SQ_FT','SQ_YD','SQ_M','ACRE','GUNTHA','HECTARE')),
    -- See the Decimal-decision block above: money, stored as exact minor
    -- units (paise), not REAL.
    price_minor_units     INTEGER CHECK (price_minor_units IS NULL OR price_minor_units >= 0),
    price_unit            TEXT,
    gat_no_details        TEXT,
    description           TEXT,
    address                TEXT,
    locality              TEXT,
    city                  TEXT,
    state                 TEXT,
    pincode               TEXT,
    latitude              REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    longitude             REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    map_url               TEXT,
    status                TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','SOLD','ON_HOLD','INACTIVE')),
    -- Nullable boolean in schema.prisma (isPublic Boolean? — no @default),
    -- unlike inquiries.is_public which is NOT NULL DEFAULT false. Kept
    -- exactly as declared, not silently tightened.
    is_public             INTEGER CHECK (is_public IS NULL OR is_public IN (0,1)),
    created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by            TEXT,
    updated_by            TEXT,

    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
);
-- properties_property_code_key (baseline) — plain UNIQUE, declared inline above.
CREATE INDEX idx_properties_status ON properties (status);
CREATE INDEX idx_properties_city ON properties (city);
CREATE INDEX idx_properties_category ON properties (category);


-- ---------------------------------------------------------------------
-- 3. inquiries
-- ---------------------------------------------------------------------
CREATE TABLE inquiries (
    id                     TEXT PRIMARY KEY,
    inquiry_number         TEXT NOT NULL UNIQUE,
    -- Nullable per Phase 13B (see migration.sql read above) — an ADMIN
    -- can create a lightweight, call-driven inquiry before a customer is
    -- identified.
    customer_id            TEXT,
    property_id            TEXT,
    type                   TEXT CHECK (type IS NULL OR type IN ('BUYER','SELLER')),
    priority               TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
    status                 TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED')),
    external_reference     TEXT,
    handled_by_user_id     TEXT,
    assigned_to_user_id    TEXT,
    remarks                TEXT,
    is_public              INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
    -- Unified location fields (BUYER: client-editable; SELLER: synced
    -- from the linked property — see schema.prisma's doc comment on
    -- Inquiry.city). Schema-level, these are just nullable TEXT columns —
    -- the sync rule itself is application logic (Phase 2+), not something
    -- the schema can express or enforce.
    city                   TEXT,
    state                  TEXT,
    pincode                TEXT,
    locality               TEXT,
    -- Money — same _minor_units representation as properties.price_minor_units,
    -- and MUST stay the same unit, since the two are compared directly.
    -- No CHECK >= 0 here: schema.prisma's Decimal(18,2) has no such
    -- constraint at the DB level either (unlike properties.price, which
    -- does) — preserved exactly, not tightened.
    max_budget_minor_units INTEGER,
    submitted_at           TEXT,
    created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by             TEXT NOT NULL,
    updated_by             TEXT,

    FOREIGN KEY (customer_id) REFERENCES users(id),
    -- ON DELETE SET NULL: matches schema.prisma exactly — a property can
    -- be deleted while inquiries still reference it; they simply lose the
    -- link (see PropertiesService.delete()'s own doc comment on this).
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
    FOREIGN KEY (handled_by_user_id) REFERENCES users(id),
    FOREIGN KEY (assigned_to_user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
);
-- inquiries_inquiry_number_key (baseline) — plain UNIQUE, declared inline above.
CREATE INDEX idx_inquiries_customer ON inquiries (customer_id);
CREATE INDEX idx_inquiries_property ON inquiries (property_id);
CREATE INDEX idx_inquiries_status ON inquiries (status);
CREATE INDEX idx_inquiries_assigned ON inquiries (assigned_to_user_id);
CREATE INDEX idx_inquiries_handled ON inquiries (handled_by_user_id);
CREATE INDEX idx_inquiries_public ON inquiries (is_public);
CREATE INDEX idx_inquiries_created ON inquiries (created_at DESC);
CREATE INDEX idx_inquiries_type ON inquiries (type);
-- Mandatory matching gate (pincode) — see location-match.util.ts.
CREATE INDEX idx_inquiries_type_pincode ON inquiries (type, pincode);


-- ---------------------------------------------------------------------
-- 4. attachments — unified PHOTO / DOCUMENT / RECORDING metadata.
-- ---------------------------------------------------------------------
CREATE TABLE attachments (
    id                  TEXT PRIMARY KEY,
    property_id         TEXT,
    inquiry_id          TEXT,
    attachment_type     TEXT NOT NULL CHECK (attachment_type IN ('PHOTO','DOCUMENT','RECORDING')),
    document_type       TEXT CHECK (document_type IS NULL OR document_type IN ('SEVEN_TWELVE','SALE_DEED','PROPERTY_CARD','NOC','OTHER')),
    file_name           TEXT NOT NULL,
    mime_type           TEXT NOT NULL,
    file_size_bytes     INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    r2_bucket           TEXT NOT NULL,
    r2_object_key       TEXT NOT NULL UNIQUE,
    file_url            TEXT,
    is_primary          INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    display_order       INTEGER NOT NULL DEFAULT 0,
    uploaded_by         TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Current (Phase 13B) chk_attachment_relationship, verified against
    -- the actual migration SQL, not the baseline: PHOTO/DOCUMENT require
    -- property_id OR inquiry_id (the "not both" rule is enforced at the
    -- application layer, per AttachmentsService.validateRelationshipAndResource
    -- — the DB-level constraint was never that strict, preserved exactly
    -- as it actually is today, not tightened).
    CHECK (
        (attachment_type = 'PHOTO' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
        OR
        (attachment_type = 'DOCUMENT' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
        OR
        (attachment_type = 'RECORDING' AND inquiry_id IS NOT NULL)
    ),
    -- chk_attachment_document_type (baseline, unchanged by any later migration).
    CHECK (
        (attachment_type = 'DOCUMENT' AND document_type IS NOT NULL)
        OR
        (attachment_type != 'DOCUMENT' AND document_type IS NULL)
    ),
    -- chk_attachment_size (baseline).
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),

    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
-- attachments_r2_object_key_key (baseline) — plain UNIQUE, declared inline above.
CREATE INDEX idx_attachments_property ON attachments (property_id);
CREATE INDEX idx_attachments_inquiry ON attachments (inquiry_id);
CREATE INDEX idx_attachments_type ON attachments (attachment_type);
CREATE INDEX idx_attachments_inquiry_type ON attachments (inquiry_id, attachment_type);
-- uq_property_primary_photo (baseline) — partial unique index: at most
-- one PHOTO with is_primary=1 per property. Deliberately scoped to
-- property_id only (matches the baseline exactly) — it does not also
-- constrain "one primary photo per inquiry_id", since the original never
-- did either.
CREATE UNIQUE INDEX uq_property_primary_photo ON attachments (property_id) WHERE attachment_type = 'PHOTO' AND is_primary = 1;


-- ---------------------------------------------------------------------
-- 5. inquiry_assignments — append-only assignment/reassignment history.
-- ---------------------------------------------------------------------
CREATE TABLE inquiry_assignments (
    id                     TEXT PRIMARY KEY,
    inquiry_id             TEXT NOT NULL,
    assigned_from_user_id  TEXT,
    assigned_to_user_id    TEXT NOT NULL,
    assigned_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason                 TEXT,
    created_by             TEXT NOT NULL,

    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_from_user_id) REFERENCES users(id),
    FOREIGN KEY (assigned_to_user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX idx_inquiry_assignments_inquiry ON inquiry_assignments (inquiry_id, assigned_at DESC);


-- ---------------------------------------------------------------------
-- 6. follow_ups
-- ---------------------------------------------------------------------
CREATE TABLE follow_ups (
    id                TEXT PRIMARY KEY,
    inquiry_id        TEXT NOT NULL,
    scheduled_at      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
    notes             TEXT,
    reminder_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (reminder_enabled IN (0,1)),
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by        TEXT NOT NULL,
    updated_by        TEXT,

    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
);
CREATE INDEX idx_follow_ups_inquiry ON follow_ups (inquiry_id);
CREATE INDEX idx_follow_ups_scheduled ON follow_ups (scheduled_at);


-- ---------------------------------------------------------------------
-- 7. notifications
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    entity_type  TEXT,
    entity_id    TEXT,
    is_read      INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
    read_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_notifications_user ON notifications (user_id, is_read, created_at DESC);


-- ---------------------------------------------------------------------
-- 8. audit_logs
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    id           TEXT PRIMARY KEY,
    user_id      TEXT,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT,
    action       TEXT NOT NULL,
    -- Json? in schema.prisma -> TEXT (JSON.stringify'd at the application
    -- layer in Phase 2+). Never queried by content anywhere in the
    -- current codebase, confirmed by a full-repository search this
    -- session, so this loses no functionality actually in use.
    old_values   TEXT,
    new_values   TEXT,
    ip_address   TEXT,
    user_agent   TEXT,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- No ON DELETE clause, matching schema.prisma exactly (the User
    -- relation on AuditLog has no onDelete specified) — SQLite/D1's
    -- default (NO ACTION) means a user with audit history cannot be
    -- hard-deleted while referenced, the same practical effect as
    -- Postgres's default here.
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs (user_id, created_at DESC);
