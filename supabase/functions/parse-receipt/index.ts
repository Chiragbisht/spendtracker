import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    // Authenticate user
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser(token);
    if (userErr || !user) throw new Error('Invalid user token');

    // Parse request body — expects { imageBase64: string, mimeType: string }
    const body = await req.json();
    const { imageBase64, mimeType } = body;

    if (!imageBase64) throw new Error('Missing imageBase64 in request body');

    const validMime = mimeType && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)
      ? mimeType
      : 'image/jpeg';

    // Call Gemini Vision API
    const prompt = `You are an expert at reading receipts, bills, invoices, bank SMS screenshots, and payment confirmations.

Analyze this image carefully and extract ALL expense transactions you can find.

Return a JSON array (even if just one item) with each expense as:
{
  "amount": <number — the total amount paid, no commas>,
  "currency": <"INR" or "USD" etc.>,
  "merchant": <string — shop/brand/merchant name>,
  "category": <one of: Food, Transport, Shopping, Entertainment, Utilities, Health, Travel, Other>,
  "date": <"YYYY-MM-DD" — use today if not found>
}

If no expense found, return an empty array [].
Do NOT include markdown fences, only return raw JSON.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${Deno.env.get('GEMINI_API_KEY')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: validMime,
                  data: imageBase64
                }
              }
            ]
          }]
        })
      }
    );

    const aiData = await geminiRes.json();

    if (aiData.error) {
      console.error('Gemini API Error:', aiData.error);
      throw new Error('Gemini API error: ' + (aiData.error.message || JSON.stringify(aiData.error)));
    }

    const rawText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    // Strip markdown fences if any
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let expenses: any[] = [];
    try {
      const parsed = JSON.parse(cleaned);
      expenses = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Try to find an array in the text
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        expenses = JSON.parse(arrayMatch[0]);
      }
    }

    // Filter out invalid entries
    expenses = expenses.filter(e => e.amount && Number(e.amount) > 0);

    // Insert them into the database
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const today = new Date().toISOString().split('T')[0];
    const toInsert = expenses.map(e => ({
      user_id: user.id,
      amount: Number(e.amount),
      currency: e.currency || 'INR',
      merchant: e.merchant || 'Unknown',
      category: e.category || 'Other',
      date: e.date ? `${e.date}T00:00:00Z` : `${today}T00:00:00Z`,
    }));

    if (toInsert.length > 0) {
      const { error: insertErr } = await adminClient.from('expenses').insert(toInsert);
      if (insertErr) throw insertErr;
    }

    return new Response(
      JSON.stringify({ success: true, expenses_added: toInsert.length, expenses: toInsert }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (err: any) {
    console.error('Parse Receipt Error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Unknown error', details: err.stack }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  }
})
