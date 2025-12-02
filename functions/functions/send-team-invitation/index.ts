import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Sprawdź czy user jest zalogowany
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { email, organization_id, role } = await req.json();

    console.log('Sending invitation to:', email, 'for org:', organization_id, 'with role:', role);

    // Sprawdź czy user ma uprawnienia (admin/owner)
    const { data: userRole } = await supabaseClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', organization_id)
      .single();

    if (!userRole || !['admin', 'owner', 'super_admin'].includes(userRole.role)) {
      throw new Error('Insufficient permissions');
    }

    // Sprawdź czy email już nie jest w organizacji
    const { data: existingUser } = await supabaseAdmin
      .from('user_roles')
      .select('user_id, profiles!inner(email)')
      .eq('organization_id', organization_id);

    const emailExists = existingUser?.some((u: any) => u.profiles?.email === email);
    if (emailExists) {
      throw new Error('User with this email is already in the organization');
    }

    // Wygeneruj token
    const token = crypto.randomUUID();
    const inviteUrl = `${Deno.env.get('APP_URL') || 'http://localhost:5173'}/accept-invite?token=${token}`;

    // Zapisz zaproszenie
    const { error: dbError } = await supabaseAdmin
      .from('team_invitations')
      .insert({
        email,
        organization_id,
        role,
        invited_by: user.id,
        token,
      });

    if (dbError) {
      console.error('Database error:', dbError);
      throw dbError;
    }

    console.log('Invitation created successfully');

    // Pobierz dane do emaila
    const { data: inviterProfile } = await supabaseClient
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', user.id)
      .maybeSingle();

    const { data: org } = await supabaseClient
      .from('organizations')
      .select('name')
      .eq('id', organization_id)
      .maybeSingle();

    // Wyślij powiadomienie email
    const systemEmailUrl = Deno.env.get('SYSTEM_EMAIL_WEBHOOK_URL');
    if (systemEmailUrl) {
      const inviterName = inviterProfile 
        ? `${inviterProfile.first_name || ''} ${inviterProfile.last_name || ''}`.trim() || inviterProfile.email
        : user.email;

      const emailPayload = {
        type: 'invitation_sent',
        timestamp: new Date().toISOString(),
        data: {
          recipient_email: email,
          organization_name: org?.name || 'Unknown',
          invite_url: inviteUrl,
          invited_by: inviterName,
          role: role
        }
      };

      console.log('Sending invitation_sent email notification to:', email);

      try {
        const emailResponse = await fetch(systemEmailUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        });

        if (!emailResponse.ok) {
          console.error('Failed to send email notification:', emailResponse.status);
        } else {
          console.log('Email notification sent successfully');
        }
      } catch (emailError) {
        console.error('Error sending email notification:', emailError);
        // Nie przerywamy - zaproszenie zostało utworzone, email jest tylko powiadomieniem
      }
    } else {
      console.warn('SYSTEM_EMAIL_WEBHOOK_URL not configured, skipping email notification');
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        invite_url: inviteUrl,
        message: 'Invitation created successfully'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in send-team-invitation:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
