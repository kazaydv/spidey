"use strict";
/* SPIDEY web app — voice-first. Continuous conversation + "Hey Spidey" wake word (while open).
   Brain lives in the Cloudflare Worker (WORKER_URL). Offline fallback answers from knowledge.json. */
const CFG = window.SPIDEY_CONFIG || {};
const $ = s => document.querySelector(s);
const state = {
  user: null, idToken: null,
  mode: "idle",            // idle | passive (wake word) | active (conversation)
  recog: null, recogOn: false, speaking: false,
  history: [], knowledge: null, session: "s" + Date.now().toString(36)
};
$("#verFoot").textContent = CFG.APP_VERSION || "v1";

/* ---------- LOGIN (Google, whitelist = kazayadav@gmail.com only) ---------- */
function decodeJwt(t){ try{ return JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))); }catch(e){ return null; } }
function onGoogleCredential(resp){
  const p = decodeJwt(resp.credential);
  if(!p){ $("#loginMsg").textContent = "Login failed — try again."; return; }
  if((p.email||"").toLowerCase() !== (CFG.ALLOWED_EMAIL||"").toLowerCase() || p.email_verified === false){
    $("#loginMsg").textContent = "This Spidey is private — only " + CFG.ALLOWED_EMAIL + " can enter.";
    if(window.google) google.accounts.id.disableAutoSelect();
    return;
  }
  state.user = p; state.idToken = resp.credential;
  sessionStorage.setItem("spidey_user", JSON.stringify(p));
  sessionStorage.setItem("spidey_token", resp.credential);
  enterApp();
}
function tokenAlive(tok){
  const p = tok && decodeJwt(tok);
  return !!(p && p.exp && p.exp * 1000 > Date.now() + 90000); // Google ID tokens live ~1h
}
function initLogin(){
  const saved = sessionStorage.getItem("spidey_user");
  const savedTok = sessionStorage.getItem("spidey_token");
  if(saved && tokenAlive(savedTok)){ state.user = JSON.parse(saved); state.idToken = savedTok; enterApp(); return; }
  if(saved && !tokenAlive(savedTok)){ sessionStorage.removeItem("spidey_token"); $("#loginMsg").textContent = "Session expired (Google logins last ~1 hour) — sign in again, one tap."; }
  if(CFG.GOOGLE_CLIENT_ID && window.google){
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleCredential });
    google.accounts.id.renderButton($("#googleBtnWrap"), { theme:"filled_black", size:"large", shape:"pill", text:"signin_with" });
  } else if(!CFG.GOOGLE_CLIENT_ID){
    $("#loginMsg").textContent = "Setup step pending: Google Client ID not set yet (SETUP.md step 2).";
    $("#previewBtn").classList.remove("hidden");
  }
}
$("#previewBtn").addEventListener("click", ()=>{ state.user = { name:"Siddhu (preview)", email: CFG.ALLOWED_EMAIL }; enterApp(true); });
$("#signOutBtn").addEventListener("click", ()=>{ sessionStorage.clear(); location.reload(); });

function enterApp(preview){
  $("#loginScreen").classList.add("hidden");
  $("#hudScreen").classList.remove("hidden");
  $("#connState").textContent = CFG.WORKER_URL ? "LINKING…" : "OFFLINE BRAIN";
  setSys("sysLogin", "ONLINE", "ok");
  setSys("sysVer", (CFG.APP_VERSION || "?") + (CFG.WORKER_URL ? " · LINKED" : " · NO URL"), CFG.WORKER_URL ? "ok" : "bad");
  if(!SR) setSys("sysVoice", "NO MIC API", "bad");
  if(CFG.WORKER_URL){ setSys("sysBrain", "LINKING", "warn"); loadDashboard(); }
  loadKnowledge();
  greet(preview);
}
function setSys(id, text, cls){ const el = document.getElementById(id); if(!el) return; el.textContent = text; el.className = "st " + cls; }
/* Kathmandu clock */
setInterval(()=>{
  const now = new Date();
  const c = $("#nptClock"), d = $("#nptDate"); if(!c) return;
  c.textContent = now.toLocaleTimeString("en-GB", { timeZone:"Asia/Kathmandu", hour12:false });
  d.textContent = now.toLocaleDateString("en-GB", { timeZone:"Asia/Kathmandu", weekday:"short", day:"2-digit", month:"short" }).toUpperCase() + " · NPT";
}, 1000);
function greet(preview){
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  addBubble("spidey", g + ", Siddhu. Say 'Hey Spidey' or tap TALK, then just talk — I'll listen first." + (preview ? " Preview mode." : ""));
}

