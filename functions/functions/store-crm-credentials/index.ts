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
    throw new Error(`Livespace getToken error: code ${data.result}`);
  }
  
  if (!data.data?.token || !data.data?.session_id) {
    throw new Error("Livespace getToken: missing token or session_id in response");
  }
  
  return {
    token: data.data.token,
    sessionId: data.data.session_id,
  };
}

// Make authenticated Livespace API call
async function callLivespaceApi(
  domain: string,
  apiKey: string,
  apiSecret: string,
  module: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  // Step 1: Get token and session
  const { token, sessionId } = await getLivespaceAuth(domain, apiKey);
  
  // Step 2: Calculate signature: SHA1(api_key + token + api_secret)
  const signatureData = apiKey + token + apiSecret;
  const signature = await sha1(signatureData);
  
  console.log("Livespace auth - token length:", token.length, "session:", sessionId);
  console.log("Livespace signature calculated from:", `apiKey(${apiKey.length}) + token(${token.length}) + apiSecret(${apiSecret.length})`);
  
  // Step 3: Make authenticated request
  const apiUrl = `${domain}/api/public/json/${module}/${method}`;
  
  const formData = new FormData();
  formData.append("_api_auth", "key");
  formData.append("_api_key", apiKey);
  formData.append("_api_sha", signature);
  formData.append("_api_session", sessionId);
  
  // Add method params
  for (const [key, value] of Object.entries(params)) {
    formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  
  console.log("Calling Livespace API:", apiUrl);
  
  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error("Livespace API call failed:", response.status, errorText);
    throw new Error(`Livespace API error (${response.status}): ${errorText}`);
  }
  
  const data = await response.json();
  console.log("Livespace API response:", JSON.stringify(data).substring(0, 500));
  
  if (data.status === false) {
    throw new Error(`Livespace API error: code ${data.result}`);
  }
  
  return data;
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

      console.log("Verifying Livespace connection with normalized domain:", normalizedDomain);

      // Verify Livespace API key by calling User_getInfo with proper auth flow
      const verifyData = await callLivespaceApi(
        normalizedDomain,
        api_key,
        api_secret,
        "Default",
        "User_getInfo"
      ) as { result?: { email?: string; name?: string } };

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
