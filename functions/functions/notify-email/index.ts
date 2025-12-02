import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface EmailNotificationPayload {
  type: 'account_created' | 'invitation_sent';
  data: {
    recipient_email: string;
    recipient_name?: string;
    organization_name: string;
    password?: string;
    login_url?: string;
    invite_url?: string;
    invited_by?: string;
    role?: string;
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload: EmailNotificationPayload = await req.json();
    
    // Validate payload
    if (!payload.type || !payload.data) {
      throw new Error('Invalid payload: missing type or data');
    }
    
    if (!payload.data.recipient_email) {
      throw new Error('Invalid payload: missing recipient_email');
    }
    
    if (!payload.data.organization_name) {
      throw new Error('Invalid payload: missing organization_name');
    }

    const systemEmailUrl = Deno.env.get('SYSTEM_EMAIL_WEBHOOK_URL');
    if (!systemEmailUrl) {
      console.error('SYSTEM_EMAIL_WEBHOOK_URL not configured');
      throw new Error('Email webhook URL not configured');
    }

    // Build the payload with timestamp
    const webhookPayload = {
      type: payload.type,
      timestamp: new Date().toISOString(),
      data: payload.data,
    };

    console.log(`Sending ${payload.type} email notification to:`, payload.data.recipient_email);

    // Send to external webhook
    const response = await fetch(systemEmailUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Email webhook error:', response.status, errorText);
      throw new Error(`Email webhook failed: ${response.status}`);
    }

    console.log(`Email notification sent successfully for ${payload.type}`);

    return new Response(
      JSON.stringify({ success: true, type: payload.type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in notify-email:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
