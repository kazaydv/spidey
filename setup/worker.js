/* =====================================================================
   SPIDEY — Cloudflare Worker brain (free tier). One brain, three faces:
   voice web app (/chat), Discord bot (/discord/interactions), alerts.
   Secrets (set with `wrangler secret put NAME` — never in code):
     GEMINI_API_KEY      free key from Google AI Studio
     GOOGLE_CLIENT_ID    OAuth web client id (token audience check)
     BRIDGE_URL          Apps Script bridge /exec URL
     BRIDGE_KEY          shared secret with the bridge
     TELEGRAM_BOT_TOKEN  existing Telegram bot (reuse, don't make a new one)
     TELEGRAM_CHAT_ID    Siddhu's chat id
     DISCORD_BOT_TOKEN   Discord bot token
     DISCORD_CHANNEL_ID  #spidey channel id (alerts land here)
     DISCORD_PUBLIC_KEY  Discord app public key (interaction signature check)
   Vars (wrangler.toml): ALLOWED_EMAIL, GEMINI_MODEL
   KV binding: SPIDEY_KV  (reminders + learned facts cache)
   ===================================================================== */

const KNOWLEDGE = `
You are Spidey, Siddhu's personal Jarvis-style assistant. Friendly male persona, calm, quick, a little witty.
Always call him Siddhu. Language is fully mixed English + Nepali + Neplish: understand all of it and reply in the
same mix he used. You are a VOICE assistant: default to 1-3 short speakable sentences, no markdown, no lists,
unless he asks for detail. Never invent numbers: for orders, sales and sheet data use ONLY the LIVE SHEET CONTEXT
given below; if it is missing, say plainly "That data isn't loaded right now, Siddhu."
Scope: you can talk about ANYTHING Siddhu needs — general knowledge, news, study help for his college subjects,
coding, business advice, ideas, calculations — use web search grounding when facts may be current, and say when an
answer came from the web. Your deepest context is his work + college (below), so connect answers to that world when
it helps. You hold no personal-life data about him beyond what he tells you in conversation.
Work facts: Siddhu works at Yachu Gears; Yachu Books (books.yachugear.com) and Yachu Attendance; team includes Anup.
SWAS mouth patch supplier cost Rs 140/packet, sold via a landing page into an orders sheet + Telegram pipeline.
HPS is Himbuti Herbal Piles Spray. Telegram order bot posts team orders and creates NCM courier orders.
A closing bot posts the daily closing at 10:30 PM NPT (orders, pcs, revenue; "pending" counts as COD; the order
amount is the bundle price for all products together). Products include X1, Mouthwash, Brush Head.
College: Herald College Kathmandu, email domain heraldcollege.edu.np; college mail forwards to Telegram + Discord.
Telegram fails on his mobile data (WiFi only) so Discord is the reliable backup channel.
His projects: Hisab, Guff, Bato Update.
If he says "remember that X", confirm you saved it.
`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

/* ---------- auth: verify Google ID token + whitelist ---------- */
async function verifyUser(env, email, idToken) {
  if ((email || "").toLowerCase() !== (env.ALLOWED_EMAIL || "").toLowerCase()) return false;
  if (!idToken) return false;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!r.ok) return false;
    const j = await r.json();
    return (j.email || "").toLowerCase() === (env.ALLOWED_EMAIL || "").toLowerCase()
      && j.email_verified === "true"
      && (!env.GOOGLE_CLIENT_ID || j.aud === env.GOOGLE_CLIENT_ID);
  } catch (e) { return false; }
}

/* ---------- sheets bridge ---------- */
async function bridge(env, action, params = {}) {
  if (!env.BRIDGE_URL || !env.BRIDGE_KEY) return null;
  const url = new URL(env.BRIDGE_URL);
  url.searchParams.set("key", env.BRIDGE_KEY);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error("bridge " + r.status);
  return r.json();
}

/* ---------- Gemini (free tier) with web grounding ---------- */
async function askGemini(env, systemText, history, userText) {
  // Google closes older models to NEW API users (2.5-flash 404s on new keys since 2026),
  // so walk a fallback list on 404 instead of dying on one hardcoded model.
  // Free-tier reality (Oct 2026): Flash models allow only ~20 requests/day; Flash-LITE allows ~500/day.
  // Walk the list on 404 (model closed to new users) AND 429 (that model's quota is spent).
  const candidates = [...new Set([env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"].filter(Boolean))];
  let lastErr = null;
  for (const model of candidates) {
    try { return await askGeminiModel(env, model, systemText, history, userText); }
    catch (e) { lastErr = e; if (!/gemini (404|429|500|502|503)/.test(String(e))) throw e; }
  }
  throw lastErr || new Error("no Gemini model available");
}
async function askGeminiModel(env, model, systemText, history, userText) {
  const contents = [];
  for (const h of (history || []).slice(-10))
    contents.push({ role: h.role === "spidey" ? "model" : "user", parts: [{ text: h.text }] });
  contents.push({ role: "user", parts: [{ text: userText }] });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 400 }
    })
  });
  if (!r.ok) throw new Error("gemini " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "Sorry Siddhu, I didn't get that.";
}

