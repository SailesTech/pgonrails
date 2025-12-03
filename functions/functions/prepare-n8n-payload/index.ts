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

    // Parse request body
    const { meeting_id } = await req.json();

    if (!meeting_id) {
      throw new Error('meeting_id is required');
    }

    console.log('prepare-n8n-payload: Preparing payload for meeting:', meeting_id);

    // 1. Fetch meeting with all related data
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select(`
        id,
        organization_id,
        user_id,
        meeting_type_id,
        title,
        meeting_date,
        duration,
        transcript,
        webhook_metadata,
        webhook_source,
        meeting_types (
          id,
          name,
          description,
          success_criteria,
          script_guidelines,
          meeting_type_attributes (
            attribute_key,
            attribute_value,
            order_index
          ),
          meeting_type_checkpoints (
            checkpoint_text,
            order_index
          ),
          meeting_type_criteria_strings (
            criterion_text,
            order_index
          )
        )
      `)
      .eq('id', meeting_id)
      .single();

    if (meetingError || !meeting) {
      throw new Error(`Meeting not found: ${meetingError?.message}`);
    }

    // Fetch user profile separately
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('id, email, first_name, last_name, email_signature')
      .eq('id', meeting.user_id)
      .single();

    // Fetch organization context
    const { data: organizationContext } = await supabase
      .from('organization_context')
      .select('company_name, company_description, product_name, product_description, target_audience, value_propositions, common_objections')
      .eq('organization_id', meeting.organization_id)
      .maybeSingle();

    console.log('prepare-n8n-payload: Meeting loaded for org:', meeting.organization_id);
    if (organizationContext) {
      console.log('prepare-n8n-payload: Organization context loaded');
    }

    // 1b. Fetch ALL meeting types for the organization (not just the one assigned to this meeting)
    const { data: allMeetingTypes, error: mtError } = await supabase
      .from('meeting_types')
      .select(`
        id,
        name,
        description,
        is_default,
        success_criteria,
        script_guidelines,
        meeting_type_attributes (
          attribute_key,
          attribute_value,
          order_index
        ),
        meeting_type_checkpoints (
          checkpoint_text,
          order_index
        ),
        meeting_type_criteria_strings (
          criterion_text,
          order_index
        )
      `)
      .eq('organization_id', meeting.organization_id)
      .order('name');

    if (mtError) {
      console.error('prepare-n8n-payload: Error loading meeting types:', mtError);
      throw mtError;
    }

    console.log('prepare-n8n-payload: Loaded', allMeetingTypes?.length || 0, 'meeting types');

    // 1c. Fetch Pipedrive scenarios for all meeting types
    const { data: pipedriveScenarios, error: pipedriveError } = await supabase
      .from('pipedrive_scenarios')
      .select('meeting_type_id, pipeline_id, stage_id, deal_status, order_index')
      .eq('organization_id', meeting.organization_id)
      .eq('is_active', true)
      .order('order_index');

    if (pipedriveError) {
      console.warn('prepare-n8n-payload: Error loading Pipedrive scenarios:', pipedriveError);
    }

    console.log('prepare-n8n-payload: Loaded', pipedriveScenarios?.length || 0, 'Pipedrive scenarios');

    // 1c2. Fetch Livespace scenarios for all meeting types
    const { data: livespaceScenarios, error: livespaceError } = await supabase
      .from('livespace_scenarios')
      .select('meeting_type_id, process_id, stage_id, deal_status, order_index')
      .eq('organization_id', meeting.organization_id)
      .eq('is_active', true)
      .order('order_index');

    if (livespaceError) {
      console.warn('prepare-n8n-payload: Error loading Livespace scenarios:', livespaceError);
    }

    console.log('prepare-n8n-payload: Loaded', livespaceScenarios?.length || 0, 'Livespace scenarios');

    // 1d. Map scenarios to meeting types
    const meetingTypesWithScenarios = (allMeetingTypes || []).map((mt: any) => ({
      id: mt.id,
      name: mt.name,
      description: mt.description,
      is_default: mt.is_default,
      script_guidelines: mt.script_guidelines,
      success_criteria: mt.success_criteria,
      attributes: (mt.meeting_type_attributes || [])
        .sort((a: any, b: any) => a.order_index - b.order_index)
        .map((a: any) => ({ key: a.attribute_key, value: a.attribute_value })),
      checkpoints: (mt.meeting_type_checkpoints || [])
        .sort((a: any, b: any) => a.order_index - b.order_index)
        .map((c: any) => c.checkpoint_text),
      criteria_strings: (mt.meeting_type_criteria_strings || [])
        .sort((a: any, b: any) => a.order_index - b.order_index)
        .map((c: any) => c.criterion_text),
      pipedrive_scenarios: (pipedriveScenarios || [])
        .filter((s: any) => s.meeting_type_id === mt.id)
        .map((s: any) => ({
          pipeline_id: s.pipeline_id,
          stage_id: s.stage_id,
          deal_status: s.deal_status,
          order_index: s.order_index,
        })),
      livespace_scenarios: (livespaceScenarios || [])
        .filter((s: any) => s.meeting_type_id === mt.id)
        .map((s: any) => ({
          process_id: s.process_id,
          stage_id: s.stage_id,
          deal_status: s.deal_status,
          order_index: s.order_index,
        })),
    }));

    console.log('prepare-n8n-payload: Meeting types with scenarios prepared');

    // 2. Generate callback token (secure random)
    const callbackToken = crypto.randomUUID() + '-' + Date.now();
    const baseUrl = supabaseUrl.replace('.supabase.co', '.supabase.co/functions/v1');
    const callbackUrl = `${baseUrl}/n8n-callback`;

    // Update meeting with callback token
    await supabase
      .from('meetings')
      .update({ n8n_callback_token: callbackToken })
      .eq('id', meeting_id);

    // 3. Prepare integrations object
    const integrations: any = {};

    // 3a. Get CRM integration (Pipedrive or Livespace)
    const { data: crmIntegration } = await supabase
      .from('crm_integrations')
      .select(`
        id,
        platform,
        crm_credentials (
          api_key_encrypted,
          api_secret_encrypted,
          domain
        )
      `)
      .eq('organization_id', meeting.organization_id)
      .eq('status', 'connected')
      .maybeSingle();

    if (crmIntegration && crmIntegration.crm_credentials) {
      const credentials = crmIntegration.crm_credentials as any;
      
      if (crmIntegration.platform === 'pipedrive') {
        console.log('prepare-n8n-payload: Found Pipedrive integration');

        // Decrypt Pipedrive API key
        const { data: apiKey, error: decryptError } = await supabase.rpc('decrypt_api_key', {
          p_encrypted_key: credentials.api_key_encrypted,
        });

        if (!decryptError && apiKey) {
          integrations.pipedrive = {
            api_key: apiKey,
            deal_id: meeting.webhook_metadata?.deal_id || null,
          };
          console.log('prepare-n8n-payload: Pipedrive API key decrypted');
        } else {
          console.warn('prepare-n8n-payload: Failed to decrypt Pipedrive API key');
        }
      } else if (crmIntegration.platform === 'livespace') {
        console.log('prepare-n8n-payload: Found Livespace integration');

        // Decrypt Livespace API key and secret
        const { data: apiKey, error: keyError } = await supabase.rpc('decrypt_api_key', {
          p_encrypted_key: credentials.api_key_encrypted,
        });
        const { data: apiSecret, error: secretError } = await supabase.rpc('decrypt_api_key', {
          p_encrypted_key: credentials.api_secret_encrypted,
        });

        if (!keyError && !secretError && apiKey && apiSecret) {
          integrations.livespace = {
            api_key: apiKey,
            api_secret: apiSecret,
            domain: credentials.domain,
            deal_id: meeting.webhook_metadata?.deal_id || null,
          };
          console.log('prepare-n8n-payload: Livespace credentials decrypted');
        } else {
          console.warn('prepare-n8n-payload: Failed to decrypt Livespace credentials');
        }
      }
    }

    // 3b. Get Fireflies credentials if exists
    const { data: firefliesCredential } = await supabase
      .from('fireflies_credentials')
      .select('api_key_encrypted')
      .eq('user_id', meeting.user_id)
      .eq('organization_id', meeting.organization_id)
      .eq('is_active', true)
      .maybeSingle();

    if (firefliesCredential && firefliesCredential.api_key_encrypted) {
      console.log('prepare-n8n-payload: Found Fireflies credentials');

      // Decrypt Fireflies API key using pgcrypto (same as Pipedrive)
      const { data: apiKey, error: decryptError } = await supabase.rpc('decrypt_api_key', {
        p_encrypted_key: firefliesCredential.api_key_encrypted,
      });

      if (!decryptError && apiKey) {
        integrations.fireflies = {
          api_key: apiKey,
        };
        console.log('prepare-n8n-payload: Fireflies API key decrypted');
      } else {
        console.warn('prepare-n8n-payload: Failed to decrypt Fireflies API key');
      }
    }

    // 3c. Get Telnyx credentials if exists
    const { data: telnyxCredential } = await supabase
      .from('telnyx_credentials')
      .select('api_key_encrypted')
      .eq('user_id', meeting.user_id)
      .eq('organization_id', meeting.organization_id)
      .eq('is_active', true)
      .maybeSingle();

    if (telnyxCredential && telnyxCredential.api_key_encrypted) {
      console.log('prepare-n8n-payload: Found Telnyx credentials');

      // Decrypt Telnyx API key
      const { data: apiKey, error: decryptError } = await supabase.rpc('decrypt_api_key', {
        p_encrypted_key: telnyxCredential.api_key_encrypted,
      });

      if (!decryptError && apiKey) {
        integrations.telnyx = {
          api_key: apiKey,
        };
        console.log('prepare-n8n-payload: Telnyx API key decrypted');
      } else {
        console.warn('prepare-n8n-payload: Failed to decrypt Telnyx API key');
      }
    }

    // 3d. Get Google integrations (Gmail, Calendar, Drive) if exists
    const { data: googleIntegration } = await supabase
      .from('google_integrations')
      .select(`
        google_email,
        gmail_enabled,
        calendar_enabled,
        drive_enabled,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        scopes
      `)
      .eq('user_id', meeting.user_id)
      .eq('organization_id', meeting.organization_id)
      .eq('is_active', true)
      .maybeSingle();

    if (googleIntegration) {
      console.log('prepare-n8n-payload: Found Google integration');

      // Check if token needs refresh BEFORE decrypting
      const expiresAt = googleIntegration.token_expires_at ? new Date(googleIntegration.token_expires_at) : null;
      const now = new Date();
      const shouldRefresh = !expiresAt || (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000);

      let currentAccessToken = null;

      if (shouldRefresh) {
        console.log('prepare-n8n-payload: Token expired or expiring soon, refreshing...');
        
        // Decrypt refresh token
        const { data: refreshToken, error: decryptRefreshError } = await supabase.rpc('decrypt_api_key', {
          p_encrypted_key: googleIntegration.refresh_token_encrypted,
        });

        if (!decryptRefreshError && refreshToken) {
          try {
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

            if (refreshResponse.ok) {
              const refreshData = await refreshResponse.json();
              currentAccessToken = refreshData.access_token;
              const newExpiresIn = refreshData.expires_in || 3600;
              const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();

              console.log('prepare-n8n-payload: Token refreshed successfully, expires at:', newExpiresAt);

              // Encrypt and save new access token
              const { data: newEncryptedAccess } = await supabase.rpc('encrypt_api_key', {
                p_api_key: currentAccessToken,
              });

              if (newEncryptedAccess) {
                await supabase
                  .from('google_integrations')
                  .update({
                    access_token_encrypted: newEncryptedAccess,
                    token_expires_at: newExpiresAt,
                  })
                  .eq('user_id', meeting.user_id)
                  .eq('organization_id', meeting.organization_id);
                
                console.log('prepare-n8n-payload: New token saved to database');
              }
            } else {
              const errorText = await refreshResponse.text();
              console.error('prepare-n8n-payload: Token refresh failed:', errorText);
            }
          } catch (refreshError) {
            console.error('prepare-n8n-payload: Error refreshing token:', refreshError);
          }
        } else {
          console.warn('prepare-n8n-payload: Failed to decrypt refresh token');
        }
      }

      // If we didn't refresh (token still valid), decrypt the existing token
      if (!currentAccessToken) {
        const { data: accessToken, error: decryptAccessError } = await supabase.rpc('decrypt_api_key', {
          p_encrypted_key: googleIntegration.access_token_encrypted,
        });

        if (decryptAccessError || !accessToken) {
          console.warn('prepare-n8n-payload: Failed to decrypt Google access token');
        } else {
          currentAccessToken = accessToken;
        }
      }

      // Send valid access token to n8n
      if (currentAccessToken) {
        integrations.google = {
          email: googleIntegration.google_email,
          gmail_enabled: googleIntegration.gmail_enabled,
          calendar_enabled: googleIntegration.calendar_enabled,
          drive_enabled: googleIntegration.drive_enabled,
          scopes: googleIntegration.scopes,
          access_token: currentAccessToken,
        };
        console.log('prepare-n8n-payload: Google integration with fresh access token added');
      } else {
        console.warn('prepare-n8n-payload: Could not get valid access token for Google integration');
      }
    }

    // 4. Build complete payload for N8N
    const payload = {
      meeting_id: meeting.id,
      callback_url: callbackUrl,
      callback_token: callbackToken,
      // Send ALL meeting types with their Pipedrive scenarios
      // N8N can choose the right one based on pipeline_id/stage_id from deal
      meeting_types: meetingTypesWithScenarios,
      // Keep current meeting_type_id for reference (if one was assigned)
      current_meeting_type_id: meeting.meeting_type_id,
      // Include raw webhook data for N8N to handle source-specific logic (Fireflies, Unitalk, etc.)
      // N8N will extract transcript, title, duration etc. from this based on the source
      raw_webhook_data: meeting.webhook_metadata || null,
      webhook_source: meeting.webhook_source || 'unknown',
      integrations,
      user: {
        id: meeting.user_id,
        email: userProfile?.email || null,
        full_name: userProfile ? `${userProfile.first_name || ''} ${userProfile.last_name || ''}`.trim() : null,
        email_signature: userProfile?.email_signature || null,
        email_signature_html: userProfile?.email_signature 
          ? userProfile.email_signature
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/\n/g, '<br>')
          : null,
      },
      organization_id: meeting.organization_id,
      organization_context: organizationContext || null,
    };

    console.log('prepare-n8n-payload: Payload prepared successfully');
    console.log('prepare-n8n-payload: Integrations available:', Object.keys(integrations));

    return new Response(
      JSON.stringify({
        success: true,
        payload,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('prepare-n8n-payload error:', error);
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
