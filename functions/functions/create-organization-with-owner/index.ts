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
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization')!;
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Sprawdź czy user jest super adminem
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) throw new Error('Unauthorized');

    const { data: isSuperAdmin } = await supabaseClient.rpc('is_super_admin', {
      _user_id: user.id
    });

    if (!isSuperAdmin) {
      throw new Error('Only super admins can create organizations');
    }

    const {
      org_name,
      org_slug,
      plan = 'free',
      webhook_target_url,
      user_email,
      user_password,
      first_name,
      last_name
    } = await req.json();

    // Utwórz użytkownika z flagą skip_org_creation
    // Trigger handle_new_user utworzy tylko profil, NIE organizację
    const { data: newUser, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email: user_email,
      password: user_password,
      email_confirm: true,
      user_metadata: {
        first_name,
        last_name,
        skip_org_creation: 'true',
      }
    });

    if (userError) throw userError;

    // Użyj nowej funkcji SQL do utworzenia organizacji i przypisania ownera
    // Ta funkcja tworzy: org + owner role + meeting types + org context
    const { data: orgId, error: orgError } = await supabaseAdmin.rpc('create_organization_with_owner', {
      _org_name: org_name,
      _org_slug: org_slug,
      _owner_user_id: newUser.user.id,
      _plan: plan
    });

    if (orgError) throw orgError;

    // Jeśli podano webhook_target_url, zaktualizuj organizację
    if (webhook_target_url) {
      const { error: webhookUpdateError } = await supabaseAdmin
        .from('organizations')
        .update({ webhook_target_url })
        .eq('id', orgId);

      if (webhookUpdateError) throw webhookUpdateError;
    }

    // Utwórz organization webhook endpoint jeśli podano webhook_target_url
    if (webhook_target_url) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const orgEndpointUrl = `${supabaseUrl}/functions/v1/webhook-org/${orgId}`;

      await supabaseAdmin
        .from('webhook_endpoints')
        .insert({
          organization_id: orgId,
          endpoint_type: 'organization',
          endpoint_url: orgEndpointUrl,
          target_url: webhook_target_url,
          is_active: true,
        });
    }

    // Wyślij email z danymi do logowania
    const systemEmailUrl = Deno.env.get('SYSTEM_EMAIL_WEBHOOK_URL');
    if (systemEmailUrl) {
      const recipientName = `${first_name || ''} ${last_name || ''}`.trim();
      const emailPayload = {
        type: 'account_created',
        timestamp: new Date().toISOString(),
        data: {
          recipient_email: user_email,
          recipient_name: recipientName || user_email,
          organization_name: org_name,
          password: user_password,
          login_url: Deno.env.get('APP_URL') || 'https://app.callos.ai'
        }
      };

      console.log('Sending account_created email notification to:', user_email);

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
        // Nie przerywamy - konto zostało utworzone, email jest tylko powiadomieniem
      }
    } else {
      console.warn('SYSTEM_EMAIL_WEBHOOK_URL not configured, skipping email notification');
    }

    return new Response(
      JSON.stringify({
        success: true,
        organization_id: orgId,
        user_id: newUser.user.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error creating organization:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const details = error instanceof Error ? error.stack : JSON.stringify(error);
    console.error('Error details:', details);
    
    return new Response(
      JSON.stringify({ 
        error: message,
        details: details 
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
