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
    const { timeMin, timeMax, maxResults = 50 } = await req.json();

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Initialize Supabase with user's auth
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Get user from JWT
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('Invalid authentication token');
    }

    // Get Google integration with access token
    const { data: integration, error: integrationError } = await supabase
      .from('google_integrations')
      .select('access_token_encrypted, calendar_enabled')
      .eq('user_id', user.id)
      .single();

    if (integrationError || !integration) {
      throw new Error('Google integration not found. Please connect Calendar first.');
    }

    if (!integration.calendar_enabled) {
      throw new Error('Google Calendar is not enabled. Please enable it in Integrations settings.');
    }

    // Decrypt access token
    const { data: accessToken, error: decryptError } = await supabase.rpc('decrypt_api_key', {
      p_encrypted_key: integration.access_token_encrypted,
    });

    if (decryptError || !accessToken) {
      throw new Error('Failed to decrypt access token. Please reconnect Calendar.');
    }

    console.log('Fetching calendar events for user:', user.email);

    // Build query params
    const params = new URLSearchParams({
      maxResults: maxResults.toString(),
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    if (timeMin) params.append('timeMin', timeMin);
    if (timeMax) params.append('timeMax', timeMax);

    // Fetch calendar events from Google Calendar API
    const calendarResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!calendarResponse.ok) {
      const errorText = await calendarResponse.text();
      console.error('Google Calendar API error:', errorText);
      throw new Error(`Failed to fetch calendar events: ${errorText}`);
    }

    const calendarData = await calendarResponse.json();
    console.log(`Successfully fetched ${calendarData.items?.length || 0} calendar events`);

    // Transform events to our format
    const events = calendarData.items?.map((event: any) => ({
      google_event_id: event.id,
      title: event.summary,
      description: event.description,
      start_time: event.start?.dateTime || event.start?.date,
      end_time: event.end?.dateTime || event.end?.date,
      location: event.location,
      attendees: event.attendees?.map((a: any) => ({
        email: a.email,
        name: a.displayName,
        response_status: a.responseStatus,
      })),
      meeting_link: event.hangoutLink || event.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri,
    })) || [];

    return new Response(
      JSON.stringify({
        success: true,
        events,
        next_sync_token: calendarData.nextSyncToken,
        next_page_token: calendarData.nextPageToken,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error syncing calendar:', error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
