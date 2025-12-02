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
    const { organization_id, deal_data } = await req.json();

    if (!organization_id) {
      throw new Error('organization_id is required');
    }

    console.log('match-meeting-type: Matching for org:', organization_id, 'Deal data:', deal_data);

    let matchedMeetingTypeId = null;

    // If deal_data is provided, try to match based on Pipedrive scenarios
    if (deal_data && deal_data.pipeline_id) {
      console.log('match-meeting-type: Searching for matching Pipedrive scenario...');

      // Query pipedrive_scenarios with matching conditions
      // Start with most specific (pipeline + stage + status) and fall back to less specific
      const queries = [
        // Most specific: pipeline + stage + status
        {
          pipeline_id: deal_data.pipeline_id,
          stage_id: deal_data.stage_id || null,
          deal_status: deal_data.deal_status || null,
        },
        // Pipeline + stage only
        {
          pipeline_id: deal_data.pipeline_id,
          stage_id: deal_data.stage_id || null,
          deal_status: null,
        },
        // Pipeline + status only
        {
          pipeline_id: deal_data.pipeline_id,
          stage_id: null,
          deal_status: deal_data.deal_status || null,
        },
        // Pipeline only
        {
          pipeline_id: deal_data.pipeline_id,
          stage_id: null,
          deal_status: null,
        },
      ];

      for (const query of queries) {
        let dbQuery = supabase
          .from('pipedrive_scenarios')
          .select('meeting_type_id')
          .eq('organization_id', organization_id)
          .eq('is_active', true)
          .eq('pipeline_id', query.pipeline_id);

        if (query.stage_id) {
          dbQuery = dbQuery.eq('stage_id', query.stage_id);
        } else {
          dbQuery = dbQuery.is('stage_id', null);
        }

        if (query.deal_status) {
          dbQuery = dbQuery.eq('deal_status', query.deal_status);
        } else {
          dbQuery = dbQuery.is('deal_status', null);
        }

        const { data, error } = await dbQuery
          .order('order_index')
          .limit(1)
          .maybeSingle();

        if (!error && data && data.meeting_type_id) {
          matchedMeetingTypeId = data.meeting_type_id;
          console.log('match-meeting-type: Found matching scenario with meeting_type_id:', matchedMeetingTypeId);
          break;
        }
      }
    }

    // If no match found, use default meeting type for organization
    if (!matchedMeetingTypeId) {
      console.log('match-meeting-type: No Pipedrive match, looking for default meeting type...');

      const { data: defaultType, error: defaultError } = await supabase
        .from('meeting_types')
        .select('id')
        .eq('organization_id', organization_id)
        .eq('is_default', true)
        .maybeSingle();

      if (!defaultError && defaultType) {
        matchedMeetingTypeId = defaultType.id;
        console.log('match-meeting-type: Using default meeting type:', matchedMeetingTypeId);
      } else {
        console.log('match-meeting-type: No meeting types found for organization');
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        meeting_type_id: matchedMeetingTypeId,
        matched: !!matchedMeetingTypeId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('match-meeting-type error:', error);
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
