import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { token, password, first_name, last_name } = await req.json();

    if (!token) {
      throw new Error('Token is required');
    }

    console.log('Processing invitation with token:', token.substring(0, 8) + '...');

    // 1. Pobierz i zwaliduj zaproszenie
    const { data: invitation, error: invError } = await supabaseAdmin
      .from('team_invitations')
      .select('*, organizations(name)')
      .eq('token', token)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (invError || !invitation) {
      console.error('Invalid invitation:', invError);
      throw new Error('Invalid or expired invitation');
    }

    console.log('Found invitation for:', invitation.email, 'to org:', invitation.organization_id);

    // 2. Sprawdź czy użytkownik już istnieje
    const { data: existingUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (listError) {
      console.error('Error listing users:', listError);
      throw listError;
    }

    const existingUser = existingUsers.users.find(u => u.email === invitation.email);

    let userId: string;
    let isNewUser = false;

    if (existingUser) {
      // SCENARIUSZ B: User już istnieje - tylko dodaj do nowej organizacji
      console.log('User already exists, adding to organization');
      userId = existingUser.id;

      // Sprawdź czy user już nie ma roli w tej organizacji
      const { data: existingRole } = await supabaseAdmin
        .from('user_roles')
        .select('id')
        .eq('user_id', userId)
        .eq('organization_id', invitation.organization_id)
        .maybeSingle();

      if (existingRole) {
        throw new Error('User already belongs to this organization');
      }
    } else {
      // SCENARIUSZ A: Nowy user - utwórz konto
      console.log('Creating new user');

      if (!password || !first_name || !last_name) {
        throw new Error('Password, first_name and last_name are required for new users');
      }

      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: invitation.email,
        password: password,
        email_confirm: true,
        user_metadata: {
          first_name,
          last_name,
          skip_org_creation: 'true', // Flaga dla triggera - NIE twórz organizacji
        }
      });

      if (createError) {
        console.error('Error creating user:', createError);
        throw createError;
      }

      userId = newUser.user.id;
      isNewUser = true;
      console.log('Created new user:', userId);
    }

    // 3. Dodaj rolę do organizacji
    const { error: roleError } = await supabaseAdmin
      .from('user_roles')
      .insert({
        user_id: userId,
        organization_id: invitation.organization_id,
        role: invitation.role,
      });

    if (roleError) {
      console.error('Error adding role:', roleError);
      throw roleError;
    }

    console.log('Added role', invitation.role, 'to user', userId);

    // 4. Oznacz zaproszenie jako zaakceptowane
    const { error: updateError } = await supabaseAdmin
      .from('team_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('token', token);

    if (updateError) {
      console.error('Error updating invitation:', updateError);
      // Nie rzucamy błędu - user już został dodany
    }

    console.log('Invitation accepted successfully');

    return new Response(
      JSON.stringify({
        success: true,
        is_new_user: isNewUser,
        email: invitation.email,
        organization_name: invitation.organizations?.name || 'Organization',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error accepting invitation:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
