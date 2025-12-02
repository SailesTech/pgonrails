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

  const startTime = Date.now();
  
  try {
    // Extract org_id from URL path
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/');
    const orgId = pathParts[pathParts.length - 1];

    if (!orgId) {
      throw new Error('Organization ID not provided in URL');
    }

    // Parse incoming payload from user endpoint
    const incomingPayload = await req.json();
    console.log('Received webhook at org endpoint for org:', orgId);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get organization's webhook endpoint configuration
    const { data: orgEndpoint, error: endpointError } = await supabase
      .from('webhook_endpoints')
      .select('id, target_url')
      .eq('organization_id', orgId)
      .eq('endpoint_type', 'organization')
      .eq('is_active', true)
      .single();

    if (endpointError || !orgEndpoint) {
      throw new Error(`Organization endpoint not found: ${endpointError?.message}`);
    }

    // Get organization's webhook target URL
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('webhook_target_url')
      .eq('id', orgId)
      .single();

    if (orgError || !org || !org.webhook_target_url) {
      throw new Error(`Organization webhook target URL not configured: ${orgError?.message}`);
    }

    // Prepare N8N payload with all credentials and meeting type
    console.log('webhook-org: Preparing N8N payload for meeting:', incomingPayload.meeting_id);

    const prepareResponse = await fetch(`${supabaseUrl}/functions/v1/prepare-n8n-payload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        meeting_id: incomingPayload.meeting_id,
      }),
    });

    if (!prepareResponse.ok) {
      const errorText = await prepareResponse.text();
      throw new Error(`Failed to prepare N8N payload: ${errorText}`);
    }

    const prepareData = await prepareResponse.json();

    if (!prepareData.success) {
      throw new Error(`Prepare payload failed: ${prepareData.error}`);
    }

    console.log('webhook-org: N8N payload prepared successfully');

    // Update meeting status to 'processing'
    await supabase
      .from('meetings')
      .update({
        processing_status: 'processing',
        processing_started_at: new Date().toISOString(),
      })
      .eq('id', incomingPayload.meeting_id);

    console.log('webhook-org: Meeting status updated to processing');

    // Forward complete payload to organization's target URL (N8N)
    console.log('webhook-org: Forwarding to N8N:', org.webhook_target_url);
    const forwardResponse = await fetch(org.webhook_target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prepareData.payload),
      signal: AbortSignal.timeout(600000), // 10 minute timeout for N8N
    });

    const responseData = await forwardResponse.json();
    const duration = Date.now() - startTime;

    // Log webhook call
    await supabase.from('webhook_logs').insert({
      webhook_endpoint_id: orgEndpoint.id,
      user_id: incomingPayload.user_id,
      organization_id: orgId,
      source_type: 'user_endpoint',
      status: forwardResponse.ok ? 'forwarded' : 'failed',
      http_status: forwardResponse.status,
      request_payload: prepareData.payload,
      response_payload: responseData,
      forwarded_to: org.webhook_target_url,
      duration_ms: duration,
      error_message: forwardResponse.ok ? null : `HTTP ${forwardResponse.status}`,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Webhook forwarded to organization target URL',
        forwarded_to: org.webhook_target_url,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error in webhook-org:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
