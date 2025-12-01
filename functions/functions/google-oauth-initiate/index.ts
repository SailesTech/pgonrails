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
    const { services } = await req.json();

    if (!services || services.length === 0) {
      throw new Error('No services specified');
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
      global: { headers: { Authorization: authHeader } },
    });

    // Get user from JWT
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('Invalid authentication token');
    }

    // Get current organization from user_roles
    const { data: userRole } = await supabase
      .from('user_roles')
      .select('organization_id')
      .eq('user_id', user.id)
      .single();

    if (!userRole) {
      throw new Error('No organization found');
    }

    // Build scopes based on services
    const scopeMap: Record<string, string> = {
      gmail: 'https://www.googleapis.com/auth/gmail.send',
      calendar: 'https://www.googleapis.com/auth/calendar',
      drive: 'https://www.googleapis.com/auth/drive.file',
    };

    const scopes = services.map((s: string) => scopeMap[s]).filter(Boolean);
    const scopeString = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      ...scopes,
    ].join(' ');

    // Create state with user info
    // Use URL-safe base64 encoding to avoid issues with special characters
    const stateJson = JSON.stringify({
      userId: user.id,
      organizationId: userRole.organization_id,
      services,
      scopes,
    });
    // Convert to base64 and make it URL-safe by replacing + with - and / with _
    // Also remove padding = as it can cause issues in URLs
    const state = btoa(stateJson)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Build OAuth URL
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new Error('Google OAuth not configured');
    }

    const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;
    
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopeString);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return new Response(
      JSON.stringify({ auth_url: authUrl.toString() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('OAuth initiate error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
