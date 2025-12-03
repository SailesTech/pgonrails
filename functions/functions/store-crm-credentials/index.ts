import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SHA-1 hash function for Livespace signature
async function sha1(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

    const { integration_id, api_key, api_secret, domain, platform } = await req.json();
    if (!integration_id || !api_key) {
      throw new Error("Missing required fields: integration_id, api_key");
    }

    console.log("Storing credentials for integration:", integration_id, "platform:", platform);

    // Determine platform from integration if not provided
    let crmPlatform = platform;
    if (!crmPlatform) {
      const { data: int } = await supabase
        .from("crm_integrations")
        .select("platform")
        .eq("id", integration_id)
        .single();
      crmPlatform = int?.platform;
    }

    // Handle Livespace
    if (crmPlatform === "livespace") {
      if (!api_secret || !domain) {
        throw new Error("Missing required fields for Livespace: api_secret, domain");
      }

      // Normalize domain URL
      let normalizedDomain = domain.trim();
      if (!normalizedDomain.startsWith("http://") && !normalizedDomain.startsWith("https://")) {
        normalizedDomain = "https://" + normalizedDomain;
      }
      normalizedDomain = normalizedDomain.replace(/\/$/, "");

      // Verify Livespace API key by calling User_getInfo
      const verifyUrl = `${normalizedDomain}/api/public/json/Default/User_getInfo`;
      const paramsJson = JSON.stringify({});
      const signatureData = api_key + api_secret + paramsJson;
      const signature = await sha1(signatureData);

      console.log("Verifying Livespace connection...", verifyUrl);

      const verifyRes = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": api_key,
          "X-Api-Signature": signature,
        },
        body: paramsJson,
      });

      if (!verifyRes.ok) {
        const errorText = await verifyRes.text();
        console.error("Livespace verification failed:", verifyRes.status, errorText);
        throw new Error(`Livespace verification failed (${verifyRes.status}): ${errorText}`);
      }

      const verifyData = await verifyRes.json();
      console.log("Livespace verification response:", JSON.stringify(verifyData));
      
      if (verifyData.error) {
        console.error("Livespace API error:", verifyData.error);
        throw new Error(`Livespace API error: ${verifyData.error.message || JSON.stringify(verifyData.error)}`);
      }
      
      // Check for status: false (authentication or API errors)
      if (verifyData.status === false) {
        console.error("Livespace verification failed with code:", verifyData.result);
        throw new Error(`Livespace API error: code ${verifyData.result}. Check API credentials (api_key, api_secret, domain).`);
      }

      console.log("Livespace verification successful, user:", verifyData.result?.email);

      // Encrypt both keys
      const { data: encryptedKey, error: encryptKeyError } = await supabase.rpc("encrypt_api_key", {
        p_api_key: api_key,
      });
      if (encryptKeyError || !encryptedKey) {
        throw new Error(`Failed to encrypt API key: ${encryptKeyError?.message || "Unknown error"}`);
      }

      const { data: encryptedSecret, error: encryptSecretError } = await supabase.rpc("encrypt_api_key", {
        p_api_key: api_secret,
      });
      if (encryptSecretError || !encryptedSecret) {
        throw new Error(`Failed to encrypt API secret: ${encryptSecretError?.message || "Unknown error"}`);
      }

      // Store credentials
      const { error: credError } = await supabase.from("crm_credentials").upsert(
        {
          integration_id,
          auth_type: "api_key",
          api_key_encrypted: encryptedKey,
          api_secret_encrypted: encryptedSecret,
          domain: normalizedDomain,
        },
        { onConflict: "integration_id" }
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
          livespace_user: {
            email: verifyData.result?.email,
            name: verifyData.result?.name,
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Handle Pipedrive (existing logic)
    // Verify Pipedrive API key via global API endpoint
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
      { onConflict: "integration_id" }
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
      }
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
