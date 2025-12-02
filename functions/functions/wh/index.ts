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

  const startTime = Date.now();

  try {
    // Extract token from URL path
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/');
    const token = pathParts[pathParts.length - 1];

    if (!token) {
      console.error('No token provided in URL');
      return new Response(
        JSON.stringify({ error: 'Token required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Received webhook request with token:', token.substring(0, 4) + '...');

    // Parse payload - handle empty body for test webhooks
    let payload;
    const contentType = req.headers.get('content-type');
    
    try {
      const text = await req.text();
      if (!text || text.trim() === '') {
        console.log('Empty body received - likely a test webhook');
        return new Response(
          JSON.stringify({ success: true, message: 'Test webhook received' }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      payload = JSON.parse(text);
      console.log('Payload received:', JSON.stringify(payload).substring(0, 200));
    } catch (parseError) {
      console.error('Failed to parse payload:', parseError);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON payload' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Find webhook endpoint by token
    const { data: endpoint, error: endpointError } = await supabase
      .from('webhook_endpoints')
      .select('*')
      .eq('webhook_token', token)
      .eq('is_active', true)
      .maybeSingle();

    if (endpointError) {
      console.error('Error fetching endpoint:', endpointError);
      throw endpointError;
    }

    if (!endpoint) {
      console.error('No active endpoint found for token');
      return new Response(
        JSON.stringify({ error: 'Invalid or inactive token' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = endpoint.user_id;
    const organizationId = endpoint.organization_id;

    // Determine source type from token prefix or endpoint_type
    let sourceType = 'unknown';
    if (token.startsWith('fir_')) {
      sourceType = 'fireflies';
    } else if (token.startsWith('tel_')) {
      sourceType = 'telnyx';
    } else if (endpoint.endpoint_type) {
      sourceType = endpoint.endpoint_type;
    }

    console.log(`Processing webhook for user ${userId}, org ${organizationId}, source: ${sourceType}`);

    // For Telnyx, only process call.hangup events
    if (sourceType === 'telnyx') {
      // Telnyx sends array of events
      const telnyxData = Array.isArray(payload) ? payload[0] : payload;
      const eventType = telnyxData?.data?.event_type;
      
      console.log(`Telnyx event_type: ${eventType}`);
      
      if (eventType !== 'call.hangup') {
        console.log(`Ignoring Telnyx event type: ${eventType}, only call.hangup is processed`);
        
        // Return 200 to acknowledge receipt (so Telnyx doesn't retry)
        // but don't create a meeting
        return new Response(
          JSON.stringify({
            success: true,
            message: `Event type '${eventType}' acknowledged but not processed. Only 'call.hangup' events are processed.`,
            ignored: true
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Create meeting with minimal data - all extraction will happen in prepare-n8n-payload
    console.log('Creating meeting with minimal data, extraction will happen in prepare-n8n-payload');

    // Create meeting record with minimal data
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        title: `${sourceType} - ${new Date().toISOString()}`,
        transcript: '', // Will be extracted by prepare-n8n-payload
        transcript_source: sourceType,
        webhook_source: sourceType,
        webhook_metadata: payload, // Store full raw payload
        processing_status: 'pending',
      })
      .select()
      .single();

    if (meetingError) {
      console.error('Error creating meeting:', meetingError);
      throw meetingError;
    }

    console.log('Meeting created:', meeting.id);

    // Call prepare-n8n-payload to enrich and forward
    const { data: prepareResult, error: prepareError } = await supabase.functions.invoke(
      'prepare-n8n-payload',
      {
        body: { meeting_id: meeting.id }
      }
    );

    if (prepareError) {
      console.error('Error preparing N8N payload:', prepareError);
    }

    // Forward to organization's n8n if configured and payload was prepared successfully
    if (prepareResult?.payload) {
      // Get organization's n8n URL
      const { data: org } = await supabase
        .from('organizations')
        .select('webhook_target_url')
        .eq('id', organizationId)
        .maybeSingle();

      if (org?.webhook_target_url) {
        console.log('Forwarding to n8n:', org.webhook_target_url);
        
        // Update meeting status to processing
        await supabase
          .from('meetings')
          .update({
            processing_status: 'processing',
            processing_started_at: new Date().toISOString(),
          })
          .eq('id', meeting.id);

        // Forward payload to n8n (fire and forget with basic error handling)
        fetch(org.webhook_target_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(prepareResult.payload),
        }).catch(err => console.error('Error forwarding to n8n:', err));
      } else {
        console.log('No webhook_target_url configured for organization');
      }
    }

    const processingDuration = Date.now() - startTime;

    // Log webhook event
    await supabase.from('webhook_logs').insert({
      webhook_endpoint_id: endpoint.id,
      user_id: userId,
      organization_id: organizationId,
      source_type: sourceType,
      status: 'success',
      request_payload: payload,
      response_payload: { meeting_id: meeting.id },
      http_status: 200,
      duration_ms: processingDuration,
      forwarded_to: endpoint.target_url || null,
    });

    return new Response(
      JSON.stringify({
        success: true,
        meeting_id: meeting.id,
        message: `Meeting created and processing started`,
        source: sourceType
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Webhook error:', error);
    const processingDuration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});