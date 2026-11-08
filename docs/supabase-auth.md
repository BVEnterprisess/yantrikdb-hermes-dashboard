# Supabase Auth for the standalone YantrikDB Dashboard

The dashboard retains Supabase Auth email/password sign-in. FastAPI validates each Supabase access token server-side with the Supabase Auth user endpoint and sets an `HttpOnly`, `SameSite=Lax` cookie. The middleware protects the dashboard document and application API routes. The browser SDK uses the Supabase publishable key and manages its normal session state; the YantrikDB bearer token is never sent to browser JavaScript.

## Project configuration

The repository includes the existing Supabase project URL and its browser-safe publishable key as defaults. Override them with environment variables when deploying to another Supabase project:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_AUTH_REDIRECT_URL` (optional canonical callback, for example `https://dashboard.example.com/login`)

Use a **publishable** key only. Never configure a Supabase service-role key or secret key in the dashboard process, browser, or `.env` file.

## Supabase Dashboard setup

1. In **Authentication → Sign-in / Providers**, enable **Email**.
2. Under **Authentication → URL Configuration**, set the Site URL to the dashboard's canonical origin.
3. Add the exact redirect URL `http://127.0.0.1:8767/login` for the default local bind. If you use `localhost`, add `http://localhost:8767/login` as well.
4. For deployment, add the canonical `https://…/login` callback URL to the redirect allow-list and set `SUPABASE_AUTH_REDIRECT_URL` to the same URL.

The callback URL must be allowed for email confirmation links to return to the dashboard.

## Local run

Configure the protected environment file and run the standalone dashboard:

```bash
cp .env.example .env
chmod 600 .env
# Review SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.
scripts/start.sh
```

Open `http://127.0.0.1:8767`, create an account, complete email confirmation if enabled, and sign in. Sign out from the top bar or Settings. The dashboard's YantrikDB server connection is configured separately with `YANTRIKDB_SERVER_URL` and the server-side `YANTRIKDB_TOKEN`.

## Route and cookie behavior

- `GET /` redirects to `/login` if there is no valid session.
- Application `/api/*` routes return `401` when the session is missing or invalid; unauthenticated API responses carry `X-Dashboard-Auth: required` so browser code can return to sign-in.
- A Supabase verification outage is reported as `503`, distinct from an invalid or expired token.
- Public bootstrap routes are `GET /login`, `GET /api/auth/config`, `POST /api/auth/session`, `DELETE /api/auth/session`, and static assets. The session endpoint validates its submitted access token before setting the `HttpOnly` cookie.
- The middleware revalidates the cookie server-side for protected requests. Browser JavaScript never receives the YantrikDB bearer token.
