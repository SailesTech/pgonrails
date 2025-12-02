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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { user_id, organization_id } = await req.json();

    if (!user_id || !organization_id) {
      throw new Error('user_id and organization_id are required');
    }

    console.log('refresh-google-token: Refreshing token for user:', user_id);

    // Get current integration
    const { data: integration, error: integrationError } = await supabase
      .from('google_integrations')
      .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
      .eq('user_id', user_id)
      .eq('organization_id', organization_id)
      .eq('is_active', true)
      .single();

    if (integrationError || !integration) {
      throw new Error('Google integration not found');
    }

    // Check if token needs refresh (within 5 minutes of expiry)
    const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at) : null;
    const now = new Date();
    const shouldRefresh = !expiresAt || (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000);

    if (!shouldRefresh) {
      // Token still valid, decrypt and return
      const { data: accessToken } = await supabase.rpc('decrypt_api_key', {
        p_encrypted_key: integration.access_token_encrypted,
      });

      return new Response(
        JSON.stringify({
          success: true,
          access_token: accessToken,
          refreshed: false,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );
    }

    // Decrypt refresh token
    const { data: refreshToken, error: decryptError } = await supabase.rpc('decrypt_api_key', {
      p_encrypted_key: integration.refresh_token_encrypted,
    });

    if (decryptError || !refreshToken) {
      throw new Error('Failed to decrypt refresh token');
    }

    // Refresh the token
    const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')!;
    const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
    
    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text();
      console.error('refresh-google-token: Token refresh failed:', errorText);
      throw new Error('Token refresh failed');
    }

    const refreshData = await refreshResponse.json();
    const newAccessToken = refreshData.access_token;
    const newExpiresIn = refreshData.expires_in || 3600;
    const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();

    console.log('refresh-google-token: Token refreshed successfully');

    // Encrypt and save new access token
    const { data: newEncryptedAccess } = await supabase.rpc('encrypt_api_key', {
      p_api_key: newAccessToken,
    });

    if (!newEncryptedAccess) {
      throw new Error('Failed to encrypt new access token');
    }

    await supabase
      .from('google_integrations')
      .update({
        access_token_encrypted: newEncryptedAccess,
        token_expires_at: newExpiresAt,
      })
      .eq('user_id', user_id)
      .eq('organization_id', organization_id);
    
    console.log('refresh-google-token: New token saved to database');

    return new Response(
      JSON.stringify({
        success: true,
        access_token: newAccessToken,
        refreshed: true,
        expires_at: newExpiresAt,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('refresh-google-token error:', error);
    const message = (error && (error as any).message) || 'Unknown error';
    return new Response(
      JSON.stringify({
        success: false,
        error: message,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