/* ---------- alerts: Telegram + Discord (dual = reliable) ---------- */
async function sendAlerts(env, text) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    jobs.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: "🕷️ Spidey: " + text })
    }).catch(() => {}));
  if (env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID)
    jobs.push(fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bot " + env.DISCORD_BOT_TOKEN },
      body: JSON.stringify({ content: "🕷️ **Spidey:** " + text })
    }).catch(() => {}));
  await Promise.allSettled(jobs);
}

/* ---------- reminders in KV ---------- */
async function listReminders(env) {
  try { return JSON.parse((await env.SPIDEY_KV.get("reminders")) || "[]"); } catch (e) { return []; }
}
async function saveReminders(env, list) { await env.SPIDEY_KV.put("reminders", JSON.stringify(list.slice(-200))); }

/* ---------- main chat path (shared by voice app + Discord) ---------- */
async function spideyReply(env, session, history, text) {
  // "remember that ..." → learned fact, stored in the Spidey Memory sheet via bridge + KV cache
  const rem = text.match(/remember (that|this)[:\s]+(.+)/i);
  let sheetContext = "";
  try {
    const s = await bridge(env, "summary");
    if (s && s.contextText) sheetContext = s.contextText;
  } catch (e) { /* sheets offline — answer without them, never fake numbers */ }
  let facts = "";
  try { facts = (await env.SPIDEY_KV.get("facts")) || ""; } catch (e) {}
  const system = KNOWLEDGE
    + (facts ? "\nLearned facts Siddhu told you:\n" + facts : "")
    + (sheetContext ? "\n\nLIVE SHEET CONTEXT (the only source for numbers):\n" + sheetContext : "\n\n(No live sheet context right now.)")
    + "\nNepal time now: " + new Date().toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" });
  const reply = await askGemini(env, system, history, text);
  if (rem) {
    const fact = rem[2].trim();
    try { const f = JSON.parse((await env.SPIDEY_KV.get("facts_json")) || "[]"); f.push(fact); await env.SPIDEY_KV.put("facts_json", JSON.stringify(f.slice(-100))); await env.SPIDEY_KV.put("facts", f.join("\n")); } catch (e) {}
    try { await bridge(env, "learn", { fact }); } catch (e) {}
  }
  try { await bridge(env, "log", { session, user: text.slice(0, 500), spidey: reply.slice(0, 500) }); } catch (e) {}
  return reply;
}

/* ---------- Discord interaction signature (Ed25519) ---------- */
function hexToBytes(hex) { const b = new Uint8Array(hex.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16); return b; }
async function verifyDiscord(env, req, rawBody) {
  if (!env.DISCORD_PUBLIC_KEY) return false;
  const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(sig), new TextEncoder().encode(ts + rawBody));
  } catch (e) { return false; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/" && req.method === "GET")
      return json({ ok: true, name: "Spidey brain", owner: env.ALLOWED_EMAIL });

    if (url.pathname === "/chat" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (!(await verifyUser(env, b.email, b.idToken))) return json({ error: "not authorized" }, 403);
      try { return json({ reply: await spideyReply(env, b.session || "app", b.history || [], String(b.text || "")) }); }
      catch (e) { return json({ error: String(e).slice(0, 200) }, 502); }
    }

    if (url.pathname === "/dashboard" && req.method === "GET") {
      try {
        const s = await bridge(env, "summary");
        return json({ ordersToday: s?.ordersToday ?? null, revenueToday: s?.revenueToday ?? null, collegeMail: s?.collegeMail ?? null });
      } catch (e) { return json({ ordersToday: null, revenueToday: null, collegeMail: null }); }
    }

    if (url.pathname === "/remind" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (!(await verifyUser(env, b.email, b.idToken))) return json({ error: "not authorized" }, 403);
      const list = await listReminders(env);
      list.push({ at: b.at, text: b.text, sent: false });
      await saveReminders(env, list);
      return json({ ok: true });
    }

    if (url.pathname === "/discord/interactions" && req.method === "POST") {
      const raw = await req.text();
      if (!(await verifyDiscord(env, req, raw))) return new Response("bad signature", { status: 401 });
      const it = JSON.parse(raw);
      if (it.type === 1) return json({ type: 1 }); // PING → PONG
      if (it.type === 2 && it.data?.name === "spidey") {
        const q = (it.data.options || []).find(o => o.name === "ask")?.value || "hello";
        ctx.waitUntil((async () => {
          let reply;
          try { reply = await spideyReply(env, "discord", [], String(q)); }
          catch (e) { reply = "Sorry Siddhu, my brain hit an error just now."; }
          await fetch(`https://discord.com/api/v10/webhooks/${it.application_id}/${it.token}/messages/@original`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: reply.slice(0, 1900) })
          }).catch(() => {});
        })());
        return json({ type: 5 }); // deferred — answer follows via waitUntil
      }
      // Message-context / future command types: acknowledge safely
      return json({ type: 4, data: { content: "Use /spidey ask: <your question>, Siddhu." } });
    }

    return json({ error: "not found" }, 404);
  },

  /* Cron every minute (wrangler.toml): fire due reminders to Telegram + Discord */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const list = await listReminders(env);
      const now = Date.now();
      const due = list.filter(r => !r.sent && new Date(r.at).getTime() <= now);
      if (!due.length) return;
      for (const r of due) { await sendAlerts(env, "Reminder, Siddhu: " + r.text); r.sent = true; }
      await saveReminders(env, list.filter(r => !r.sent || new Date(r.at).getTime() > now - 86400000));
    })());
  }
};
