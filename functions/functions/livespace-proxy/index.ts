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
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) throw new Error("Unauthorized");

    const { integration_id, module, method, params = {} } = await req.json();
    if (!integration_id || !module || !method) {
      throw new Error("Missing required parameters: integration_id, module, method");
    }

    // Fetch integration
    const { data: integration, error: integrationError } = await adminClient
      .from("crm_integrations")
      .select("id, organization_id, platform")
      .eq("id", integration_id)
      .maybeSingle();
    if (integrationError || !integration) throw new Error("Integration not found");
    if (integration.platform !== "livespace") throw new Error("Integration is not Livespace");

    // Permission check: super admin OR org owner/admin
    let allowed = false;
    const { data: isSuperAdmin } = await adminClient.rpc("is_super_admin", { _user_id: user.id });
    if (isSuperAdmin === true) {
      allowed = true;
    } else {
      const { data: role } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("organization_id", integration.organization_id)
        .maybeSingle();
      if (role && ["owner", "admin"].includes(role.role)) allowed = true;
    }
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get credentials
    const { data: cred, error: credError } = await adminClient
      .from("crm_credentials")
      .select("api_key_encrypted, api_secret_encrypted, domain")
      .eq("integration_id", integration_id)
      .maybeSingle();
    if (credError || !cred || !cred.api_key_encrypted || !cred.api_secret_encrypted || !cred.domain) {
      throw new Error("Missing Livespace credentials (api_key, api_secret, domain)");
    }

    // Decrypt API key and secret
    const { data: apiKey, error: decryptKeyError } = await adminClient.rpc("decrypt_api_key", {
      p_encrypted_key: cred.api_key_encrypted,
    });
    if (decryptKeyError || !apiKey) throw new Error("Failed to decrypt API key");

    const { data: apiSecret, error: decryptSecretError } = await adminClient.rpc("decrypt_api_key", {
      p_encrypted_key: cred.api_secret_encrypted,
    });
    if (decryptSecretError || !apiSecret) throw new Error("Failed to decrypt API secret");

    // Build Livespace API URL
    // domain should be full URL like "https://mojafirma.livespace.io"
    const baseUrl = cred.domain.replace(/\/$/, "");
    const url = `${baseUrl}/api/public/json/${module}/${method}`;

    // Generate signature: SHA1(API_KEY + API_SECRET + JSON_PARAMS)
    const paramsJson = JSON.stringify(params);
    const signatureData = apiKey + apiSecret + paramsJson;
    const signature = await sha1(signatureData);

    console.log("Livespace API call", { module, method, url });

    // Make request to Livespace
    const lsRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Signature": signature,
      },
      body: paramsJson,
    });

    const responseText = await lsRes.text();
    
    if (!lsRes.ok) {
      console.error("Livespace error", lsRes.status, responseText);
      return new Response(
        JSON.stringify({
          error: "Livespace API error",
          status: lsRes.status,
          details: responseText,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse response
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    // Livespace returns { result: ..., error: null } on success
    if (responseData.error) {
      console.error("Livespace API returned error:", responseData.error);
      return new Response(
        JSON.stringify({
          error: responseData.error.message || "Livespace API error",
          code: responseData.error.code,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify(responseData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message =
      typeof error === "string" ? error : error && (error as any).message ? (error as any).message : "Unknown error";
    console.error("livespace-proxy failure", message, error);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
