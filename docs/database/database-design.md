# Production Database Design

PostgreSQL 15+ recommended. Prisma ORM. UUID internal keys.

## Tables

1. roles
2. persons
3. app_users
4. customers
5. property_categories
6. document_types
7. locations
8. properties
9. property_photos
10. property_documents
11. inquiries
12. inquiry_assignment_history
13. inquiry_recordings
14. refresh_tokens
15. audit_logs
16. master_access_credentials

`master_access_credentials` is the only addition required by the new Master UI
credential requirement.

## Relationships

PERSON -> APP_USER -> ROLE
PERSON -> CUSTOMER

PROPERTY -> PROPERTY_CATEGORY
PROPERTY -> LOCATION
PROPERTY -> PROPERTY_PHOTOS
PROPERTY -> PROPERTY_DOCUMENTS -> DOCUMENT_TYPE

CUSTOMER -> INQUIRY -> PROPERTY
INQUIRY -> APP_USER (handled_by)
INQUIRY -> APP_USER (assigned_to)
INQUIRY -> INQUIRY_ASSIGNMENT_HISTORY
INQUIRY -> INQUIRY_RECORDINGS

APP_USER -> REFRESH_TOKENS
APP_USER -> AUDIT_LOGS

MASTER_ACCESS_CREDENTIALS is a separate authentication boundary.

## User ID
`app_users.id` is UUID PK.
`app_users.user_id` is unique human-readable ID such as EMP001/ADM001.
Business tables should normally FK to `app_users.id`, not the text `user_id`.

## Migration
Use versioned Prisma migrations. Do not use production auto-sync.
