import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const token = authHeader.replace('Bearer ', '').trim();
    const isCron = token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    let targetUserId = null;

    if (!isCron) {
      // 1. Triggered by a specific user in the browser
      const supabaseClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      );
      
      const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
      if (userErr || !user) {
        console.error("Auth error:", userErr);
        throw new Error("Invalid user token");
      }
      targetUserId = user.id;
    }

    // Initialize admin client
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' 
    );

    // 2. Fetch linked accounts (if targetUserId is set, only fetch for them; else fetch ALL users for cron)
    let query = adminClient.from('linked_accounts').select('*');
    if (targetUserId) {
      query = query.eq('user_id', targetUserId);
    }
    
    const { data: accounts, error: accountErr } = await query;

    if (accountErr || !accounts || accounts.length === 0) {
      throw new Error("No linked accounts found");
    }

    const expensesToInsert = [];
    let totalProcessedEmails = 0;
    
    // 3. Process every linked account
    for (const account of accounts) {
      if (!account.google_refresh_token) continue;

      try {
        // Refresh Google Access Token
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
            client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
            refresh_token: account.google_refresh_token,
            grant_type: 'refresh_token',
          })
        });
        
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) {
          console.error(`Failed to refresh Google token for account ${account.email_address}`);
          continue;
        }
        
        const accessToken = tokenData.access_token;

        // Fetch up to 100 emails
        const searchQuery = encodeURIComponent("receipt OR invoice OR order OR paid OR booking OR debited OR transaction OR spent OR UPI OR Swiggy OR Zomato OR Amazon OR Flipkart OR HDFC OR SBI");
        const messagesRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${searchQuery}&maxResults=100`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const messagesData = await messagesRes.json();
        const messages = messagesData.messages || [];
        totalProcessedEmails += messages.length;

        // Process each email
        for (const msg of messages) {
          const { data: existing } = await adminClient
            .from('expenses')
            .select('id')
            .eq('email_message_id', msg.id)
            .single();
            
          if (existing) continue; // Skip to next email

          const emailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          const emailData = await emailRes.json();
          
          const emailSnippet = emailData.snippet;
          const subjectHeader = emailData.payload.headers.find((h: any) => h.name === 'Subject')?.value || '';
          const dateHeader = emailData.payload.headers.find((h: any) => h.name === 'Date')?.value || '';

          const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
          if (!geminiApiKey) throw new Error("Gemini API key missing.");

          const prompt = `
            Analyze this email snippet and subject line to determine if it is a purchase receipt, invoice, or expense.
            If it is, extract the merchant name, total amount, currency (e.g. INR), and a general category.
            
            CRITICAL RULES:
            1. If you cannot confidently find a monetary amount, return {"is_expense": false}.
            2. If the email is about a CREDIT CARD BILL PAYMENT or REPAYMENT (e.g., from CRED, or a bank acknowledging a credit card bill payment), return {"is_expense": false}. We only want to track actual purchases, to avoid double-counting.
            
            Subject: ${subjectHeader}
            Snippet: ${emailSnippet}
            
            Respond ONLY with a valid JSON object matching this exact schema, with no markdown formatting:
            {
              "is_expense": boolean,
              "amount": number (or null),
              "currency": string (or null),
              "merchant": string (or null),
              "category": string (or null)
            }
          `;

          const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });
          
          const geminiData = await geminiRes.json();
          try {
            const textResponse = geminiData.candidates[0].content.parts[0].text;
            const jsonStr = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(jsonStr);

            if (parsed.is_expense && parsed.amount) {
              expensesToInsert.push({
                user_id: account.user_id,
                linked_account_id: account.id,
                amount: parsed.amount,
                currency: parsed.currency || 'USD',
                merchant: parsed.merchant || 'Unknown',
                category: parsed.category || 'Other',
                date: new Date(dateHeader).toISOString(),
                email_message_id: msg.id
              });
            }
          } catch (e) {
            console.error("Failed to parse Gemini response for email", msg.id);
          }
        }
      } catch (err) {
        console.error(`Error processing account ${account.email_address}:`, err);
      }
    }

    // Bulk insert the new expenses
    if (expensesToInsert.length > 0) {
      const { error: insertErr } = await adminClient
        .from('expenses')
        .insert(expensesToInsert);
        
      if (insertErr) throw insertErr;
    }

    return new Response(JSON.stringify({ 
      success: true, 
      processed_emails: totalProcessedEmails,
      new_expenses_found: expensesToInsert.length 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