/* ---------- KNOWLEDGE / OFFLINE BRAIN ---------- */
async function loadKnowledge(){
  try{ state.knowledge = await (await fetch("knowledge.json")).json(); }catch(e){ state.knowledge = { offlineAnswers: [] }; }
}
function offlineAnswer(text){
  const t = " " + text.toLowerCase() + " ";
  if(/\b(time|samaya)\b/.test(t)) return "Siddhu, it's " + new Date().toLocaleTimeString("en-GB",{hour:"numeric",minute:"2-digit"}) + " right now.";
  if(/\b(date|today|aaja)\b/.test(t) && /\b(date|what day|aaja k)\b/.test(t)) return "Today is " + new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}) + ", Siddhu.";
  for(const a of (state.knowledge?.offlineAnswers||[])) if(a.match.some(m => t.includes(m))) return a.answer;
  return null;
}

/* ---------- SPEECH OUT (friendly male; prefers UK English male) ---------- */
function pickVoice(){
  const vs = speechSynthesis.getVoices();
  const local = vs.filter(v=>v.localService); // on-device voices never stall waiting for network TTS
  const pool = local.length ? local : vs;
  return pool.find(v=>/Google UK English Male/i.test(v.name))
      || pool.find(v=>/en[-_]GB/i.test(v.lang) && /male|daniel|george|arthur|brian/i.test(v.name))
      || pool.find(v=>/en[-_]GB/i.test(v.lang))
      || pool.find(v=>/^en/i.test(v.lang)) || vs.find(v=>/^en/i.test(v.lang)) || vs[0];
}
if("speechSynthesis" in window) speechSynthesis.onvoiceschanged = ()=>pickVoice();
function speak(text){
  return new Promise(res=>{
    addBubble("spidey", text);
    if(!("speechSynthesis" in window)){ res(); return; }
    let done = false;
    const finish = ()=>{ if(done) return; done = true; state.speaking = false; state.speakFinish = null; state.speakingText = "";
      if(state.mode==="active") setOrb("listening"); else if(state.mode==="passive") setOrb("idle"); res(); };
    try{ speechSynthesis.cancel(); }catch(e){}
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g,""));
    const v = pickVoice(); if(v) u.voice = v;
    u.rate = 1.06; u.pitch = 0.9;
    state.speaking = true; state.speakFinish = finish; state.speakingText = text; setOrb("speaking");
    u.onend = u.onerror = finish;
    // Watchdog: some Android Chrome builds never fire onend (stuck speaking = deaf Spidey).
    // If the utterance overruns its estimate, force-finish so conversation can continue.
    const est = Math.min(22000, 2800 + text.length * 95);
    setTimeout(()=>{ if(!done){ try{ speechSynthesis.cancel(); }catch(e){} finish(); } }, est);
    try{ speechSynthesis.speak(u); }catch(e){ finish(); }
    // Barge-in: keep the mic live during speech (conversation mode) so Siddhu can interrupt.
    if(state.mode === "active") setTimeout(()=>{ if(state.speaking) startRecog(true); }, 120);
  });
}

