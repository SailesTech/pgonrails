import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { 
      meeting_id, 
      analysis_data, 
      overall_score,
      meeting_type_id 
    } = await req.json();

    if (!meeting_id) {
      throw new Error('meeting_id is required');
    }

    console.log('update-meeting-analysis: Updating meeting:', meeting_id);

    // Build update object with only provided fields
    const updateData: any = {};
    
    if (analysis_data !== undefined) {
      updateData.analysis_data = analysis_data;
    }
    
    if (overall_score !== undefined) {
      updateData.overall_score = overall_score;
    }
    
    if (meeting_type_id !== undefined) {
      updateData.meeting_type_id = meeting_type_id;
    }

    // Update the meeting
    const { data: updatedMeeting, error: updateError } = await supabase
      .from('meetings')
      .update(updateData)
      .eq('id', meeting_id)
      .select()
      .single();

    if (updateError) {
      console.error('update-meeting-analysis error:', updateError);
      throw updateError;
    }

    console.log('update-meeting-analysis: Successfully updated meeting:', meeting_id);

    return new Response(
      JSON.stringify({ 
        success: true,
        meeting: updatedMeeting
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('update-meeting-analysis error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
