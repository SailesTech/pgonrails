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
  
  if (!data.result?.token || !data.result?.session_id) {
    throw new Error("Livespace getToken: missing token or session_id in response");
  }
  
  return {
    token: data.result.token,
    sessionId: data.result.session_id,
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
      .select("api_key_encrypted, api_secret_encrypted, domain")
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
    } else if (integration.platform === "livespace") {
      // Livespace requires api_secret and domain
      if (!credentials.api_secret_encrypted || !credentials.domain) {
        throw new Error("Missing Livespace credentials (api_secret, domain)");
      }

      // Decrypt API secret
      const { data: apiSecret, error: decryptSecretError } = await supabase.rpc("decrypt_api_key", {
        p_encrypted_key: credentials.api_secret_encrypted,
      });

      if (decryptSecretError || !apiSecret) {
        throw new Error("Failed to decrypt API secret");
      }

      console.log("Testing Livespace connection for domain:", credentials.domain);

      // Test Livespace connection via User_getInfo with proper auth flow
      const data = await callLivespaceApi(
        credentials.domain,
        apiKey,
        apiSecret,
        "Default",
        "User_getInfo"
      ) as { result?: { email?: string; name?: string } };

      return new Response(
        JSON.stringify({
          success: true,
          user: {
            email: data.result?.email,
            name: data.result?.name,
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
