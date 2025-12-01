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
    console.log('google-oauth-callback: Request received');
    
    // Get parameters from URL (Google redirects with query params)
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    console.log('google-oauth-callback: Params:', { 
      hasCode: !!code, 
      hasState: !!state, 
      error 
    });

    if (error) {
      console.error('google-oauth-callback: OAuth error from Google:', error);
      // Redirect to app with error
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `${Deno.env.get('SUPABASE_URL')}/auth/callback?error=${encodeURIComponent(error)}`,
        },
      });
    }

    if (!code || !state) {
      throw new Error('Missing authorization code or state');
    }

    // Parse state to get user info and services
    // Handle multiple formats for backward compatibility:
    // 1. JWT token from GoTrue (Supabase Auth) - redirect to GoTrue callback
    // 2. JWT token with our custom payload
    // 3. URL-encoded base64
    // 4. Plain base64
    // 5. URL-safe base64 (with - and _ instead of + and /)
    let stateData;
    try {
      // First, try URL-decoding the state (Google may URL-encode it)
      let decodedState = state;
      try {
        decodedState = decodeURIComponent(state);
      } catch {
        // State wasn't URL-encoded, use as-is
      }
      
      console.log('google-oauth-callback: Raw state value:', decodedState.substring(0, 50) + '...');
      
      // Check if state is a JWT token (has 3 parts separated by dots)
      const jwtParts = decodedState.split('.');
      if (jwtParts.length === 3) {
        console.log('google-oauth-callback: Detected JWT format, extracting payload');
        // JWT format: header.payload.signature
        // We need to decode the payload (middle part)
        let payload = jwtParts[1];
        
        // JWT uses URL-safe base64, convert to standard base64
        payload = payload.replace(/-/g, '+').replace(/_/g, '/');
        
        // Add padding if needed
        const padding = payload.length % 4;
        if (padding) {
          payload += '='.repeat(4 - padding);
        }
        
        const jsonString = atob(payload);
        stateData = JSON.parse(jsonString);
        console.log('google-oauth-callback: JWT payload decoded successfully');
        console.log('google-oauth-callback: State decoded, keys:', Object.keys(stateData));
        
        // Check if this is a GoTrue JWT (has provider, site_url, flow_state_id)
        // This means the OAuth was initiated by Supabase Auth, not our custom integration
        if (stateData.provider && stateData.site_url && stateData.flow_state_id) {
          console.log('google-oauth-callback: Detected GoTrue OAuth flow, redirecting to GoTrue callback');
          
          // Redirect to GoTrue's callback endpoint with original params
          const gotrueCallbackUrl = new URL(`${Deno.env.get('SUPABASE_URL')}/auth/v1/callback`);
          gotrueCallbackUrl.searchParams.set('code', code);
          gotrueCallbackUrl.searchParams.set('state', state);
          
          return new Response(null, {
            status: 302,
            headers: {
              'Location': gotrueCallbackUrl.toString(),
            },
          });
        }
      } else {
        // Not a JWT, try as regular base64
        console.log('google-oauth-callback: Treating as regular base64');
        
        // Convert URL-safe base64 to standard base64 if needed
        let base64State = decodedState
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        
        // Add padding if missing (base64 should be divisible by 4)
        const padding = base64State.length % 4;
        if (padding) {
          base64State += '='.repeat(4 - padding);
        }
        
        const jsonString = atob(base64State);
        stateData = JSON.parse(jsonString);
        console.log('google-oauth-callback: State decoded, keys:', Object.keys(stateData));
      }
    } catch (e) {
      console.error('google-oauth-callback: Failed to parse state:', e);
      console.error('google-oauth-callback: Full raw state value:', state);
      throw new Error('Invalid state parameter');
    }
    
    // Validate that we have our custom state data (not GoTrue)
    if (!stateData.userId || !stateData.organizationId || !stateData.services) {
      console.error('google-oauth-callback: Missing required state fields. Got keys:', Object.keys(stateData));
      throw new Error('Invalid state: missing userId, organizationId, or services. This callback is for Google integrations, not authentication.');
    }
    
    const { userId, organizationId, services, scopes } = stateData;
    console.log('google-oauth-callback: Parsed state:', { userId, organizationId, services });

    // Check for required env vars
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    
    if (!clientId || !clientSecret) {
      console.error('google-oauth-callback: Missing Google credentials');
      throw new Error('Google OAuth not configured. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.');
    }

    // Exchange code for tokens
    console.log('google-oauth-callback: Exchanging code for tokens');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-oauth-callback`,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('google-oauth-callback: Token exchange failed:', errorText);
      throw new Error(`Failed to exchange code: ${errorText}`);
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in, scope } = tokens;
    
    console.log('google-oauth-callback: Tokens received, expires_in:', expires_in);
    
    // Use actual granted scopes from Google
    const grantedScopes = scope ? scope.split(' ') : scopes;

    // Get user info from Google
    console.log('google-oauth-callback: Fetching user info');
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userInfoResponse.ok) {
      const errorText = await userInfoResponse.text();
      console.error('google-oauth-callback: Failed to get user info:', errorText);
      throw new Error('Failed to get user info');
    }

    const userInfo = await userInfoResponse.json();
    console.log('google-oauth-callback: User info received:', userInfo.email);

    // Initialize Supabase admin client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Encrypt tokens using pgcrypto
    console.log('google-oauth-callback: Encrypting tokens');
    const { data: encryptedAccess, error: encryptAccessError } = await supabase.rpc('encrypt_api_key', {
      p_api_key: access_token,
    });

    if (encryptAccessError) {
      console.error('google-oauth-callback: Failed to encrypt access token:', encryptAccessError);
      throw new Error('Failed to encrypt access token');
    }

    const { data: encryptedRefresh, error: encryptRefreshError } = await supabase.rpc('encrypt_api_key', {
      p_api_key: refresh_token || '',
    });

    if (encryptRefreshError) {
      console.error('google-oauth-callback: Failed to encrypt refresh token:', encryptRefreshError);
      throw new Error('Failed to encrypt refresh token');
    }

    // Calculate token expiration
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    console.log('google-oauth-callback: Upserting integration to database');
    // Upsert google integration
    const { error: upsertError } = await supabase
      .from('google_integrations')
      .upsert({
        user_id: userId,
        organization_id: organizationId,
        google_email: userInfo.email,
        scopes: grantedScopes,
        gmail_enabled: services.includes('gmail'),
        calendar_enabled: services.includes('calendar'),
        drive_enabled: services.includes('drive'),
        access_token_encrypted: encryptedAccess,
        refresh_token_encrypted: encryptedRefresh,
        token_expires_at: expiresAt,
        is_active: true,
      }, {
        onConflict: 'user_id,organization_id',
      });

    if (upsertError) {
      console.error('google-oauth-callback: Database upsert failed:', upsertError);
      throw upsertError;
    }

    console.log('google-oauth-callback: Integration saved successfully');

    // Return HTML that closes the popup and notifies the parent
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Authorization Complete</title>
          <style>
            body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f9fafb; }
            .container { text-align: center; padding: 2rem; }
            .success { color: #059669; font-size: 1.25rem; margin-bottom: 1rem; }
            .email { color: #6b7280; margin-bottom: 1rem; }
            .closing { color: #9ca3af; font-size: 0.875rem; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✓ Authorization successful!</div>
            <div class="email">${userInfo.email}</div>
            <div class="closing">This window will close automatically...</div>
          </div>
          <script>
            (function() {
              // Try to notify parent window
              try {
                if (window.opener && !window.opener.closed) {
                  window.opener.postMessage({ 
                    type: 'google-oauth-success', 
                    email: '${userInfo.email}' 
                  }, '*');
                }
              } catch (e) {
                console.log('Could not notify parent window:', e);
              }
              
              // Try to close the window
              setTimeout(function() {
                try {
                  window.close();
                } catch (e) {
                  console.log('Could not close window:', e);
                }
              }, 1500);
              
              // If window.close() doesn't work after 3 seconds, show manual close message
              setTimeout(function() {
                if (!window.closed) {
                  document.querySelector('.closing').textContent = 'Please close this window manually and refresh the integrations page.';
                }
              }, 3000);
            })();
          </script>
        </body>
      </html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });

  } catch (error) {
    console.error('google-oauth-callback: Error:', error);
    
    // Return HTML with error that closes the popup
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Authorization Failed</title>
          <style>
            body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #fef2f2; }
            .container { text-align: center; padding: 2rem; }
            .error { color: #dc2626; font-size: 1.25rem; margin-bottom: 1rem; }
            .message { color: #6b7280; margin-bottom: 1rem; }
            .closing { color: #9ca3af; font-size: 0.875rem; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">✗ Authorization failed</div>
            <div class="message">${errorMessage}</div>
            <div class="closing">This window will close automatically...</div>
          </div>
          <script>
            (function() {
              // Try to notify parent window
              try {
                if (window.opener && !window.opener.closed) {
                  window.opener.postMessage({ 
                    type: 'google-oauth-error', 
                    error: '${errorMessage}' 
                  }, '*');
                }
              } catch (e) {
                console.log('Could not notify parent window:', e);
              }
              
              // Try to close the window
              setTimeout(function() {
                try {
                  window.close();
                } catch (e) {
                  console.log('Could not close window:', e);
                }
              }, 1500);
              
              // If window.close() doesn't work after 3 seconds, show manual close message
              setTimeout(function() {
                if (!window.closed) {
                  document.querySelector('.closing').textContent = 'Please close this window manually.';
                }
              }, 3000);
            })();
          </script>
        </body>
      </html>
    `;
    
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
      status: 500,
    });
  }
});
