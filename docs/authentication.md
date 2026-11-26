# DataLens accounts and authentication

DataLens supports email/password accounts with a private workspace per account. The original single-administrator login remains available as an optional compatibility path.

## Enable sign-in and registration

Add or update these settings in the root `.env` file. Never commit `.env` or share its secrets:

```dotenv
AUTH_ENABLED=true
AUTH_ALLOW_REGISTRATION=true
AUTH_COOKIE_SECRET=<random-secret-at-least-32-characters>

# Optional legacy administrator login:
AUTH_ADMIN_EMAIL=admin@example.com
AUTH_ADMIN_PASSWORD_HASH=<salt-hex>:<scrypt-hash-hex>
```

Generate the cookie-signing secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

To use the optional legacy administrator account, generate its scrypt password hash in PowerShell. The password is read into a local variable and is not typed into the command:

```powershell
$adminPassword = Read-Host "Enter the DataLens administrator password"
$env:ADMIN_PASSWORD_TEMP = $adminPassword
$hash = node -e "const c=require('node:crypto');const salt=c.randomBytes(16);const derived=c.scryptSync(process.env.ADMIN_PASSWORD_TEMP,salt,64);console.log(salt.toString('hex')+':'+derived.toString('hex'))"
Remove-Item Env:ADMIN_PASSWORD_TEMP
$hash
```

The administrator hash and email are optional when using registered accounts. If configured, the original admin login remains available. Do not reuse the same email for an admin account and a registered user account.

Rebuild/restart the API after changing the environment:

```powershell
docker compose up -d --build api
```

The API starts with `prisma migrate deploy`; the additive account migration creates the `users` table and nullable `projects.owner_user_id` field. Existing projects and dataset versions are preserved and remain unowned legacy/admin workspaces.

## Registration and login

- `POST /auth/register` accepts `name`, `email`, and `password`. It creates a user, a private default workspace, and an eight-hour session.
- `POST /auth/login` accepts `email` and `password` for a registered account or the optional legacy administrator.
- `GET /auth/session` restores the signed-in account and its default workspace.
- `POST /auth/logout` clears the session cookie.
- Set `AUTH_ALLOW_REGISTRATION=false` to hide and disable new account registration while keeping sign-in enabled.

Passwords are stored as a random 16-byte salt plus a 64-byte scrypt hash. The browser receives neither the password hash nor the cookie-signing secret. Sessions use a signed, eight-hour HttpOnly, SameSite=Lax cookie; production adds Secure and therefore requires HTTPS.

Registration and failed login attempts are limited to five per source IP per fifteen-minute window. This limiter is in process memory and resets when the API restarts; use a shared rate limiter for multi-instance production deployments.

## Workspace access and legacy data

New registrations receive a private workspace. Project APIs verify that a registered account owns the requested project. CSV uploads are also checked against the account's workspace. The optional administrator account retains access to legacy projects.

Existing projects are not automatically assigned to the first account that signs up. They remain unowned and accessible through the configured administrator login; there is no destructive migration or dataset deletion.

## Protected routes

When authentication is enabled, the session middleware protects CSV uploads and project/version, tables, relationship, issues, quality-score, knowledge-document, and AI chat/session endpoints.

`/health`, `/health/ready`, and `/auth/*` remain public so readiness checks and account access can work.

## Important deployment limitations

- `AUTH_ENABLED=false` preserves the local preview experience. Do not expose that mode to the public internet.
- `AUTH_ENABLED=true` requires `AUTH_COOKIE_SECRET`. Legacy administrator email/hash are optional.
- Email ownership verification, password reset/recovery, MFA, invitations, organization roles, and audit log screens are not implemented in this release.
- The in-memory IP limiter is suitable only for a single API process. Use a shared rate-limit store, monitoring, HTTPS and operational security review before public multi-instance deployment.
- Deploy frontend and API behind the same site/reverse proxy so the browser can use the HttpOnly cookie.
