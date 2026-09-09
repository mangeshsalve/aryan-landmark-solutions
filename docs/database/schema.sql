-- Aryan Landmark Solutions
-- POSTGRESQL REFERENCE SCHEMA
-- Executable source of truth: prisma/schema.prisma
--
-- NOTE: this file does not yet include the follow_ups table (added
-- Phase 16A) — a pre-existing documentation gap from before this phase,
-- not introduced here. notifications (this phase) is included below.
--
-- Phase 38D added one nullable column to the real (D1) follow_ups
-- table, `reminder_sent_at TEXT DEFAULT NULL` — see
-- backend/migrations/0003_add_follow_up_reminder_sent_at.sql and
-- docs/database/database-design.md's "Notifications" section. Not
-- reflected in a CREATE TABLE block here, consistent with follow_ups'
-- pre-existing absence from this file noted above.
--
-- IMPORTANT (Phase 9C-fix):
-- This file documents the CURRENT database schema for readability. It is
-- NOT the Prisma migration history and must never be run directly against
-- a database that Prisma will manage — doing so produces a database with
-- no migration history, which `prisma migrate deploy` cannot safely adopt
-- automatically (see CLAUDE.md's "Environment note" for why, and the
-- exact supported bootstrap scenarios).
--
-- The only supported way to initialize or change a production database's
-- schema is:
--
--     npx prisma migrate deploy
--
-- against `backend/prisma/migrations/`. Never substitute this file for
-- that command. When this file changes, `backend/prisma/schema.prisma`
-- and a corresponding migration are the actual mechanism of record —
-- this file is updated afterward purely to stay readable as a snapshot
-- of what the schema now looks like.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_type AS ENUM ('APPLICATION_USER','CUSTOMER','MASTER');
CREATE TYPE application_role AS ENUM ('ADMIN','EMPLOYEE');
CREATE TYPE user_status AS ENUM ('ACTIVE','INACTIVE','BLOCKED');

CREATE TYPE property_category AS ENUM (
  'RESIDENTIAL','INDUSTRIAL','COMMERCIAL','AGRICULTURAL'
);

CREATE TYPE property_status AS ENUM (
  'AVAILABLE','SOLD','ON_HOLD','INACTIVE'
);

-- India-relevant set: SQ_FT/SQ_YD/SQ_M for residential/commercial-scale
-- listings, ACRE/GUNTHA/HECTARE for agricultural land. SQ_YD/SQ_M added
-- later via an additive ALTER TYPE ... ADD VALUE migration (no existing
-- rows touched) to match Flutter's six-value area-unit picker.
CREATE TYPE property_area_unit AS ENUM (
  'SQ_FT','SQ_YD','SQ_M','ACRE','GUNTHA','HECTARE'
);

CREATE TYPE attachment_type AS ENUM (
  'PHOTO','DOCUMENT','RECORDING'
);

CREATE TYPE document_type AS ENUM (
  'SEVEN_TWELVE','SALE_DEED','PROPERTY_CARD','NOC','OTHER'
);

CREATE TYPE inquiry_status AS ENUM (
  'NEW','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED'
);

CREATE TYPE inquiry_priority AS ENUM (
  'LOW','MEDIUM','HIGH','URGENT'
);

-- Phase 11 — replaces the prior free-text inquiries.type. Existing
-- 'Sell'/'SELL' values were normalized to 'SELLER' by migration
-- 20260825000000_inquiry_buyer_seller_matching; any other pre-existing
-- value was set to NULL rather than guessed at.
CREATE TYPE inquiry_type AS ENUM (
  'BUYER','SELLER'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) UNIQUE,
  user_type user_type NOT NULL,
  role application_role,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255),
  mobile VARCHAR(20),
  alternate_mobile VARCHAR(20),
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  password_hash TEXT,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),

  CONSTRAINT chk_users_identity CHECK (
    (user_type='APPLICATION_USER'
      AND user_id IS NOT NULL
      AND password_hash IS NOT NULL
      AND role IS NOT NULL)
    OR
    (user_type='CUSTOMER'
      AND user_id IS NULL
      AND password_hash IS NULL
      AND role IS NULL)
    OR
    (user_type='MASTER'
      AND user_id IS NOT NULL
      AND password_hash IS NOT NULL
      AND role IS NULL)
  )
);

