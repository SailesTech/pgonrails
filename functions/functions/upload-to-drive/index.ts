import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fileName, mimeType, fileContent, folderId, description } = await req.json();

    if (!fileName || !mimeType || !fileContent) {
      throw new Error('Missing required parameters: fileName, mimeType, fileContent');
    }

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Initialize Supabase with user's auth
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Get user from JWT
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('Invalid authentication token');
    }

    // Get Google integration with access token
    const { data: integration, error: integrationError } = await supabase
      .from('google_integrations')
      .select('access_token_encrypted, drive_enabled')
      .eq('user_id', user.id)
      .single();

    if (integrationError || !integration) {
      throw new Error('Google integration not found. Please connect Drive first.');
    }

    if (!integration.drive_enabled) {
      throw new Error('Google Drive is not enabled. Please enable it in Integrations settings.');
    }

    // Decrypt access token
    const { data: accessToken, error: decryptError } = await supabase.rpc('decrypt_api_key', {
      p_encrypted_key: integration.access_token_encrypted,
    });

    if (decryptError || !accessToken) {
      throw new Error('Failed to decrypt access token. Please reconnect Drive.');
    }

    console.log('Uploading file to Google Drive:', fileName);

    // Build file metadata
    const metadata: any = {
      name: fileName,
      mimeType: mimeType,
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    if (description) {
      metadata.description = description;
    }

    // Create multipart upload request
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    // Decode base64 file content if it's base64 encoded
    let fileData = fileContent;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      // Extract base64 data from data URL
      const base64Data = fileContent.split(',')[1];
      fileData = base64Data;
    }

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      `Content-Type: ${mimeType}\r\n` +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      fileData +
      closeDelimiter;

    // Upload file to Google Drive
    const uploadResponse = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody,
      }
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Google Drive API error:', errorText);
      throw new Error(`Failed to upload file to Drive: ${errorText}`);
    }

    const result = await uploadResponse.json();
    console.log('File uploaded successfully, file ID:', result.id);

    // Get shareable link
    const fileLink = `https://drive.google.com/file/d/${result.id}/view`;

    return new Response(
      JSON.stringify({
        success: true,
        file_id: result.id,
        file_name: result.name,
        file_link: fileLink,
        mime_type: result.mimeType,
        size: result.size,
        web_view_link: result.webViewLink,
        web_content_link: result.webContentLink,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error uploading to Drive:', error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
