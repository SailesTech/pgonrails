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
    const { meeting_id } = await req.json();
    
    if (!meeting_id) {
      return new Response(JSON.stringify({ error: 'meeting_id is required' }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log('retry-n8n-forward: Processing retry for meeting:', meeting_id);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Authorization required' }), { 
        status: 401, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    
    // User client for auth verification
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    
    if (authError || !user) {
      console.log('retry-n8n-forward: Auth error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log('retry-n8n-forward: User authenticated:', user.id);

    // Service client for operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Check if user is super_admin
    const { data: isSuperAdmin, error: superAdminError } = await supabase.rpc('is_super_admin', { _user_id: user.id });
    
    if (superAdminError) {
      console.log('retry-n8n-forward: Error checking super admin:', superAdminError.message);
      return new Response(JSON.stringify({ error: 'Error checking permissions' }), { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (!isSuperAdmin) {
      console.log('retry-n8n-forward: User is not super admin');
      return new Response(JSON.stringify({ error: 'Only Super Admin can use this function' }), { 
        status: 403, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log('retry-n8n-forward: User is super admin, proceeding...');

    // Get meeting
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', meeting_id)
      .single();
    
    if (meetingError || !meeting) {
      console.log('retry-n8n-forward: Meeting not found:', meetingError?.message);
      return new Response(JSON.stringify({ error: 'Meeting not found' }), { 
        status: 404, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log('retry-n8n-forward: Meeting found, org:', meeting.organization_id);

    // Get org webhook URL
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('webhook_target_url, name')
      .eq('id', meeting.organization_id)
      .single();
    
    if (orgError || !org) {
      console.log('retry-n8n-forward: Organization not found:', orgError?.message);
      return new Response(JSON.stringify({ error: 'Organization not found' }), { 
        status: 404, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (!org.webhook_target_url) {
      console.log('retry-n8n-forward: No webhook URL configured for org');
      return new Response(JSON.stringify({ error: 'No webhook URL configured for this organization' }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log('retry-n8n-forward: Calling prepare-n8n-payload...');

    // Call prepare-n8n-payload
    const prepareResponse = await fetch(`${supabaseUrl}/functions/v1/prepare-n8n-payload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ meeting_id }),
    });
    
    if (!prepareResponse.ok) {
      const errorText = await prepareResponse.text();
      console.log('retry-n8n-forward: prepare-n8n-payload failed:', errorText);
      return new Response(JSON.stringify({ error: 'Failed to prepare payload', details: errorText }), { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const prepareData = await prepareResponse.json();
    console.log('retry-n8n-forward: Payload prepared, forwarding to n8n...');

    // Forward to n8n
    const startTime = Date.now();
    const n8nResponse = await fetch(org.webhook_target_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareData.payload || prepareData),
    });
    const durationMs = Date.now() - startTime;

    console.log('retry-n8n-forward: n8n response status:', n8nResponse.status);

    // Update meeting status
    await supabase.from('meetings').update({
      processing_status: 'processing',
      processing_started_at: new Date().toISOString(),
    }).eq('id', meeting_id);

    // Log retry attempt
    await supabase.from('webhook_logs').insert({
      user_id: user.id,
      organization_id: meeting.organization_id,
      source_type: 'admin_retry',
      status: n8nResponse.ok ? 'success' : 'failed',
      http_status: n8nResponse.status,
      duration_ms: durationMs,
      request_payload: { meeting_id, retry: true, triggered_by: user.id },
    });

    console.log('retry-n8n-forward: Retry completed successfully');

    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Retry sent to n8n',
      n8n_status: n8nResponse.status,
      organization: org.name,
      meeting_title: meeting.title
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('retry-n8n-forward: Unexpected error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
