import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Missing authorization header");
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user) throw new Error("Unauthorized");

    const { integration_id } = await req.json();
    if (!integration_id) {
      throw new Error("Missing integration_id");
    }

    console.log("Testing CRM connection for integration:", integration_id);

    // Get integration
    const { data: integration, error: integrationError } = await supabase
      .from("crm_integrations")
      .select("id, platform, organization_id")
      .eq("id", integration_id)
      .single();

    if (integrationError || !integration) {
      throw new Error("Integration not found");
    }

    // Get credentials
    const { data: credentials, error: credError } = await supabase
      .from("crm_credentials")
      .select("api_key_encrypted")
      .eq("integration_id", integration_id)
      .single();

    if (credError || !credentials) {
      throw new Error("Credentials not found");
    }

    // Decrypt API key
    const { data: apiKey, error: decryptError } = await supabase.rpc("decrypt_api_key", {
      p_encrypted_key: credentials.api_key_encrypted,
    });

    if (decryptError || !apiKey) {
      throw new Error("Failed to decrypt API key");
    }

    // Test connection based on platform
    if (integration.platform === "pipedrive") {
      const testUrl = `https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(apiKey)}`;
      const response = await fetch(testUrl);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pipedrive API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error("Invalid Pipedrive API key");
      }

      return new Response(
        JSON.stringify({
          success: true,
          user: {
            id: data.data?.id,
            name: data.data?.name,
            email: data.data?.email,
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else {
      throw new Error(`Platform ${integration.platform} not yet supported`);
    }
  } catch (error) {
    const message =
      typeof error === "string" ? error : error && (error as any).message ? (error as any).message : "Unknown error";
    console.error("test-crm-connection error:", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
