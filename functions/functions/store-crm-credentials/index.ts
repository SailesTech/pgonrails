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
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

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

    const { integration_id, api_key } = await req.json();
    if (!integration_id || !api_key) {
      throw new Error("Missing required fields: integration_id, api_key");
    }

    console.log("Storing credentials for integration:", integration_id);

    // verify Pipedrive API key via global API endpoint
    const verifyUrl = `https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(api_key)}`;
    const res = await fetch(verifyUrl);
    if (!res.ok) throw new Error(`Pipedrive verification failed (${res.status})`);
    const data = await res.json();
    if (!data.success) throw new Error("Invalid Pipedrive API key");

    // Encrypt API key using pgcrypto
    const { data: encryptedKey, error: encryptError } = await supabase.rpc("encrypt_api_key", {
      p_api_key: api_key,
    });
    if (encryptError || !encryptedKey) {
      throw new Error(`Failed to encrypt API key: ${encryptError?.message || "Unknown error"}`);
    }

    // Store encrypted API key
    const { error: credError } = await supabase.from("crm_credentials").upsert(
      {
        integration_id,
        auth_type: "api_key",
        api_key_encrypted: encryptedKey,
      },
      { onConflict: "integration_id" },
    );
    if (credError) throw credError;

    // Mark integration as connected
    const { error: updateError } = await supabase
      .from("crm_integrations")
      .update({ status: "connected" })
      .eq("id", integration_id);
    if (updateError) throw updateError;

    return new Response(
      JSON.stringify({
        success: true,
        pipedrive_user: {
          id: data?.data?.id,
          name: data?.data?.name,
          email: data?.data?.email,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const message =
      typeof error === "string" ? error : error && (error as any).message ? (error as any).message : "Unknown error";
    console.error("store-crm-credentials error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
