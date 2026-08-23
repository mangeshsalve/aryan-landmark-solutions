# Aryan Landmark Solutions — Final Business Requirements

## Roles
- ADMIN
- EMPLOYEE

## Master Record Management
A dedicated Master Record Creation/Management UI starts with a Type selector:
- USER
- CUSTOMER

USER contains common person fields plus:
- password
- role

CUSTOMER contains common person fields and has no application password/role.

Common fields:
- name
- email
- mobile
- alternate mobile
- address
- city
- state
- pincode

### Separate Master UI credentials
The Master Record Management UI uses credentials different from normal user
login credentials. These credentials are manually provisioned in the database.
There is no self-service registration for them. They must be stored as a
strong password hash and protected by a separate master-access authorization
boundary.

## Property
Property contains:
- property type
- category/zone
- area and unit
- price and unit
- Gat No details
- description
- map/location information

Categories include examples such as:
- Residential
- Industrial
- Commercial
- Agricultural

Location supports:
- address/locality/city/state/pincode
- latitude
- longitude
- map URL

## Property media
Plot/property photos are separate from legal/property documents.

Documents include examples:
- 7/12 Extract
- Sale Deed
- Property Card
- NOC
- Other

Files are stored in Cloudinary; metadata is stored in PostgreSQL.

## Inquiry
Inquiry contains:
- inquiry number
- customer
- property
- type
- priority
- status
- external reference
- handled by user
- assigned to user
- remarks
- public flag

`external_reference` is an external source/reference.
`handled_by_user_id` is the internal user who handles the inquiry.
`assigned_to_user_id` is the internal user currently assigned to work on it.

Example:
Employee A receives inquiry:
handled_by = A, assigned_to = A.

Employee A assigns it to Employee B:
handled_by = A, assigned_to = B.

All reassignment changes are recorded in assignment history.

## Recordings
- Admin-created inquiry: recording mandatory.
- Employee-created inquiry: recording optional.
Backend enforces this.

## Dashboard
Dashboard must show a visible `Create New Inquiry` action.

Admin view: full management access.
Employee view: operational/assigned inquiry access according to authorization.

## Public inquiry/property
Approved public listings may show:
- area/location
- property details
- price if approved
- category/zone
- approved photos
- public description

Never expose:
- customer name/mobile/email
- internal employee data
- private assignment data

## Reports
Scope includes inquiry, employee performance, property listing, call recording,
and public property reporting. Exact report columns/filters follow the final
client-approved report definition.

Do not invent new business workflows without approval.
