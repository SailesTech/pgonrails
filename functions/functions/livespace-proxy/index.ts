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

// Livespace authentication helper - gets token and session
async function getLivespaceAuth(domain: string, apiKey: string): Promise<{ token: string; sessionId: string }> {
  const tokenUrl = `${domain}/api/public/json/_Api/auth_call/_api_method/getToken`;
  
  const formData = new FormData();
  formData.append("_api_auth", "key");
  formData.append("_api_key", apiKey);
  
  console.log("Getting Livespace token from:", tokenUrl);
  
  const response = await fetch(tokenUrl, {
    method: "POST",
    body: formData,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error("Livespace getToken failed:", response.status, errorText);
    throw new Error(`Livespace getToken failed (${response.status}): ${errorText}`);
  }
  
  const data = await response.json();
  console.log("Livespace getToken response:", JSON.stringify(data));
  
  if (data.status === false) {
    throw new Error(`Livespace getToken error: code ${data.result}. Check your API key.`);
  }
  
  if (!data.data?.token || !data.data?.session_id) {
    throw new Error("Livespace getToken: missing token or session_id in response");
  }
  
  return {
    token: data.data.token,
    sessionId: data.data.session_id,
  };
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

    // Step 1: Get token and session
    const { token, sessionId } = await getLivespaceAuth(cred.domain, apiKey);

    // Step 2: Calculate signature: SHA1(api_key + token + api_secret)
    const signatureData = apiKey + token + apiSecret;
    const signature = await sha1(signatureData);

    console.log("Livespace proxy auth - token length:", token.length, "session:", sessionId);

    // Step 3: Make authenticated request
    const apiUrl = `${cred.domain}/api/public/json/${module}/${method}`;
    
    const formData = new FormData();
    formData.append("_api_auth", "key");
    formData.append("_api_key", apiKey);
    formData.append("_api_sha", signature);
    formData.append("_api_session", sessionId);
    
    // Add method params
    for (const [key, value] of Object.entries(params)) {
      formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    console.log("Livespace API call", { module, method, url: apiUrl });

    const lsRes = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });

    const responseText = await lsRes.text();
    console.log("Livespace API response", { status: lsRes.status, body: responseText.substring(0, 500) });
    
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
    // On error: { result: errorCode, status: false, error: {...} }
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

    // Check for status: false (authentication or other errors)
    if (responseData.status === false) {
      console.error("Livespace API status false:", responseData);
      return new Response(
        JSON.stringify({
          error: `Livespace error code: ${responseData.result}. Check API credentials.`,
          code: responseData.result,
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
