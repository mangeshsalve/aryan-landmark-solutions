# Security Architecture

- Passwords use Argon2id or bcrypt.
- Never store plaintext passwords.
- Normal users authenticate with JWT access/refresh tokens.
- Master UI uses a separate master credential and master-scoped token.
- Never trust role/user identity/master privilege from request body.
- Validate all inputs.
- Apply authorization guards/policies server-side.
- Use rate limiting, secure headers, CORS and HTTPS.
- Store Cloudinary secrets only on backend.
- Public APIs must not expose customer PII or internal employee data.
- Audit login, master access, user/customer changes, inquiry changes,
  assignment changes, public visibility changes and file operations.
