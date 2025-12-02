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
    const {
      summary,
      description,
      start,
      end,
      attendees,
      location,
      conferenceData,
      reminders,
    } = await req.json();

    if (!summary || !start || !end) {
      throw new Error('Missing required parameters: summary, start, end');
    }

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

    // Get user's session to extract provider token
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      throw new Error('No active session');
    }

    const accessToken = session.provider_token;
    if (!accessToken) {
      throw new Error('No Google access token found. Please reconnect your Google account.');
    }

    // Check if user has Calendar enabled
    const { data: integration } = await supabase
      .from('google_integrations')
      .select('calendar_enabled')
      .eq('user_id', user.id)
      .single();

    if (!integration?.calendar_enabled) {
      throw new Error('Google Calendar is not enabled. Please enable it in Integrations settings.');
    }

    console.log('Creating calendar event:', summary);

    // Build event object
    const event: any = {
      summary,
      description,
      start: typeof start === 'string' ? { dateTime: start } : start,
      end: typeof end === 'string' ? { dateTime: end } : end,
    };

    if (location) {
      event.location = location;
    }

    if (attendees && Array.isArray(attendees)) {
      event.attendees = attendees.map((email: string) => ({ email }));
    }

    if (conferenceData) {
      event.conferenceData = conferenceData;
    }

    if (reminders) {
      event.reminders = reminders;
    } else {
      // Default reminders
      event.reminders = {
        useDefault: true,
      };
    }

    // Create event via Google Calendar API
    const createResponse = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('Google Calendar API error:', errorText);
      throw new Error(`Failed to create calendar event: ${errorText}`);
    }

    const result = await createResponse.json();
    console.log('Calendar event created successfully, event ID:', result.id);

    return new Response(
      JSON.stringify({
        success: true,
        event_id: result.id,
        event_link: result.htmlLink,
        hangout_link: result.hangoutLink,
        event: {
          google_event_id: result.id,
          title: result.summary,
          description: result.description,
          start_time: result.start?.dateTime || result.start?.date,
          end_time: result.end?.dateTime || result.end?.date,
          location: result.location,
          attendees: result.attendees,
          meeting_link: result.hangoutLink,
        },
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error creating calendar event:', error);

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
