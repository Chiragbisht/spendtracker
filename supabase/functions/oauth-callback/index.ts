import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state'); // This contains the user_id
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  try {
    // 1. Exchange the code for a refresh token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
        code: code,
        grant_type: 'authorization_code',
        // The redirect_uri MUST match exactly what we send from the frontend
        redirect_uri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/oauth-callback`,
      })
    });
    
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    
    if (!tokenData.refresh_token) {
      // If we don't get a refresh token, it means they previously authorized. 
      // They need to revoke access first, but for now we'll just throw an error.
      throw new Error("No refresh token received. You may need to remove the app from your Google Account settings and try again.");
    }

    // 2. Get the user's email address using the access token
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profileData = await profileRes.json();
    const emailAddress = profileData.email;

    // 3. Save to database using Service Role Key
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' 
    );

    // Check if the account is already linked
    const { data: existingAccount } = await supabaseClient
      .from('linked_accounts')
      .select('id')
      .eq('email_address', emailAddress)
      .maybeSingle();

    let dbErr;
    if (existingAccount) {
      // Update existing account
      const { error } = await supabaseClient
        .from('linked_accounts')
        .update({ google_refresh_token: tokenData.refresh_token })
        .eq('id', existingAccount.id);
      dbErr = error;
    } else {
      // Insert new account
      const { error } = await supabaseClient
        .from('linked_accounts')
        .insert({
           user_id: state,
           email_address: emailAddress,
           google_refresh_token: tokenData.refresh_token
        });
      dbErr = error;
    }

    if (dbErr) throw dbErr;

    // 4. Redirect the user back to the frontend dashboard!
    // Since we don't know the exact frontend URL (localhost vs production), we'll try to infer it,
    // but for this MVP, we can redirect to localhost or a success message.
    // Let's return a simple HTML page that closes itself and reloads the parent window.
    const html = `
      <html>
        <body>
          <h2>Account Linked Successfully!</h2>
          <p>You can close this window and refresh your dashboard.</p>
          <script>
            setTimeout(() => {
              if (window.opener) {
                window.opener.location.reload();
                window.close();
              } else {
                window.location.href = 'http://localhost:5173';
              }
            }, 1500);
          </script>
        </body>
      </html>
    `;
    
    return new Response(html, {
      status: 200,
      headers: new Headers({ 
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      })
    });

  } catch (err: any) {
    return new Response(`Error linking account: ${err.message}`, { status: 400 });
  }
})
