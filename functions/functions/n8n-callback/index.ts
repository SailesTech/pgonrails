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

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body - handle both array and object formats
    let requestBody = await req.json();

    // If body is an array, extract first element
    if (Array.isArray(requestBody) && requestBody.length > 0) {
      requestBody = requestBody[0];
    }

    // Extract callos_data if present (N8N structure)
    let meeting_id = requestBody.meeting_id;
    let callback_token = requestBody.callback_token;
    let status = requestBody.status || 'completed';

    if (requestBody.callos_data) {
      meeting_id = requestBody.callos_data.meeting_id;
      callback_token = requestBody.callos_data.callback_token;
    }

    // Extract analysis data from 'analyze' field if present
    let analysis_data = requestBody.analysis_data;
    let overall_score = requestBody.overall_score;
    let transcript = requestBody.transcript;
    let title = requestBody.title;
    let meeting_date = requestBody.meeting_date;
    let duration = requestBody.duration;
    let deal_id = requestBody.deal_id;

    if (requestBody.analyze) {
      // N8N structure: map analyze object to analysis_data
      const analyze = requestBody.analyze;

      analysis_data = {
        title: analyze.title,
        feedback: analyze.feedback,
        summary: analyze.summary,
        todoList: analyze.todoList,
        crmMappings: analyze.crmMappings,
        successCriterias: analyze.successCriterias,
        agendaScript: analyze.agendaScript,
        processMapping: analyze.processMapping,
        email: analyze.email
      };

      // Add deal_id to analysis_data if provided
      if (requestBody.deal_id) {
        analysis_data.crm_deal_id = requestBody.deal_id;
        deal_id = requestBody.deal_id;
      }

      // Use transcript from root level if not in analyze
      transcript = requestBody.transcript;
      // Extract title from analyze object for meeting.title column
      title = analyze.title || requestBody.title;
      console.log('n8n-callback: Title from analyze:', title);
    } else if (requestBody.action_items) {
      // New N8N structure - transform to frontend-expected format
      console.log('n8n-callback: Transforming new N8N structure to frontend format');
      
      analysis_data = {
        // Transform action_items to todoList format
        todoList: {
          actionItems: (requestBody.action_items || []).map((item: any) => ({
            task: item.task,
            priority: item.priority,
            assignee: item.assignee,
            deadline: item.due_date,
            category: 'Action Item',
            status: item.status
          }))
        },
        
        // Transform AI insights to feedback format
        feedback: requestBody.ai_insights ? {
          questioningAnalysis: {
            score: requestBody.ai_insights.deal_health_score || 0,
          },
          strengthsAnalysis: {
            strengths: requestBody.ai_insights.sales_rep_performance ? 
              Object.entries(requestBody.ai_insights.sales_rep_performance).map(([key, value]) => ({
                feedback: `${key.replace(/_/g, ' ')}: ${value}`
              })) : []
          },
          improvementAnalysis: {
            improvements: (requestBody.ai_insights.areas_for_improvement || []).map((area: string) => ({
              feedback: area
            }))
          }
        } : undefined,
        
        // Summary from string to object format
        summary: {
          quickSummary: requestBody.summary || '',
          keyTopics: requestBody.key_points || [],
          nextSteps: requestBody.next_meeting?.agenda || []
        },
        
        // Email draft if available
        email: requestBody.email_draft ? {
          subject: requestBody.email_draft.subject || 'Follow-up',
          content: requestBody.email_draft.body || ''
        } : undefined,
        
        // CRM data
        crmMappings: requestBody.crm_updates?.custom_fields ?
          Object.entries(requestBody.crm_updates.custom_fields).map(([key, value]) => ({
            crmField: key,
            value: String(value)
          })) : [],
        
        // Keep original data for reference
        crm_deal_id: requestBody.crm_deal_id,
        ai_insights: requestBody.ai_insights,
        crm_updates: requestBody.crm_updates,
        key_points: requestBody.key_points,
        next_meeting: requestBody.next_meeting,
        recommendations: requestBody.recommendations,
        risks_and_opportunities: requestBody.risks_and_opportunities,
        sentiment_analysis: requestBody.sentiment_analysis,
        success_criteria_met: requestBody.success_criteria_met
      };
      
      // Extract title if available
      title = requestBody.title || requestBody.summary?.substring(0, 100);
      deal_id = requestBody.crm_deal_id;
      
      console.log('n8n-callback: Data transformed, title:', title);
    }

    if (!meeting_id || !callback_token) {
      throw new Error('meeting_id and callback_token are required');
    }

    console.log('n8n-callback: Received callback for meeting:', meeting_id, 'Status:', status);

    // 1. Verify callback token
    const { data: meeting, error: meetingError } = await supabase
      .from('meetings')
      .select('id, n8n_callback_token, organization_id, processing_status')
      .eq('id', meeting_id)
      .single();

    if (meetingError || !meeting) {
      throw new Error(`Meeting not found: ${meetingError?.message}`);
    }

    if (meeting.n8n_callback_token !== callback_token) {
      console.error('n8n-callback: Invalid callback token');
      throw new Error('Invalid callback token');
    }

    if (meeting.processing_status === 'completed') {
      console.warn('n8n-callback: Meeting already processed, ignoring duplicate callback');
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Meeting already processed (duplicate callback ignored)',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );
    }

    console.log('n8n-callback: Token verified, updating meeting');

    // 2. Update meeting with analysis results
    const updateData: any = {
      processing_status: status === 'failed' ? 'failed' : 'completed',
      processing_completed_at: new Date().toISOString(),
      n8n_callback_token: null, // Clear token after use (one-time use)
    };

    if (analysis_data) {
      updateData.analysis_data = analysis_data;
    }

    if (overall_score !== null && overall_score !== undefined) {
      updateData.overall_score = Math.max(0, Math.min(100, overall_score)); // Clamp to 0-100
    }

    // If N8N fetched the transcript (e.g., from Fireflies), update it
    if (transcript) {
      updateData.transcript = transcript;
      updateData.transcript_source = 'audio_url'; // Mark that transcript came from external audio source
      console.log('n8n-callback: Updating transcript from N8N (fetched from source)');
    }

    // If N8N fetched title from source or deal data, update it
    if (title) {
      updateData.title = title;
      console.log('n8n-callback: Updating title from N8N');
    }

    // If N8N provided updated meeting metadata, update it
    if (meeting_date) {
      updateData.meeting_date = meeting_date;
      console.log('n8n-callback: Updating meeting_date from N8N');
    }

    if (duration !== null && duration !== undefined) {
      updateData.duration = duration;
      console.log('n8n-callback: Updating duration from N8N');
    }

    // If N8N matched deal_id (e.g., by email/phone), save it in analysis_data
    if (deal_id && analysis_data) {
      if (!updateData.analysis_data) {
        updateData.analysis_data = analysis_data;
      }
      updateData.analysis_data = {
        ...updateData.analysis_data,
        crm_deal_id: deal_id
      };
      console.log('n8n-callback: Saving deal_id from N8N in analysis_data');
    }

    // ========== FIREFLIES INTEGRATION DATA ==========

    // Extract Fireflies metadata if present
    const meeting_metadata = requestBody.meeting_metadata;
    const participants = requestBody.participants;
    const audio_metadata = requestBody.audio_metadata;
    const timestamped_transcript = requestBody.timestamped_transcript;

    // Log Fireflies data presence
    console.log('n8n-callback: Fireflies data received:', {
      has_meeting_metadata: !!meeting_metadata,
      has_participants: !!participants,
      participants_count: participants?.length || 0,
      has_audio_metadata: !!audio_metadata,
      has_fireflies_id: !!meeting_metadata?.fireflies_id,
      has_audio_url: !!(meeting_metadata?.audio_url || audio_metadata?.audio_url),
      has_timestamped_transcript: !!timestamped_transcript,
      timestamped_transcript_length: timestamped_transcript?.length || 0,
    });

    // Fireflies ID
    if (meeting_metadata?.fireflies_id) {
      updateData.fireflies_id = meeting_metadata.fireflies_id;
      console.log('n8n-callback: Saving Fireflies ID:', meeting_metadata.fireflies_id);
    }

    // Audio URL (prioritize meeting_metadata, fallback to audio_metadata)
    const audioUrl = meeting_metadata?.audio_url || audio_metadata?.audio_url;
    if (audioUrl) {
      updateData.audio_url = audioUrl;
      console.log('n8n-callback: Saving audio URL');
    }

    // Duration from Fireflies (overwrite if provided, convert seconds to minutes if needed)
    if (meeting_metadata?.duration_seconds) {
      // If duration is in seconds, convert to minutes for backward compatibility
      updateData.duration = Math.round(meeting_metadata.duration_seconds / 60);
      console.log('n8n-callback: Updating duration from Fireflies:', updateData.duration, 'minutes');
    }

    // Meeting date from Fireflies (overwrite if provided)
    if (meeting_metadata?.meeting_date && !meeting_date) {
      updateData.meeting_date = meeting_metadata.meeting_date;
      console.log('n8n-callback: Updating meeting_date from Fireflies');
    }

    // Participants with talk time metrics (CRITICAL for meeting metrics)
    if (participants && Array.isArray(participants) && participants.length > 0) {
      updateData.participants = participants;
      console.log('n8n-callback: Saving participants with talk time metrics:', participants.length, 'participants');
    } else {
      console.warn('n8n-callback: WARNING - No participants data received from Fireflies');
    }

    // Audio metadata
    if (audio_metadata) {
      updateData.audio_metadata = audio_metadata;
      console.log('n8n-callback: Saving audio metadata');
    }

    // Timestamped transcript (optional, for audio player)
    if (timestamped_transcript && Array.isArray(timestamped_transcript) && timestamped_transcript.length > 0) {
      updateData.timestamped_transcript = timestamped_transcript;
      console.log('n8n-callback: Saving timestamped transcript:', timestamped_transcript.length, 'sentences');
    }

    const { error: updateError } = await supabase
      .from('meetings')
      .update(updateData)
      .eq('id', meeting_id);

    if (updateError) {
      console.error('n8n-callback: Failed to update meeting:', updateError);
      throw updateError;
    }

    console.log('n8n-callback: Meeting updated successfully');

    // 3. If status is completed and CRM sync is configured, trigger CRM sync
    if (status === 'completed') {
      console.log('n8n-callback: Checking if CRM sync is needed...');

      // Check if organization has active CRM integration
      const { data: crmIntegration } = await supabase
        .from('crm_integrations')
        .select('id, status')
        .eq('organization_id', meeting.organization_id)
        .eq('status', 'connected')
        .maybeSingle();

      if (crmIntegration) {
        console.log('n8n-callback: Triggering CRM sync...');

        // Call sync-to-crm function (fire and forget, don't wait for response)
        fetch(`${supabaseUrl}/functions/v1/sync-to-crm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            meeting_id,
            integration_id: crmIntegration.id,
          }),
        }).catch((error) => {
          console.error('n8n-callback: Failed to trigger CRM sync:', error);
          // Don't throw - this is a non-critical operation
        });

        console.log('n8n-callback: CRM sync triggered asynchronously');
      } else {
        console.log('n8n-callback: No active CRM integration, skipping sync');
      }
    }

    const processingDuration = Date.now() - startTime;
    console.log('n8n-callback: Completed in', processingDuration, 'ms');

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Analysis results saved successfully',
        meeting_id,
        processing_duration_ms: processingDuration,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('n8n-callback error:', error);
    const message = (error && (error as any).message) || 'Unknown error';
    return new Response(
      JSON.stringify({
        success: false,
        error: message,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
