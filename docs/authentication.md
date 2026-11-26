# DataLens authentication setup

The Node API supports an optional single-administrator authentication mode. It uses a server-side scrypt password hash and an HMAC-signed, eight-hour HttpOnly cookie. The browser never receives the password hash or cookie-signing secret.

## Enable authentication

Keep these settings in the root .env file. Do not commit .env or share its secrets:

    AUTH_ENABLED=true
    AUTH_ADMIN_EMAIL=admin@example.com
    AUTH_ADMIN_PASSWORD_HASH=<salt-hex>:<scrypt-hash-hex>
    AUTH_COOKIE_SECRET=<random-secret-at-least-32-characters>

Generate a password hash in PowerShell. The password is read into a local PowerShell variable and is not typed into the command:

    $adminPassword = Read-Host "Enter the DataLens administrator password"
    $env:ADMIN_PASSWORD_TEMP = $adminPassword
    $hash = node -e "const c=require('node:crypto');const salt=c.randomBytes(16);const derived=c.scryptSync(process.env.ADMIN_PASSWORD_TEMP,salt,64);console.log(salt.toString('hex')+':'+derived.toString('hex'))"
    Remove-Item Env:ADMIN_PASSWORD_TEMP
    $hash

Generate the cookie-signing secret separately:

    node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"

Copy the generated hash and secret into .env, set AUTH_ADMIN_EMAIL, and rebuild/restart the API:

    docker compose up -d --build api

Use the frontend on the same site. The included Vite /api proxy is configured for local development. Sign-in uses POST /auth/login; the server sets an HttpOnly, SameSite=Lax cookie. POST /auth/logout clears it. The app checks GET /auth/session on startup.

## Protected routes

When authentication is enabled, the session middleware protects dataset uploads, project/version endpoints, relationship/table/issue/quality-score endpoints, knowledge-document uploads, and AI chat/session endpoints.

/health, /health/ready, and /auth/* remain public so readiness checks and sign-in can work.

## Development and deployment notes

- AUTH_ENABLED=false preserves the local preview experience. Do not expose this mode to the public internet.
- NODE_ENV=production refuses to start unless AUTH_ENABLED=true and all three admin settings are present.
- Passwords are verified with Node's scrypt KDF. Login failures are rate-limited per source IP.
- The current implementation is deliberately single-administrator. It does not provide user registration, roles, or per-project ownership / multi-tenant isolation. Add those before offering the service to multiple independent customers.
- Deploy the frontend and API behind the same site/reverse proxy so the browser can use the HttpOnly cookie. Production cookies include the Secure attribute and require HTTPS.