CREATE UNIQUE INDEX uq_users_email
  ON users(lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX idx_users_mobile ON users(mobile);
CREATE INDEX idx_users_type_status ON users(user_type,status);

CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_code VARCHAR(50) NOT NULL UNIQUE,
  property_type VARCHAR(50) NOT NULL,
  category property_category NOT NULL,
  area NUMERIC(14,2),
  -- Controlled enum as of this phase (was free-text VARCHAR(20) with
  -- inconsistent real values — normalized by migration).
  area_unit property_area_unit,
  price NUMERIC(18,2),
  -- Not client-settable as of this phase (India-only application, always
  -- 'INR') — column/value retained for backward compatibility.
  price_unit VARCHAR(20),
  gat_no_details VARCHAR(255),
  description TEXT,

  address TEXT,
  locality VARCHAR(150),
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  map_url TEXT,

  status property_status NOT NULL DEFAULT 'AVAILABLE',

  -- Property-level public-website visibility. Distinct from
  -- inquiries.is_public — a property can have zero or many inquiries, so
  -- that flag can't stand in for this one. Only an ADMIN may change it
  -- (see PropertiesService.update).
  is_public BOOLEAN NOT NULL DEFAULT FALSE,

  -- Phase 26. The actual CUSTOMER who owns the property — an explicit,
  -- independently-set relationship, deliberately distinct from
  -- created_by below (whichever staff member entered the listing, never
  -- assumed to be the owner) and never inferred from a SELLER inquiry
  -- (not guaranteed to exist or be unique). NULL means unassigned; no
  -- CHECK constraint ties this to user_type='CUSTOMER' (Postgres CHECK
  -- constraints can't do cross-table lookups either) — enforced in the
  -- application layer instead, the same as every other cross-table
  -- "must be this kind of user" rule in this schema (e.g. inquiries.
  -- customer_id's own CUSTOMER-only rule).
  owner_customer_id UUID REFERENCES users(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),

  CHECK (area IS NULL OR area >= 0),
  CHECK (price IS NULL OR price >= 0),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

CREATE INDEX idx_properties_status ON properties(status);
CREATE INDEX idx_properties_city ON properties(city);
CREATE INDEX idx_properties_category ON properties(category);
CREATE INDEX idx_properties_public ON properties(is_public);
CREATE INDEX idx_properties_owner ON properties(owner_customer_id);

CREATE TABLE inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_number VARCHAR(50) NOT NULL UNIQUE,

  -- Nullable as of Phase 13B: a lightweight, ADMIN-created inquiry can
  -- exist before the customer has been identified.
  customer_id UUID REFERENCES users(id),
  property_id UUID REFERENCES properties(id),

  type inquiry_type,
  priority inquiry_priority NOT NULL DEFAULT 'MEDIUM',
  status inquiry_status NOT NULL DEFAULT 'NEW',

  external_reference VARCHAR(255),

  handled_by_user_id UUID REFERENCES users(id),
  assigned_to_user_id UUID REFERENCES users(id),

  remarks TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,

  -- Unified location fields — used by BOTH BUYER and SELLER inquiries,
  -- replacing the old BUYER-only preferred_city/preferred_pincode. For a
  -- SELLER inquiry, kept in sync with the linked property's own
  -- city/state/pincode/locality (application-layer, not a DB trigger —
  -- see InquiriesService/PropertiesService); never independently
  -- editable via the API while a property is linked. pincode is the
  -- mandatory exact-match matching gate; city/locality are the
  -- fuzzy/normalized matching signals.
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  -- Locality/area text — synced from properties.locality only (never
  -- properties.address) for a SELLER inquiry.
  locality VARCHAR(150),
  -- Maximum price the buyer will pay; directly comparable to
  -- properties.price (same precision, same implicit currency/unit — no
  -- unit-conversion support exists). Still BUYER-only — unchanged this
  -- phase.
  max_budget NUMERIC(18,2),

  -- NULL = not yet submitted; non-NULL = submitted, at the recorded time.
  -- Only ever set by the POST /inquiries/{id}/submit operation.
  submitted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID REFERENCES users(id)
);

CREATE INDEX idx_inquiries_customer ON inquiries(customer_id);
CREATE INDEX idx_inquiries_property ON inquiries(property_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_assigned ON inquiries(assigned_to_user_id);
CREATE INDEX idx_inquiries_handled ON inquiries(handled_by_user_id);
CREATE INDEX idx_inquiries_public ON inquiries(is_public);
CREATE INDEX idx_inquiries_created ON inquiries(created_at DESC);
-- Justified by GET /inquiries/{id}/matches' WHERE type='BUYER' filter.
CREATE INDEX idx_inquiries_type ON inquiries(type);
-- Pincode is now the mandatory matching gate for both directions (this
-- phase) — was city, reached via a join through properties, for the
-- SELLER side.
CREATE INDEX idx_inquiries_type_pincode ON inquiries(type, pincode);

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  inquiry_id UUID REFERENCES inquiries(id) ON DELETE CASCADE,

  attachment_type attachment_type NOT NULL,
  document_type document_type,

  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  file_size_bytes BIGINT,

  r2_bucket VARCHAR(255) NOT NULL,
  r2_object_key VARCHAR(1024) NOT NULL UNIQUE,
  file_url TEXT,

  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0,

  uploaded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Phase 13B: PHOTO/DOCUMENT require property_id OR inquiry_id (not
  -- both) — the inquiry_id branch supports the lightweight ADMIN-call
  -- capture flow, where photos/documents are gathered before a property
  -- record exists. RECORDING is unchanged (inquiry_id only).
  CONSTRAINT chk_attachment_relationship CHECK (
    (attachment_type='PHOTO' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
    OR
    (attachment_type='DOCUMENT' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
    OR
    (attachment_type='RECORDING' AND inquiry_id IS NOT NULL)
  ),

  CONSTRAINT chk_attachment_document_type CHECK (
    (attachment_type='DOCUMENT' AND document_type IS NOT NULL)
    OR
    (attachment_type IN ('PHOTO','RECORDING') AND document_type IS NULL)
  ),

  CONSTRAINT chk_attachment_size CHECK (
    file_size_bytes IS NULL OR file_size_bytes >= 0
  )
);

CREATE INDEX idx_attachments_property
  ON attachments(property_id);

CREATE INDEX idx_attachments_inquiry
  ON attachments(inquiry_id);

CREATE INDEX idx_attachments_type
  ON attachments(attachment_type);

CREATE INDEX idx_attachments_inquiry_type
  ON attachments(inquiry_id,attachment_type);

CREATE UNIQUE INDEX uq_property_primary_photo
  ON attachments(property_id)
  WHERE attachment_type='PHOTO' AND is_primary=TRUE;

CREATE TABLE inquiry_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,

  assigned_from_user_id UUID REFERENCES users(id),
  assigned_to_user_id UUID NOT NULL REFERENCES users(id),

  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,

  created_by UUID NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_inquiry_assignments_inquiry
  ON inquiry_assignments(inquiry_id,assigned_at DESC);

-- In-app notifications (this phase). Generic entity_type/entity_id/
-- free-text type shape, same as audit_logs below — currently produced
-- only for ADMIN-initiated inquiry assignment
-- (type='INQUIRY_ASSIGNED', entity_type='INQUIRY').
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,

  entity_type VARCHAR(100),
  entity_id UUID,

  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user
  ON notifications(user_id,is_read,created_at DESC);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID REFERENCES users(id),

  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  action VARCHAR(100) NOT NULL,

  old_values JSONB,
  new_values JSONB,

  ip_address INET,
  user_agent TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity
  ON audit_logs(entity_type,entity_id,created_at DESC);

CREATE INDEX idx_audit_user
  ON audit_logs(user_id,created_at DESC);
