// ChiSave text service — Cloudflare Worker that sends SMS via Twilio.
// The app calls this once with the whole regulars list ({to: [...], body})
// when the clerk taps "Send to all by text service". A single number still
// works ({to: "+1773...", body}) — the old app version sends one call each.
//
// Deploy (needs a Twilio account — NOT set up yet):
//   1. Twilio console: buy a US number (~$1.15/mo) and copy the Account SID
//      + Auth Token. SMS is ~$0.0079 per message.
//   2. wrangler secret put TWILIO_ACCOUNT_SID
//      wrangler secret put TWILIO_AUTH_TOKEN
//      wrangler secret put TWILIO_FROM        (your Twilio number, +1...)
//   3. wrangler deploy
//   4. Paste the worker URL into ChiSave Settings ("text service web address").
//
// Safety: the worker only ever sends the exact body the app posts, to the
// exact number the app posts. It never reads the store's customer list and
// never sends anything on its own. Keep the auth token a secret — never put
// it in the app, which anyone with the phone could read.

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST {to, body} only — to can be one number or a list", { status: 405 });
    }
    let data;
    try {
      data = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const targets = Array.isArray(data.to) ? data.to : [data.to];
    const body = String(data.body || "").slice(0, 1500);
    const clean = targets
      .map((t) => String(t || "").replace(/[^\d+]/g, ""))
      .filter(Boolean);
    if (!clean.length || !body) return new Response("missing to/body", { status: 400 });
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
      return new Response("twilio not configured", { status: 500 });
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    let sent = 0, failed = 0;
    for (const to of clean) {
      const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      if (res.ok) sent++;
      else failed++;
    }
    return new Response(JSON.stringify({ ok: failed === 0, sent, failed }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
