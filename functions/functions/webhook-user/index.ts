import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // Extract user_id from URL path
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/");
    const userId = pathParts[pathParts.length - 1];

    if (!userId) {
      throw new Error("User ID not provided in URL");
    }

    // Parse incoming webhook payload
    const payload = await req.json();
    console.log("Webhook-user: Received payload for user:", userId);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch user, endpoint and organization info
    const { data: endpoint, error: endpointError } = await supabase
      .from("webhook_endpoints")
      .select(
        `
        id,
        user_id,
        organization_id,
        target_url,
        organizations (
          webhook_target_url
        )
      `,
      )
      .eq("user_id", userId)
      .eq("endpoint_type", "user")
      .eq("is_active", true)
      .single();

    // Fetch user profile separately
    const { data: userProfile } = await supabase
      .from("profiles")
      .select("id, email, first_name, last_name")
      .eq("id", userId)
      .single();

    if (endpointError || !endpoint) {
      console.error("Webhook-user: No active endpoint found for user:", userId);
      throw new Error("No active webhook endpoint found for this user");
    }

    // Universal payload handling - NO VALIDATION, NO EXTRACTION
    // N8N will handle ALL data extraction and return complete data in callback

    // Create meeting record with ONLY raw payload - N8N will provide all metadata
    console.log("Webhook-user: Creating meeting record with payload");
    const { data: newMeeting, error: meetingError } = await supabase
      .from("meetings")
      .insert({
        organization_id: endpoint.organization_id,
        user_id: userId,
        title: "Processing...", // Temporary - N8N will update with real title
        transcript: "Transcript is being processed...", // Placeholder text
        meeting_date: new Date().toISOString(), // Placeholder, N8N will update
        duration: null, // N8N will provide duration
        transcript_source: "webhook",
        webhook_metadata: payload, // Save ENTIRE original payload for N8N
        processing_status: "pending", // Track processing status
      })
      .select()
      .single();

    if (meetingError) {
      console.error("Webhook-user: Error creating meeting:", meetingError);
      throw meetingError;
    }

    console.log("Webhook-user: Meeting created with ID:", newMeeting.id);

    // Match meeting type based on deal data (if provided)
    let matchedMeetingTypeId = null;
    if (payload.deal_data) {
      console.log("Webhook-user: Matching meeting type based on deal data...");

      const matchResponse = await fetch(`${supabaseUrl}/functions/v1/match-meeting-type`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
        body: JSON.stringify({
          organization_id: endpoint.organization_id,
          deal_data: payload.deal_data,
        }),
      });

      if (matchResponse.ok) {
        const matchData = await matchResponse.json();
        matchedMeetingTypeId = matchData.meeting_type_id;

        if (matchedMeetingTypeId) {
          console.log("Webhook-user: Matched meeting type:", matchedMeetingTypeId);

          // Update meeting with matched type
          await supabase.from("meetings").update({ meeting_type_id: matchedMeetingTypeId }).eq("id", newMeeting.id);
        }
      } else {
        console.warn("Webhook-user: Failed to match meeting type");
      }
    }

    // Call prepare-n8n-payload to get complete payload with meeting types
    console.log("Webhook-user: Calling prepare-n8n-payload for meeting:", newMeeting.id);

    const prepareResponse = await fetch(`${supabaseUrl}/functions/v1/prepare-n8n-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        meeting_id: newMeeting.id,
      }),
    });

    if (!prepareResponse.ok) {
      console.error("Webhook-user: Failed to prepare N8N payload");
      throw new Error("Failed to prepare N8N payload");
    }

    const prepareData = await prepareResponse.json();

    if (!prepareData.success) {
      console.error("Webhook-user: prepare-n8n-payload returned error:", prepareData.error);
      throw new Error(`Failed to prepare payload: ${prepareData.error}`);
    }

    console.log("Webhook-user: Payload prepared with", prepareData.payload.meeting_types?.length || 0, "meeting types");

    // Use the complete payload from prepare-n8n-payload
    const forwardPayload = prepareData.payload;

    let forwardSuccess = true;
    let forwardStatus = 200;
    let forwardResponse = null;

    // Forward to organization endpoint if configured
    const orgWebhookUrl = (endpoint.organizations as any)?.webhook_target_url;
    if (orgWebhookUrl) {
      console.log("Webhook-user: Forwarding to organization endpoint:", orgWebhookUrl);

      const forwardResult = await fetch(orgWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(forwardPayload),
      });

      forwardStatus = forwardResult.status;
      forwardSuccess = forwardResult.ok;
      forwardResponse = await forwardResult.json().catch(() => null);

      console.log("Webhook-user: Forward result:", {
        status: forwardStatus,
        success: forwardSuccess,
      });
    }

    // Log the webhook event
    const duration = Date.now() - startTime;
    await supabase.from("webhook_logs").insert({
      webhook_endpoint_id: endpoint.id,
      user_id: userId,
      organization_id: endpoint.organization_id,
      source_type: "user",
      status: forwardSuccess ? "success" : "failed",
      request_payload: payload,
      response_payload: forwardResponse,
      forwarded_to: orgWebhookUrl || null,
      http_status: forwardStatus,
      duration_ms: duration,
    });

    return new Response(
      JSON.stringify({
        success: true,
        meeting_id: newMeeting.id,
        forwarded: !!orgWebhookUrl,
        forward_status: forwardStatus,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error in webhook-user:", error);
    const message = (error && (error as any).message) || (error && (error as any).error) || "Unknown error";
    return new Response(
      JSON.stringify({
        success: false,
        error: message,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