/* ---------- SPEECH IN (continuous, auto-restart = reliability) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function makeRecog(){
  if(!SR) return null;
  const r = new SR();
  r.continuous = true; r.interimResults = true;
  r.lang = "en-IN"; // best free fit for Siddhu's English/Neplish mix; Nepali words still pass through as sounds-to-text
  r.onresult = onResult;
  r.onend = ()=>{ state.recogOn = false; if(state.mode==="passive" || state.mode==="active") setTimeout(()=>startRecog(state.speaking && state.mode==="active"), 300); };
  r.onerror = e=>{ if(e.error==="not-allowed"){ setStateText("Mic permission denied — allow microphone for Spidey."); state.mode="idle"; updateButtons(); } };
  return r;
}
function startRecog(force){
  if(state.recogOn) return;
  if(state.speaking && !force) return; // force = barge-in listening while Spidey talks
  if(!state.recog) state.recog = makeRecog();
  if(!state.recog){ setStateText("Voice input needs Chrome on Android/PC."); return; }
  try{ state.recog.start(); state.recogOn = true; }catch(e){}
}
function stopRecog(){ try{ state.recog && state.recog.stop(); }catch(e){} state.recogOn = false; }

let finalBuf = "", recogTimer = null, interimTimer = null, lastCommitted = "", lastCommitAt = 0;
function commitHeard(heard){
  const now = Date.now();
  if(heard === lastCommitted && now - lastCommitAt < 2500) return; // dedupe interim-commit vs late final
  lastCommitted = heard; lastCommitAt = now;
  if(state.mode === "active"){
    finalBuf = heard;
    clearTimeout(recogTimer);
    recogTimer = setTimeout(()=>{ const t = finalBuf; finalBuf=""; if(t) handleUserText(t); }, 850); // wait for a real pause — react only after Siddhu finishes
  }
}
function normTxt(s){ return (s||"").toLowerCase().replace(/[^a-z0-9\u0900-\u097F ]/gi," ").replace(/\s+/g," ").trim(); }
function onResult(ev){
  let interim = "", finalTxt = "";
  for(let i = ev.resultIndex; i < ev.results.length; i++){
    const tr = ev.results[i][0].transcript;
    if(ev.results[i].isFinal) finalTxt += tr; else interim += tr;
  }
  if(state.speaking){
    // Self-heal a stuck flag first: synth silent means we are NOT speaking.
    if(!(window.speechSynthesis && speechSynthesis.speaking)){ state.speaking = false; }
    else {
      // Barge-in check: real user speech (not Spidey's own echo) cuts Spidey off instantly.
      const h = normTxt(finalTxt || interim);
      const spoken = normTxt(state.speakingText);
      const isEcho = !h || h.length < 3 || (spoken && (spoken.includes(h) || h.split(" ").every(w => !w || spoken.includes(w))));
      const strong = !!finalTxt.trim() || h.split(" ").filter(Boolean).length >= 3; // don't cut in on a stray syllable
      if(isEcho || !strong) return; // echo = Spidey's own voice; weak = not a real interruption yet
      try{ speechSynthesis.cancel(); }catch(e){}
      if(state.speakFinish) state.speakFinish(); // resolves speak(), sets speaking=false
      setOrb("listening"); setStateText("LISTENING · JUST TALK");
      // fall through: process what Siddhu just said
    }
  }
  $("#liveText").textContent = interim || finalTxt;
  // Some Android builds are slow to mark finals — if interim text sits stable, treat it as said.
  if(interim.trim() && state.mode !== "idle"){
    clearTimeout(interimTimer);
    const snapshot = interim.trim();
    interimTimer = setTimeout(()=>{ if(state.mode !== "idle" && !state.speaking) commitHeard(snapshot); }, 2200); // safety net only — long stable pause counts as finished
  }
  const heard = (finalTxt || "").trim();
  if(!heard) return;
  clearTimeout(interimTimer);
  if(state.mode === "passive"){
    if(/\bspidey\b/i.test(heard)){ // wake word → straight to listening, no spoken greeting first
      state.mode = "active"; setOrb("listening"); setStateText("LISTENING · JUST TALK"); updateButtons();
      const rest = heard.replace(/^.*?\bspidey\b[:,]?\s*/i, "").trim();
      if(rest) handleUserText(rest); else startRecog();
    }
    return;
  }
  if(state.mode === "active"){ commitHeard(heard); }
}

