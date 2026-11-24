// ChiSave Square register link — Cloudflare Worker.
//
// What it does: lets the store connect their Square register once, so sales
// flow into ChiSave on their own. The worker only swaps the sign-in code for
// an access token; it never sees sales. The token goes back to the app in the
// web address (#square_token=...) and lives on the store's phone only.
//
// Endpoints:
//   GET  /auth?state=...&return_to=...  — starts Square sign-in
//   GET  /callback?code=...&state=...   — swaps the code for a token, sends
//                                          the clerk back to the app
//   POST /proxy/v2/...                  — CORS fallback: forwards the app's
//                                          own Square call with its token
//
// Deploy (needs a Square developer app — NOT set up yet):
//   1. Square Developer Dashboard (developer.squareup.com): create an app,
//      note the Sandbox/Production Application ID (= client ID) and the
//      OAuth secret. Set the app's Redirect URL to this worker's
//      /callback address, e.g. https://chisave-square.<you>.workers.dev/callback.
//      Use the Production credentials for a real store.
//   2. wrangler secret put SQUARE_CLIENT_ID
//      wrangler secret put SQUARE_CLIENT_SECRET
//   3. wrangler deploy
//   4. Paste the worker URL into ChiSave Settings ("Square helper web address").
//
// Safety: the client secret lives ONLY as a worker secret — never in the app,
// which anyone with the phone could read. The worker only redirects back to
// the ChiSave Pages address (allowedReturn), never anywhere else.

const SQUARE_AUTH = "https://connect.squareup.com/oauth2/authorize";
const SQUARE_TOKEN = "https://connect.squareup.com/oauth2/token";
const SQUARE_API = "https://connect.squareup.com";

function allowedReturn(url) {
  try {
    const u = new URL(url);
    return u.origin === "https://mightiest-g.github.io"
      && u.pathname.startsWith("/chisave/");
  } catch {
    return false;
  }
}

function pack(state, returnTo) {
  const raw = btoa(JSON.stringify({ s: state, r: returnTo }));
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpack(packed) {
  const s = packed.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(s));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const state = url.searchParams.get("state") || "";
      const returnTo = url.searchParams.get("return_to") || "";
      if (!allowedReturn(returnTo)) return new Response("bad return_to", { status: 400 });
      if (!env.SQUARE_CLIENT_ID) return new Response("square not configured", { status: 500 });
      const redirect = `${SQUARE_AUTH}?client_id=${encodeURIComponent(env.SQUARE_CLIENT_ID)}`
        + `&scope=ORDERS_READ&session=false`
        + `&redirect_uri=${encodeURIComponent(url.origin + "/callback")}`
        + `&state=${encodeURIComponent(pack(state, returnTo))}`;
      return Response.redirect(redirect, 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const packed = url.searchParams.get("state") || "";
      let decoded = { s: "", r: "" };
      try {
        decoded = unpack(packed);
      } catch {
        return new Response("bad state", { status: 400 });
      }
      if (!code || !allowedReturn(decoded.r)) {
        return new Response("bad code/return", { status: 400 });
      }
      if (!env.SQUARE_CLIENT_ID || !env.SQUARE_CLIENT_SECRET) {
        return new Response("square not configured", { status: 500 });
      }
      const tok = await fetch(SQUARE_TOKEN, {
        method: "POST",
        headers: { "Square-Version": "2024-12-18", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.SQUARE_CLIENT_ID,
          client_secret: env.SQUARE_CLIENT_SECRET,
          code, grant_type: "authorization_code",
        }),
      });
      if (!tok.ok) return new Response("square token exchange failed", { status: 502 });
      const { access_token } = await tok.json();
      let locationId = "";
      const loc = await fetch(SQUARE_API + "/v2/locations", {
        headers: {
          "Square-Version": "2024-12-18",
          Authorization: "Bearer " + access_token,
        },
      });
      if (loc.ok) {
        const lj = await loc.json();
        locationId = (lj.locations && lj.locations[0] && lj.locations[0].id) || "";
      }
      const hash = `#square_token=${encodeURIComponent(access_token)}`
        + `&square_location=${encodeURIComponent(locationId)}`
        + `&state=${encodeURIComponent(decoded.s)}`;
      return Response.redirect(decoded.r + hash, 302);
    }

    if (url.pathname.startsWith("/proxy/")) {
      // CORS fallback: the app posts here with its own token when the
      // browser blocks a direct call to Square.
      const target = SQUARE_API + url.pathname.slice("/proxy".length) + url.search;
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return new Response("missing token", { status: 401 });
      const res = await fetch(target, {
        method: request.method,
        headers: {
          "Square-Version": "2024-12-18",
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: request.method === "GET" ? undefined : await request.text(),
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("chisave square helper: /auth, /callback, /proxy/*", { status: 404 });
  },
};
