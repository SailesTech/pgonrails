import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { to, subject, body } = await req.json();

    if (!to || !subject || !body) {
      throw new Error('Missing required parameters: to, subject, body');
    }

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Initialize Supabase with user's auth
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Get user from JWT
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('Invalid authentication token');
    }

    // Get Google integration with access token
    const { data: integration, error: integrationError } = await supabase
      .from('google_integrations')
      .select('access_token_encrypted, gmail_enabled')
      .eq('user_id', user.id)
      .single();

    if (integrationError || !integration) {
      throw new Error('Google integration not found. Please connect Gmail first.');
    }

    if (!integration.gmail_enabled) {
      throw new Error('Gmail is not enabled. Please enable it in Integrations settings.');
    }

    // Decrypt access token
    const { data: accessToken, error: decryptError } = await supabase.rpc('decrypt_api_key', {
      p_encrypted_key: integration.access_token_encrypted,
    });

    if (decryptError || !accessToken) {
      throw new Error('Failed to decrypt access token. Please reconnect Gmail.');
    }

    console.log('Sending email from:', user.email);

    // Create email in RFC 2822 format
    const emailContent = [
      `From: ${user.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      body,
    ].join('\n');

    // Encode email in base64url format
    const encodedEmail = btoa(emailContent)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send email via Gmail API
    const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: encodedEmail,
      }),
    });

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      console.error('Gmail API error:', errorText);
      throw new Error(`Failed to send email via Gmail API: ${errorText}`);
    }

    const result = await sendResponse.json();
    console.log('Email sent successfully, message ID:', result.id);

    return new Response(
      JSON.stringify({
        success: true,
        message_id: result.id,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error sending Gmail:', error);
    
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
