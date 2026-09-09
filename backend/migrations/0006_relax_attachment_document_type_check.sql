-- =====================================================================
-- Fix — removes the column-level enum CHECK constraint on
-- attachments.document_type that was never removed when Phase 38B
-- relaxed application-layer validation to accept arbitrary trimmed,
-- non-empty document types (<=100 chars) instead of the original closed
-- set (SEVEN_TWELVE/SALE_DEED/PROPERTY_CARD/NOC/OTHER). Confirmed root
-- cause: R2 upload succeeds, then the finalize INSERT into `attachments`
-- fails with SQLITE_CONSTRAINT_CHECK for any custom document_type,
-- surfacing as an opaque 500 INTERNAL_ERROR to the client.
--
-- SQLite has no `ALTER TABLE ... DROP CONSTRAINT` (it doesn't exist at
-- all) and `ALTER TABLE ... ADD/DROP COLUMN` cannot touch a column's
-- CHECK either — the only safe mechanism is the standard SQLite
-- "rebuild" pattern: create a replacement table with the corrected
-- column definition, copy every row across unchanged via an explicit
-- column list, drop the original, rename the replacement into its
-- place, then recreate every index the original table had (indexes
-- belong to the table object and do not survive a DROP TABLE).
--
-- Schema verified by direct read of migrations/0001_initial_schema.sql
-- immediately before writing this migration (grep confirmed no
-- migration 0002-0005 has touched `attachments`) — not assumed from the
-- diagnosis.
--
-- Exactly one change from the current schema: `document_type`'s
-- column-level `CHECK (document_type IS NULL OR document_type IN
-- (...))` is removed — it remains a plain nullable TEXT column with no
-- enum restriction, matching Phase 38B's already-approved application-
-- layer validation (attachments.ts's parseUploadBody, unchanged by this
-- migration). Every other column, every table-level CHECK constraint,
-- every FOREIGN KEY, and every index is reproduced verbatim:
--
--   - Relationship/resource CHECK (table-level, unnamed): PHOTO/DOCUMENT
--     require property_id OR inquiry_id; RECORDING requires inquiry_id.
--     UNCHANGED — preserves requirement C exactly.
--   - Attachment-type/document-type CHECK (table-level, unnamed):
--     DOCUMENT requires document_type NOT NULL; every other
--     attachment_type requires document_type IS NULL. UNCHANGED —
--     preserves requirement B exactly. This is the relationship
--     constraint, distinct from the enum-value restriction being
--     removed; it still fully enforces "DOCUMENT must have a
--     document_type, non-DOCUMENT must not have one" with no weakening.
--   - file_size_bytes CHECK (table-level, redundant with the identical
--     column-level CHECK — both existed in the original schema and both
--     are preserved here unchanged, exactly as before).
--   - FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE
--     CASCADE, FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON
--     DELETE CASCADE, FOREIGN KEY (uploaded_by) REFERENCES users(id).
--     UNCHANGED.
--   - r2_object_key TEXT NOT NULL UNIQUE (inline). UNCHANGED.
--   - idx_attachments_property, idx_attachments_inquiry,
--     idx_attachments_type, idx_attachments_inquiry_type,
--     uq_property_primary_photo (partial unique index: at most one
--     PHOTO with is_primary=1 per property_id). All five recreated
--     identically after the rebuild.
--
-- Existing data is preserved exactly: every row is copied via an
-- explicit column list (never `SELECT *`, so a future column-order
-- change can never silently misalign data) with no transformation of
-- any value — ids, R2 object keys, property/inquiry relationships,
-- attachment types, existing document_type values (including the five
-- predefined ones already in use), and timestamps are all copied
-- verbatim. No row is deleted or re-created with a new id. No other
-- table is touched.
-- =====================================================================

CREATE TABLE attachments_new (
    id                  TEXT PRIMARY KEY,
    property_id         TEXT,
    inquiry_id          TEXT,
    attachment_type     TEXT NOT NULL CHECK (attachment_type IN ('PHOTO','DOCUMENT','RECORDING')),
    document_type       TEXT,
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

    CHECK (
        (attachment_type = 'PHOTO' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
        OR
        (attachment_type = 'DOCUMENT' AND (property_id IS NOT NULL OR inquiry_id IS NOT NULL))
        OR
        (attachment_type = 'RECORDING' AND inquiry_id IS NOT NULL)
    ),
    CHECK (
        (attachment_type = 'DOCUMENT' AND document_type IS NOT NULL)
        OR
        (attachment_type != 'DOCUMENT' AND document_type IS NULL)
    ),
    CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),

    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

INSERT INTO attachments_new (
    id, property_id, inquiry_id, attachment_type, document_type, file_name, mime_type,
    file_size_bytes, r2_bucket, r2_object_key, file_url, is_primary, display_order,
    uploaded_by, created_at
)
SELECT
    id, property_id, inquiry_id, attachment_type, document_type, file_name, mime_type,
    file_size_bytes, r2_bucket, r2_object_key, file_url, is_primary, display_order,
    uploaded_by, created_at
FROM attachments;

DROP TABLE attachments;

ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX idx_attachments_property ON attachments (property_id);
CREATE INDEX idx_attachments_inquiry ON attachments (inquiry_id);
CREATE INDEX idx_attachments_type ON attachments (attachment_type);
CREATE INDEX idx_attachments_inquiry_type ON attachments (inquiry_id, attachment_type);
CREATE UNIQUE INDEX uq_property_primary_photo ON attachments (property_id) WHERE attachment_type = 'PHOTO' AND is_primary = 1;
