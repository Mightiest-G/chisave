// ChiSave text service — Cloudflare Worker that sends one SMS via Twilio.
// The app only calls this when the store has set a "text service" URL in
// Settings. Without it, the app falls back to tap-to-text from the clerk's
// own phone (free, no account needed).
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
      return new Response("POST {to, body} only", { status: 405 });
    }
    let data;
    try {
      data = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const to = String(data.to || "").replace(/[^\d+]/g, "");
    const body = String(data.body || "").slice(0, 1500);
    if (!to || !body) return new Response("missing to/body", { status: 400 });
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
      return new Response("twilio not configured", { status: 500 });
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      return new Response("twilio error: " + err.slice(0, 300), { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