/* ---------- CONVERSATION ---------- */
async function handleUserText(text){
  addBubble("me", text);
  $("#liveText").textContent = "";
  const el = $("#errLine"); if(el) el.textContent = "";
  setOrb("thinking"); setStateText("Thinking…");
  stopRecog();
  let reply = null;

  // Local reminder intent: "remind me at 6 pm to ..." / "remind me in 30 minutes ..."
  const rem = parseReminder(text);
  if(rem){
    await saveReminder(rem);
    reply = "Done, Siddhu. I'll remind you " + rem.whenText + ": " + rem.text + ". It'll come on Telegram and Discord too.";
  }

  let brainError = null;
  if(!reply && CFG.WORKER_URL){
    try{ reply = await askWorker(text); }catch(e){ brainError = String(e && e.message || e); }
  }
  if(!reply && !CFG.WORKER_URL) reply = offlineAnswer(text);
  if(!reply){
    if(brainError && brainError.startsWith("AUTH")){
      reply = brainError;
      const el = $("#errLine"); if(el) el.textContent = "⚠ " + brainError;
    } else if(brainError){
      const el = $("#errLine"); if(el) el.textContent = "⚠ BRAIN ERROR: " + brainError;
      addBubble("spidey", "⚠ BRAIN ERROR: " + brainError);
      state.history.push({ role:"user", text }, { role:"spidey", text: "Brain error: " + brainError });
      await speak("Sorry Siddhu, my brain hit an error just now. The exact error is on the console — tell me what it says.");
      afterReply(); return;
    } else {
      reply = offlineAnswer(text) || "I heard you, Siddhu, but my full brain isn't connected yet. Finish the setup steps and I'll answer everything — sheets, web, reminders, all of it.";
    }
  }
  state.history.push({ role:"user", text }, { role:"spidey", text: reply });
  await speak(reply);
  afterReply();
}
function afterReply(){
  setStateText(state.mode==="active" ? "LISTENING · JUST TALK" : "SYSTEM READY · SAY ‘HEY SPIDEY’ OR TAP TALK");
  if(state.mode==="active") startRecog();
}
function refreshGoogleToken(){
  return new Promise(resolve=>{
    if(!window.google || !CFG.GOOGLE_CLIENT_ID) return resolve(false);
    let settled = false; const done = ok => { if(!settled){ settled = true; resolve(ok); } };
    try{
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: r=>{
        if(r && r.credential && tokenAlive(r.credential)){
          state.idToken = r.credential; sessionStorage.setItem("spidey_token", r.credential);
          const p = decodeJwt(r.credential); if(p){ state.user = p; sessionStorage.setItem("spidey_user", JSON.stringify(p)); }
          done(true);
        } else done(false);
      }});
      google.accounts.id.prompt();
    }catch(e){ done(false); }
    setTimeout(()=>done(false), 7000);
  });
}
async function askWorkerOnce(text){
  const r = await fetch(CFG.WORKER_URL.replace(/\/$/,"") + "/chat", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ session: state.session, email: state.user?.email, idToken: state.idToken, text, history: state.history.slice(-10) })
  });
  const j = await r.json().catch(()=>({}));
  return { status: r.status, reply: j.reply || null, error: j.error || null };
}
async function askWorker(text){
  let out = await askWorkerOnce(text);
  if(out.status === 403){ // almost always: the ~1h Google token expired
    const ok = await refreshGoogleToken();
    if(ok) out = await askWorkerOnce(text);
    if(out.status === 403) throw new Error("AUTH — Google session expired. Sign out (EXIT) and sign in again.");
  }
  if(out.reply) return out.reply;
  if(out.error) throw new Error(out.error.slice(0, 140));
  throw new Error("worker returned no reply (status " + out.status + ")");
}
async function loadDashboard(){
  try{
    const r = await fetch(CFG.WORKER_URL.replace(/\/$/,"") + "/dashboard?email=" + encodeURIComponent(state.user?.email||""));
    if(!r.ok) throw 0;
    const j = await r.json();
    $("#cardOrders").textContent = j.ordersToday ?? "—";
    $("#cardRevenue").textContent = j.revenueToday ? "Rs " + Number(j.revenueToday).toLocaleString("en-IN") : "—";
    $("#cardMail").textContent = j.collegeMail ?? "—";
    $("#connState").textContent = "BRAIN LIVE"; $("#connState").classList.add("live");
    setSys("sysBrain", "ONLINE", "ok"); setSys("sysSheets", "ONLINE", "ok");
  }catch(e){ $("#connState").textContent = "OFFLINE BRAIN"; setSys("sysBrain", "UNREACHABLE", "bad"); setSys("sysSheets", "UNREACHABLE", "bad"); }
}

