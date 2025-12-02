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
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    // Verify user
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    // Get organization_id from query params or request body
    const url = new URL(req.url);
    let organizationId = url.searchParams.get('organization_id');

    if (!organizationId && req.method === 'POST') {
      const body = await req.json();
      organizationId = body.organization_id;
    }

    if (!organizationId) {
      throw new Error('organization_id is required');
    }

    // Verify user has access to this organization
    const { data: userRole, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organizationId)
      .single();

    if (roleError || !userRole) {
      throw new Error('User does not have access to this organization');
    }

    // Fetch meeting types with all related data
    const { data: meetingTypes, error: typesError } = await supabase
      .from('meeting_types')
      .select(`
        id,
        name,
        description,
        organization_id,
        success_criteria,
        script_guidelines,
        created_at,
        updated_at,
        meeting_type_attributes (
          id,
          attribute_key,
          attribute_value,
          order_index
        ),
        meeting_type_checkpoints (
          id,
          checkpoint_text,
          order_index
        ),
        meeting_type_criteria_strings (
          id,
          criterion_text,
          order_index
        )
      `)
      .eq('organization_id', organizationId)
      .order('name');

    if (typesError) {
      console.error('Error fetching meeting types:', typesError);
      throw typesError;
    }

    console.log('get-meeting-types: Retrieved', meetingTypes?.length || 0, 'meeting types for org:', organizationId);

    return new Response(
      JSON.stringify({ 
        success: true,
        meeting_types: meetingTypes || []
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('get-meeting-types error:', error);
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
