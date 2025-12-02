import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
    );
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user } } = await authClient.auth.getUser();
    if (!user) throw new Error('Unauthorized');

    const { integration_id, endpoint, method = 'GET', body } = await req.json();
    if (!integration_id || !endpoint) throw new Error('Missing required parameters');

    // Fetch integration
    const { data: integration, error: integrationError } = await adminClient
      .from('crm_integrations')
      .select('id, organization_id')
      .eq('id', integration_id)
      .maybeSingle();
    if (integrationError || !integration) throw new Error('Integration not found');

    // Permission check: super admin OR org owner/admin
    let allowed = false;
    const { data: isSuperAdmin } = await adminClient.rpc('is_super_admin', { _user_id: user.id });
    if (isSuperAdmin === true) {
      allowed = true;
    } else {
      const { data: role } = await adminClient
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('organization_id', integration.organization_id)
        .maybeSingle();
      if (role && ['owner', 'admin'].includes(role.role)) allowed = true;
    }
    if (!allowed) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Get credentials
    const { data: cred, error: credError } = await adminClient
      .from('crm_credentials')
      .select('api_key_encrypted')
      .eq('integration_id', integration_id)
      .maybeSingle();
    if (credError || !cred || !cred.api_key_encrypted) throw new Error('Missing credentials');

    // Decrypt API key using pgcrypto
    const { data: decryptedKey, error: decryptError } = await adminClient.rpc('decrypt_api_key', {
      p_encrypted_key: cred.api_key_encrypted,
    });
    if (decryptError || !decryptedKey) throw new Error('Failed to decrypt API key');

    const apiKey = decryptedKey;

    // Build Pipedrive URL (always use global API)
    const base = 'https://api.pipedrive.com/v1';
    const url = `${base}${endpoint}${endpoint.includes('?') ? '&' : '?'}api_token=${apiKey}`;

    console.log('Pipedrive API call', { method, endpoint });

    const pdRes = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await pdRes.text();
    if (!pdRes.ok) {
      console.error('Pipedrive error', pdRes.status, text);
      return new Response(JSON.stringify({ error: 'Pipedrive API error', status: pdRes.status, details: text }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(text, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = typeof error === 'string' ? error : (error && (error as any).message) ? (error as any).message : 'Unknown error';
    console.error('pipedrive-proxy failure', message, error);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
