import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.80.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    const { meeting_id, deal_data } = await req.json();

    if (!meeting_id && !deal_data) {
      throw new Error('Missing meeting_id or deal_data');
    }

    const startTime = Date.now();

    let meeting: any = null;
    let matchedScenario: any = null;

    if (meeting_id) {
      // Sync existing meeting
      const { data, error: meetingError } = await supabase
        .from('meetings')
        .select('*, meeting_types(*)')
        .eq('id', meeting_id)
        .single();

      if (meetingError || !data) {
        throw new Error('Meeting not found');
      }
      meeting = data;
    } else if (deal_data) {
      // Match deal_data to scenario
      const { data: scenarioMatch, error: matchError } = await supabase.rpc('match_pipedrive_scenario', {
        p_organization_id: deal_data.organization_id,
        p_pipeline_id: deal_data.pipeline_id,
        p_stage_id: deal_data.stage_id || null,
        p_deal_status: deal_data.status || 'open',
        p_deal_fields: deal_data.custom_fields || {},
      });

      if (matchError) {
        console.error('Error matching scenario:', matchError);
        throw new Error('Failed to match scenario');
      }

      if (!scenarioMatch || scenarioMatch.length === 0) {
        throw new Error('No matching scenario found for this deal');
      }

      matchedScenario = scenarioMatch[0];
      console.log('Matched scenario:', matchedScenario);

      // TODO: Create meeting from deal_data using meeting_type configuration
      // For now, throw error indicating this feature needs implementation
      throw new Error('Auto-creation of meetings from Pipedrive deals not yet implemented. Use webhook-org endpoint.');
    }

    // Get CRM integration
    const { data: integration } = await supabase
      .from('crm_integrations')
      .select('*')
      .eq('organization_id', meeting.organization_id)
      .eq('status', 'connected')
      .single();

    if (!integration) {
      throw new Error('No active CRM integration found');
    }

    // Get credentials
    const { data: credentials } = await supabase
      .from('crm_credentials')
      .select('*')
      .eq('integration_id', integration.id)
      .single();

    if (!credentials) {
      throw new Error('CRM credentials not found');
    }

    // Decrypt API key using pgcrypto
    const { data: apiKeyData, error: decryptError } = await supabase.rpc('decrypt_api_key', {
      p_encrypted_key: credentials.api_key,
    });

    if (decryptError || !apiKeyData) {
      throw new Error('Failed to decrypt API key');
    }

    // Get field mappings
    const { data: mappings } = await supabase
      .from('crm_field_mappings')
      .select('*')
      .eq('integration_id', integration.id)
      .eq('is_active', true);

    // Sync based on platform
    let crmRecordId = null;
    let error = null;

    try {
      if (integration.platform === 'pipedrive') {
        crmRecordId = await syncToPipedrive(meeting, apiKeyData, mappings);
      } else {
        throw new Error(`Platform ${integration.platform} not yet implemented`);
      }
    } catch (syncError) {
      error = syncError instanceof Error ? syncError.message : 'Unknown error';
    }

    // Log sync result
    const duration = Date.now() - startTime;
    await supabase.rpc('log_crm_sync', {
      _integration_id: integration.id,
      _meeting_id: meeting_id,
      _status: error ? 'failed' : 'success',
      _crm_record_id: crmRecordId,
      _error: error,
      _objects_synced: { activity: 1 },
      _duration_ms: duration,
      _triggered_by: 'manual',
    });

    if (error) {
      throw new Error(error);
    }

    return new Response(
      JSON.stringify({ success: true, crm_record_id: crmRecordId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function syncToPipedrive(
  meeting: any,
  apiKey: string,
  mappings: any[] | null
): Promise<string> {
  const baseUrl = 'api.pipedrive.com';
  
  // Create activity in Pipedrive
  const activityData: any = {
    subject: meeting.title || 'Meeting',
    type: 'meeting',
    due_date: meeting.meeting_date ? new Date(meeting.meeting_date).toISOString().split('T')[0] : undefined,
    duration: meeting.duration ? `${Math.floor(meeting.duration / 60)}:${meeting.duration % 60}` : undefined,
    note: meeting.transcript?.substring(0, 5000), // Pipedrive has limits
  };

  // Apply custom field mappings if provided
  if (mappings && mappings.length > 0) {
    for (const mapping of mappings) {
      if (mapping.crm_object_type === 'activity') {
        const value = meeting[mapping.callos_field];
        if (value !== undefined) {
          activityData[mapping.crm_field] = value;
        }
      }
    }
  }

  const response = await fetch(`https://${baseUrl}/v1/activities?api_token=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(activityData),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Pipedrive API error: ${errorData.error || response.statusText}`);
  }

  const result = await response.json();
  return result.data.id.toString();
}
