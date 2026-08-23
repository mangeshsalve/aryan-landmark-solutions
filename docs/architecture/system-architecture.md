# System Architecture

Flutter Mobile
   |
 HTTPS
   v
NestJS API
   |
   +---- PostgreSQL
   |
   +---- Cloudinary

## Normal authentication
Flutter -> /api/v1/auth/login -> JWT -> Admin/Employee authorization.

## Master authentication
Master UI -> /api/v1/master-auth/login -> master-scoped JWT ->
Master Record Management endpoints.

Master credentials are manually provisioned in the database.

## Inquiry flow
New inquiry -> inquiry number -> customer/property -> handled-by ->
assigned-to -> assignment history -> work/follow-up -> uploads ->
approved public listing.

## File flow
Flutter -> NestJS validation -> Cloudinary -> PostgreSQL metadata.

## Environments
Development -> Staging -> Production.
