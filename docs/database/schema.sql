CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE roles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 code VARCHAR(50) NOT NULL UNIQUE,
 name VARCHAR(100) NOT NULL,
 description TEXT,
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE persons (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name VARCHAR(150) NOT NULL,
 email VARCHAR(255),
 mobile VARCHAR(20),
 alternate_mobile VARCHAR(20),
 address TEXT,
 city VARCHAR(100),
 state VARCHAR(100),
 pincode VARCHAR(10),
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID,
 updated_by UUID,
 CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED'))
);
CREATE INDEX idx_persons_email ON persons(lower(email));
CREATE INDEX idx_persons_mobile ON persons(mobile);

CREATE TABLE app_users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id VARCHAR(50) NOT NULL UNIQUE,
 person_id UUID NOT NULL UNIQUE REFERENCES persons(id),
 password_hash TEXT NOT NULL,
 role_id UUID NOT NULL REFERENCES roles(id),
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 last_login_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID,
 updated_by UUID,
 CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED'))
);
CREATE INDEX idx_app_users_role ON app_users(role_id);
CREATE INDEX idx_app_users_status ON app_users(status);

CREATE TABLE customers (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 person_id UUID NOT NULL UNIQUE REFERENCES persons(id),
 customer_code VARCHAR(50) NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID,
 updated_by UUID
);

CREATE TABLE property_categories (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 code VARCHAR(50) NOT NULL UNIQUE,
 name VARCHAR(100) NOT NULL UNIQUE,
 description TEXT,
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE document_types (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 code VARCHAR(50) NOT NULL UNIQUE,
 name VARCHAR(100) NOT NULL UNIQUE,
 description TEXT,
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE locations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 address TEXT,
 locality VARCHAR(150),
 city VARCHAR(100),
 state VARCHAR(100),
 pincode VARCHAR(10),
 latitude NUMERIC(10,7),
 longitude NUMERIC(10,7),
 map_url TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
 CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX idx_locations_city ON locations(city);

CREATE TABLE properties (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 property_code VARCHAR(50) NOT NULL UNIQUE,
 property_type VARCHAR(50) NOT NULL,
 category_id UUID REFERENCES property_categories(id),
 location_id UUID REFERENCES locations(id),
 area NUMERIC(14,2),
 area_unit VARCHAR(20),
 price NUMERIC(18,2),
 price_unit VARCHAR(20),
 gat_no_details VARCHAR(255),
 description TEXT,
 status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID REFERENCES app_users(id),
 updated_by UUID REFERENCES app_users(id),
 CHECK (status IN ('AVAILABLE','SOLD','ON_HOLD','INACTIVE')),
 CHECK (area IS NULL OR area >= 0),
 CHECK (price IS NULL OR price >= 0)
);
CREATE INDEX idx_properties_category ON properties(category_id);
CREATE INDEX idx_properties_location ON properties(location_id);
CREATE INDEX idx_properties_status ON properties(status);

CREATE TABLE property_photos (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 cloudinary_url TEXT NOT NULL,
 cloudinary_public_id VARCHAR(500) NOT NULL,
 is_primary BOOLEAN NOT NULL DEFAULT FALSE,
 display_order INTEGER NOT NULL DEFAULT 0,
 uploaded_by UUID REFERENCES app_users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_property_photos_property ON property_photos(property_id);
CREATE UNIQUE INDEX uq_property_primary_photo
 ON property_photos(property_id) WHERE is_primary=TRUE;

CREATE TABLE property_documents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 document_type_id UUID NOT NULL REFERENCES document_types(id),
 file_name VARCHAR(255) NOT NULL,
 cloudinary_url TEXT NOT NULL,
 cloudinary_public_id VARCHAR(500) NOT NULL,
 resource_type VARCHAR(50),
 uploaded_by UUID REFERENCES app_users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_property_documents_property ON property_documents(property_id);

CREATE TABLE inquiries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 inquiry_number VARCHAR(50) NOT NULL UNIQUE,
 customer_id UUID REFERENCES customers(id),
 property_id UUID REFERENCES properties(id),
 type VARCHAR(50),
 priority VARCHAR(30) DEFAULT 'MEDIUM',
 status VARCHAR(50) NOT NULL DEFAULT 'NEW',
 external_reference VARCHAR(255),
 handled_by_user_id UUID REFERENCES app_users(id),
 assigned_to_user_id UUID REFERENCES app_users(id),
 remarks TEXT,
 is_public BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID REFERENCES app_users(id),
 updated_by UUID REFERENCES app_users(id),
 CHECK (priority IS NULL OR priority IN ('LOW','MEDIUM','HIGH','URGENT'))
);
CREATE INDEX idx_inquiries_customer ON inquiries(customer_id);
CREATE INDEX idx_inquiries_property ON inquiries(property_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_assigned ON inquiries(assigned_to_user_id);
CREATE INDEX idx_inquiries_handled ON inquiries(handled_by_user_id);
CREATE INDEX idx_inquiries_public ON inquiries(is_public);
CREATE INDEX idx_inquiries_created ON inquiries(created_at DESC);

CREATE TABLE inquiry_assignment_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
 assigned_from_user_id UUID REFERENCES app_users(id),
 assigned_to_user_id UUID NOT NULL REFERENCES app_users(id),
 assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reason TEXT,
 created_by UUID REFERENCES app_users(id)
);
CREATE INDEX idx_assignment_history_inquiry
 ON inquiry_assignment_history(inquiry_id, assigned_at DESC);

CREATE TABLE inquiry_recordings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
 cloudinary_url TEXT NOT NULL,
 cloudinary_public_id VARCHAR(500) NOT NULL,
 file_name VARCHAR(255) NOT NULL,
 duration_seconds INTEGER,
 uploaded_by UUID REFERENCES app_users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recordings_inquiry ON inquiry_recordings(inquiry_id,created_at DESC);

CREATE TABLE refresh_tokens (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE audit_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID REFERENCES app_users(id),
 entity_type VARCHAR(100) NOT NULL,
 entity_id UUID,
 action VARCHAR(50) NOT NULL,
 old_values JSONB,
 new_values JSONB,
 ip_address INET,
 user_agent TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type,entity_id,created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id,created_at DESC);

CREATE TABLE master_access_credentials (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 username VARCHAR(100) NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
 last_login_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED'))
);

INSERT INTO roles(code,name,description) VALUES
 ('ADMIN','Administrator','Full application access'),
 ('EMPLOYEE','Employee','Operational access')
ON CONFLICT(code) DO NOTHING;

INSERT INTO property_categories(code,name) VALUES
 ('RESIDENTIAL','Residential'),
 ('INDUSTRIAL','Industrial'),
 ('COMMERCIAL','Commercial'),
 ('AGRICULTURAL','Agricultural')
ON CONFLICT(code) DO NOTHING;

INSERT INTO document_types(code,name) VALUES
 ('SEVEN_TWELVE','7/12 Extract'),
 ('SALE_DEED','Sale Deed'),
 ('PROPERTY_CARD','Property Card'),
 ('NOC','NOC'),
 ('OTHER','Other')
ON CONFLICT(code) DO NOTHING;
