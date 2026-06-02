# SpendTracker

SpendTracker is an automated, AI-powered expense tracking application. It securely links to your Gmail account(s), automatically scans for receipts and invoices using the Gmail API, parses them using Google Gemini 3.1 Flash, lite and stores the structured data in a Supabase PostgreSQL database. It then displays your spending trends in a beautifully designed React dashboard.

## System Architecture

- **Frontend:** React (Vite) + Tailwind CSS + Recharts + Lucide Icons
- **Backend:** Supabase (Database, Auth, Edge Functions)
- **AI Processing:** Google Gemini 3.1 Flash lite (via `@google/genai` SDK)
- **Automation:** Supabase `pg_cron` (runs a background sync every 6 hours)

## Environment Variables

### 1. Frontend Environment (`.env` in the root folder)
Used by Vercel and the React app.

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id
```

### 2. Backend Environment (`supabase/.env` in the `supabase` folder)
Used locally for development, and injected directly into Supabase Cloud Secrets.

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GEMINI_API_KEY=your_gemini_api_key
```

## Google Cloud Setup (OAuth)

1. Go to Google Cloud Console.
2. Enable the **Gmail API**.
3. Setup the **OAuth Consent Screen**:
   - Scopes required: `https://www.googleapis.com/auth/gmail.readonly` and `email profile`.
4. Create an **OAuth 2.0 Client ID** (Web application).
5. **Authorized JavaScript origins:**
   - `http://localhost:5173`
   - `https://your-vercel-domain.vercel.app`
6. **Authorized redirect URIs:**
   - `http://localhost:5173`
   - `https://your-vercel-domain.vercel.app`
   - `https://your-supabase-project.supabase.co/functions/v1/oauth-callback` (For linking secondary accounts)

## Supabase Configuration

### Database Schema
The database uses two primary tables (`users` and `linked_accounts`) and one `expenses` table. Row Level Security (RLS) is disabled for this MVP to allow seamless background syncing.

### Edge Functions
The backend relies on two Deno Edge Functions hosted on Supabase:
1. `sync-emails`: Connects to Gmail, fetches up to 100 recent receipts per linked account, passes them to Gemini for parsing, and upserts them into the database.
2. `oauth-callback`: A custom OAuth callback route to handle linking secondary Gmail accounts natively.

To deploy edge functions:
```bash
npx supabase functions deploy
```

### Cloud Secrets
The Edge Functions require the backend `.env` variables to be securely injected into Supabase.
```bash
npx supabase secrets set --env-file supabase/.env
npx supabase secrets set GOOGLE_CLIENT_ID="your_google_client_id"
```

### Automated Cron Job (Background Syncing)
We use Supabase's `pg_cron` and `pg_net` extensions to automatically trigger the `sync-emails` Edge Function every 6 hours, completely bypassing the need for a manual "Sync" button.

```sql
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule('6-hour-sync', '0 */6 * * *', $$ 
  SELECT net.http_post(
    url:='https://your-supabase-project.supabase.co/functions/v1/sync-emails', 
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb, 
    body:='{}'::jsonb
  ); 
$$);
```

## Deployment (Vercel)

1. Ensure your `.env` files are ignored by Git.
2. Push the entire repository to GitHub.
3. Import the repository into Vercel.
4. Go to **Settings > Environment Variables** in Vercel.
5. Add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_GOOGLE_CLIENT_ID`.
6. Click **Deploy**.
7. Update Google Cloud and Supabase Auth settings with the new live Vercel URL.
