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
    // Parse incoming payload from org endpoint
    const payload = await req.json();
    console.log('Received webhook at global endpoint');
    console.log('User ID:', payload.user_id);
    console.log('Organization ID:', payload.organization_id);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get global endpoint config
    const { data: globalEndpoint, error: endpointError } = await supabase
      .from('webhook_endpoints')
      .select('id, target_url, metadata')
      .eq('endpoint_type', 'global')
      .eq('is_active', true)
      .single();

    if (endpointError || !globalEndpoint) {
      throw new Error(`Global endpoint not found: ${endpointError?.message}`);
    }

    // Extract Fireflies data from nested request object
    const firefliiesData = payload.request;
    
    // Process the webhook data here (this is where your business logic goes)
    console.log('Processing Fireflies webhook data:', {
      transcriptId: firefliiesData?.transcript_id,
      meetingTitle: firefliiesData?.title,
      meetingDate: firefliiesData?.date,
    });

    // If target_url is set, forward to external endpoint
    let forwardResponse = null;
    if (globalEndpoint.target_url) {
      console.log('Forwarding to external target:', globalEndpoint.target_url);
      try {
        const externalResponse = await fetch(globalEndpoint.target_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        forwardResponse = await externalResponse.json();
      } catch (error) {
        console.error('Failed to forward to external target:', error);
      }
    }

    const duration = Date.now() - startTime;

    // Log webhook call
    await supabase.from('webhook_logs').insert({
      webhook_endpoint_id: globalEndpoint.id,
      user_id: payload.user_id,
      organization_id: payload.organization_id,
      source_type: 'org_endpoint',
      status: 'success',
      http_status: 200,
      request_payload: payload,
      response_payload: forwardResponse,
      forwarded_to: globalEndpoint.target_url,
      duration_ms: duration,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Webhook processed successfully',
        data: {
          user_id: payload.user_id,
          organization_id: payload.organization_id,
          transcript_id: firefliiesData?.transcript_id,
          forwarded: !!globalEndpoint.target_url,
        },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error in webhook-global:', error);
    
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
