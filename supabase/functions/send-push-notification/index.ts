/**
 * send-push-notification — sends web push notifications to subscribed users.
 *
 * Accepts:
 *   { user_ids: string[], title: string, body: string, url?: string, tag?: string }
 *
 * OR internal call (service role) for triggers:
 *   { person_id: string, title: string, body: string, url?: string, tag?: string }
 *   -> looks up all care circle members + owner and sends to all
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "./_shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'No authorization header' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorized' }, 401);

    const db = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const body = await req.json();
    const { user_ids, person_id, title, body: notifBody, url, tag } = body;

    if (!title || !notifBody) {
      return json({ error: 'title and body required' }, 400);
    }

    // Determine target user IDs
    let targetUserIds: string[] = [];

    if (user_ids && Array.isArray(user_ids)) {
      targetUserIds = user_ids;
    } else if (person_id) {
      // Look up the person's owner
      const { data: person } = await db
        .from('people')
        .select('user_id')
        .eq('id', person_id)
        .single();

      if (person) {
        targetUserIds.push(person.user_id);
      }

      // Look up care circle members
      const { data: members } = await db
        .from('care_circle_members')
        .select('user_id')
        .eq('person_id', person_id)
        .eq('status', 'accepted');

      if (members) {
        for (const m of members) {
          if (m.user_id && targetUserIds.indexOf(m.user_id) === -1) {
            targetUserIds.push(m.user_id);
          }
        }
      }
    } else {
      return json({ error: 'user_ids or person_id required' }, 400);
    }

    if (targetUserIds.length === 0) {
      return json({ sent: 0, message: 'No target users found' });
    }

    // Check notification preferences — respect push_enabled
    const { data: prefs } = await db
      .from('notification_preferences')
      .select('user_id, push_enabled')
      .in('user_id', targetUserIds);

    const disabledUsers = new Set<string>();
    if (prefs) {
      for (const p of prefs) {
        if (p.push_enabled === false) disabledUsers.add(p.user_id);
      }
    }

    const enabledUserIds = targetUserIds.filter(id => !disabledUsers.has(id));

    if (enabledUserIds.length === 0) {
      return json({ sent: 0, message: 'All target users have push disabled' });
    }

    // Fetch push subscriptions
    const { data: subs, error: subsErr } = await db
      .from('push_subscriptions')
      .select('*')
      .in('user_id', enabledUserIds);

    if (subsErr) {
      console.error('Error fetching subscriptions:', subsErr.message);
      return json({ error: 'Failed to fetch subscriptions' }, 500);
    }

    if (!subs || subs.length === 0) {
      return json({ sent: 0, message: 'No push subscriptions found' });
    }

    const payload = JSON.stringify({
      title,
      body: notifBody,
      url: url || 'https://mywellet.com',
      tag: tag || 'wellet',
      icon: 'https://mywellet.com/wellet-icon-192.png'
    });

    // Send notifications using the Push API
    // Note: Full Web Push encryption requires ECDH + HKDF + AES-GCM.
    // For the initial implementation, we store subscription info and
    // use the browser's Notification API via the service worker.
    // The push delivery is handled by sending to the push service endpoint.
    let sent = 0;
    let failed = 0;
    const expiredEndpoints: string[] = [];

    for (const sub of subs) {
      try {
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'TTL': '86400',
            'Urgency': 'normal',
          },
          body: new Uint8Array(0), // Empty body — notification content comes from service worker polling
        });

        if (res.status === 201 || res.status === 200) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          expiredEndpoints.push(sub.endpoint);
          failed++;
        } else {
          failed++;
          console.warn(`Push failed for ${sub.user_id}: ${res.status}`);
        }
      } catch (e) {
        failed++;
        console.warn(`Push error for ${sub.user_id}:`, (e as Error).message);
      }
    }

    // Clean up expired subscriptions
    if (expiredEndpoints.length > 0) {
      await db
        .from('push_subscriptions')
        .delete()
        .in('endpoint', expiredEndpoints);
    }

    // Also insert into notifications table for in-app display
    const notifRows = targetUserIds.map(uid => ({
      user_id: uid,
      person_id: person_id || null,
      type: tag || 'push',
      title: title,
      body: notifBody,
      read: false,
    }));

    await db.from('notifications').insert(notifRows).catch(e => 
      console.warn('Notification insert error:', e.message)
    );

    return json({ sent, failed, expired_cleaned: expiredEndpoints.length });
  } catch (e) {
    console.error('send-push-notification error:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
