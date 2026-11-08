# Supabase Auth for the Hermes dashboard

The dashboard uses Supabase Auth email/password sign-in. FastAPI validates each access token with the Supabase Auth user endpoint and sets an HttpOnly, SameSite=Lax cookie. The middleware protects both the root dashboard document and every `/api/*` route except the minimal Auth bootstrap/session endpoints. The browser SDK stores the refresh token in its normal session storage and renews the server cookie when the access token refreshes.

## Project

- Supabase project ref: `uhujussjcnoacqhavsqg`
- Project URL: `https://uhujussjcnoacqhavsqg.supabase.co`
- Client key: use the project's **publishable** key only.

The application has these defaults already configured. Environment variables can override them:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_AUTH_REDIRECT_URL` (optional canonical callback, e.g. `https://dashboard.example.com/login`)

Do not configure a service-role key or a Supabase secret key in the dashboard process or browser.

## Supabase Dashboard configuration

1. Open **Authentication → Sign-in / Providers** and ensure **Email** is enabled.
2. Keep email confirmation enabled for account creation.
3. Under **Authentication → URL Configuration**, set the Site URL to the dashboard's canonical origin.
4. Add the exact callback URL `http://127.0.0.1:8767/login` for the default local dashboard. Add `http://localhost:8767/login` as well when using that hostname. For deployment, add the deployed `https://...` origin with `/login` and set `SUPABASE_AUTH_REDIRECT_URL` to that exact URL.

The callback URL must be present in Supabase's redirect allow-list for email confirmation links to return to this dashboard.

## Local run

Start the dashboard on its default local origin:

```bash
scripts/start.sh
```

Open `http://127.0.0.1:8767`, create the first account, complete the email confirmation, and sign in. Sign out from the top bar or Settings.

## Route behavior

- `GET /`: requires a valid Supabase access-token cookie; otherwise redirects to `/login`.
- `/api/*`: requires the same validated cookie; unauthenticated or expired sessions return `401`.
- `GET /api/auth/config`, `POST /api/auth/session`, `DELETE /api/auth/session`, `GET /login`, and static assets are public bootstrap routes.
- The server validates the token against `/auth/v1/user`; the browser never sends a service-role credential.
