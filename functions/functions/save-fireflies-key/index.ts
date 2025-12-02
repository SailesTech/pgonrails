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

    console.log("Validating Fireflies API key for user:", userId);

    // Validate Fireflies API key
    const validateResponse = await fetch("https://api.fireflies.ai/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `
          query {
            user {
              user_id
              email
              name
            }
          }
        `,
      }),
    });

    const validateData = await validateResponse.json();

    if (!validateResponse.ok || !validateData.data?.user) {
      throw new Error(
        validateData.errors?.[0]?.message || "Invalid Fireflies API key"
      );
    }

    console.log("Fireflies API key validated successfully");

    // Encrypt API key using pgcrypto (same as CRM)
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

    // Upsert credentials (same as CRM)
    const { error: upsertError } = await supabase
      .from("fireflies_credentials")
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

    console.log("Fireflies credentials saved successfully");

    return new Response(
      JSON.stringify({
        success: true,
        user: validateData.data.user,
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
    console.error("save-fireflies-key error:", message);
    return new Response(
      JSON.stringify({ error: message, success: false }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
