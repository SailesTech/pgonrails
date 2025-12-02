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

    const { invitation_id } = await req.json();

    if (!invitation_id) {
      throw new Error('invitation_id is required');
    }

    console.log('Resending invitation:', invitation_id);

    // Pobierz zaproszenie
    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('team_invitations')
      .select('*, organizations(name)')
      .eq('id', invitation_id)
      .is('accepted_at', null)
      .maybeSingle();

    if (inviteError || !invitation) {
      throw new Error('Invitation not found or already accepted');
    }

    // Sprawdź czy user jest super adminem
    const { data: isSuperAdmin } = await supabaseAdmin
      .rpc('is_super_admin', { _user_id: user.id });

    // Sprawdź czy user ma uprawnienia do tej organizacji
    const { data: userRole } = await supabaseClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('organization_id', invitation.organization_id)
      .maybeSingle();

    const hasPermission = isSuperAdmin || (userRole && ['admin', 'owner'].includes(userRole.role));
    if (!hasPermission) {
      throw new Error('Insufficient permissions');
    }

    // Pobierz dane zapraszającego (aktualny user)
    const { data: inviterProfile } = await supabaseClient
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', user.id)
      .maybeSingle();

    // Utwórz URL zaproszenia z istniejącym tokenem
    const inviteUrl = `${Deno.env.get('APP_URL') || 'http://localhost:5173'}/accept-invite?token=${invitation.token}`;

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
          recipient_email: invitation.email,
          organization_name: invitation.organizations?.name || 'Unknown',
          invite_url: inviteUrl,
          invited_by: inviterName,
          role: invitation.role
        }
      };

      console.log('Resending invitation_sent email notification to:', invitation.email);

      try {
        const emailResponse = await fetch(systemEmailUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        });

        if (!emailResponse.ok) {
          console.error('Failed to send email notification:', emailResponse.status);
          throw new Error('Failed to send email notification');
        }
        
        console.log('Email notification resent successfully');
      } catch (emailError) {
        console.error('Error sending email notification:', emailError);
        throw new Error('Failed to send email notification');
      }
    } else {
      console.warn('SYSTEM_EMAIL_WEBHOOK_URL not configured');
      throw new Error('Email service not configured');
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Invitation resent to ${invitation.email}`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in resend-team-invitation:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
