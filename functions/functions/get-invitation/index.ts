import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { token } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Token is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Fetching invitation for token:", token.substring(0, 8) + "...");

    // Create admin client to bypass RLS
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // Fetch invitation with organization name
    const { data: invitation, error } = await supabaseAdmin
      .from("team_invitations")
      .select("email, role, expires_at, organizations(name)")
      .eq("token", token)
      .is("accepted_at", null)
      .maybeSingle();

    if (error) {
      console.error("Database error:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch invitation" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!invitation) {
      console.log("Invitation not found or already accepted");
      return new Response(
        JSON.stringify({ 
          valid: false, 
          error: "Invitation not found or already accepted" 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if expired
    const isExpired = new Date(invitation.expires_at) < new Date();
    if (isExpired) {
      console.log("Invitation has expired");
      return new Response(
        JSON.stringify({ 
          valid: false, 
          error: "Invitation has expired" 
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Valid invitation found for:", invitation.email);

    // Handle organizations as either object or array
    const orgData = invitation.organizations as { name: string } | { name: string }[] | null;
    const organizationName = Array.isArray(orgData) ? orgData[0]?.name : orgData?.name;

    return new Response(
      JSON.stringify({
        valid: true,
        email: invitation.email,
        role: invitation.role,
        organization_name: organizationName,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