/* ---------- REMINDERS ---------- */
function parseReminder(text){
  const t = text.toLowerCase();
  if(!/remind/.test(t)) return null;
  let at = null, whenText = "";
  let m = t.match(/in (\d+)\s*(minute|min|hour|hr)/);
  if(m){ const mins = parseInt(m[1]) * (m[2].startsWith("h") ? 60 : 1); at = new Date(Date.now() + mins*60000); whenText = "in " + m[1] + " " + m[2]; }
  if(!at && (m = t.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/))){
    at = new Date(); let hh = parseInt(m[1]) % 12; if(/pm/.test(m[3]||"")) hh += 12; if(!m[3] && parseInt(m[1]) < 7) hh += 12; // evening bias for bare hours like "at 8"
    at.setHours(hh, parseInt(m[2]||"0"), 0, 0); if(at < new Date()) at.setDate(at.getDate()+1);
    whenText = "at " + at.toLocaleTimeString("en-GB",{hour:"numeric",minute:"2-digit"});
  }
  if(!at) return null;
  const what = text.replace(/.*?\bremind me\b/i,"").replace(/\b(at|in)\b.*$/i,"").replace(/^\s*(to|that)\s*/i,"").trim() || "your reminder";
  return { at: at.toISOString(), whenText, text: what };
}
async function saveReminder(rem){
  const all = JSON.parse(localStorage.getItem("spidey_reminders")||"[]"); all.push(rem);
  localStorage.setItem("spidey_reminders", JSON.stringify(all));
  if(CFG.WORKER_URL){ try{ await fetch(CFG.WORKER_URL.replace(/\/$/,"") + "/remind", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ ...rem, email: state.user?.email, idToken: state.idToken }) }); }catch(e){} }
}
setInterval(()=>{
  const now = Date.now(); const all = JSON.parse(localStorage.getItem("spidey_reminders")||"[]");
  const due = all.filter(r => new Date(r.at).getTime() <= now);
  if(due.length){
    localStorage.setItem("spidey_reminders", JSON.stringify(all.filter(r => new Date(r.at).getTime() > now)));
    due.forEach(r => { speak("Reminder, Siddhu: " + r.text); if("Notification" in window && Notification.permission==="granted") new Notification("Spidey reminder", { body: r.text }); });
  }
}, 20000);

/* ---------- UI ---------- */
function addBubble(who, text){
  const d = document.createElement("div"); d.className = "bubble " + who;
  const w = document.createElement("span"); w.className = "who"; w.textContent = who === "me" ? "SIDDHU" : "SPIDEY";
  d.appendChild(w); d.appendChild(document.createTextNode(text));
  $("#chatLog").appendChild(d); d.scrollIntoView({ behavior:"smooth", block:"end" });
}
function setOrb(s){ $("#orbWrap").dataset.state = s; }
function setStateText(t){ $("#stateText").textContent = t; }
function updateButtons(){ $("#wakeBtn").textContent = "WAKE WORD · " + (state.mode==="passive" ? "ON" : "OFF"); $("#talkBtn").textContent = state.mode==="active" ? "■ STOP" : "◉  TALK TO SPIDEY"; }
$("#talkBtn").addEventListener("click", ()=>{
  if(state.mode === "active"){ state.mode = "idle"; stopRecog(); speechSynthesis.cancel(); setOrb("idle"); setStateText("SYSTEM READY · SAY ‘HEY SPIDEY’ OR TAP TALK"); }
  else { state.mode = "active"; if("Notification" in window) Notification.requestPermission().catch(()=>{}); setOrb("listening"); setStateText("LISTENING · JUST TALK"); startRecog(); }
  updateButtons();
});
$("#orbWrap").addEventListener("click", ()=> $("#talkBtn").click());
$("#wakeBtn").addEventListener("click", ()=>{
  if(state.mode === "passive"){ state.mode = "idle"; stopRecog(); setOrb("idle"); }
  else { state.mode = "passive"; setOrb("idle"); setStateText("WAKE WORD ACTIVE · SAY ‘HEY SPIDEY’"); startRecog(); }
  updateButtons();
});
$("#textForm").addEventListener("submit", e=>{ e.preventDefault(); const v = $("#textInput").value.trim(); if(!v) return; $("#textInput").value=""; if(state.mode!=="active") state.mode="active"; handleUserText(v); updateButtons(); });

window.addEventListener("load", initLogin);
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
