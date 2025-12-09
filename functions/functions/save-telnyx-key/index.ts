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

    const { apiKey, userId, organizationId } = await req.json();
    if (!apiKey || !userId || !organizationId) {
      throw new Error("Missing required fields: apiKey, userId, organizationId");
    }

    console.log("Validating Telnyx API key for user:", userId);

    // Validate API key with Telnyx API using /v2/balance endpoint
    // This endpoint works for any valid API key without requiring specific resources
    const telnyxResponse = await fetch("https://api.telnyx.com/v2/balance", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    console.log("Telnyx validation response status:", telnyxResponse.status);

    if (!telnyxResponse.ok) {
      const errorBody = await telnyxResponse.text();
      console.error("Telnyx API validation failed:", telnyxResponse.status, errorBody);
      throw new Error("Invalid Telnyx API key. Please check your key and try again.");
    }

    console.log("Telnyx API key validated successfully");

    // Encrypt the API key using Vault
    const { data: encryptedKey, error: encryptError } = await supabase.rpc(
      "encrypt_api_key",
      {
        p_api_key: apiKey,
      }
    );

    if (encryptError || !encryptedKey) {
      throw new Error(
        `Failed to encrypt API key: ${encryptError?.message || "Unknown error"}`
      );
    }

    console.log("API key encrypted successfully");

    // Upsert credentials
    const { error: upsertError } = await supabase
      .from("telnyx_credentials")
      .upsert(
        {
          user_id: userId,
          organization_id: organizationId,
          api_key_encrypted: encryptedKey,
          is_active: true,
          last_validated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,organization_id" }
      );

    if (upsertError) throw upsertError;

    console.log("Telnyx credentials saved successfully");

    return new Response(
      JSON.stringify({
        success: true,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const message =
      typeof error === "string"
        ? error
        : error && (error as any).message
        ? (error as any).message
        : "Unknown error";
    console.error("save-telnyx-key error:", message);
    return new Response(
      JSON.stringify({ error: message, success: false }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
