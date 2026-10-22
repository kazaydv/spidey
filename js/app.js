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
function initLogin(){
  const saved = sessionStorage.getItem("spidey_user");
  if(saved){ state.user = JSON.parse(saved); state.idToken = sessionStorage.getItem("spidey_token"); enterApp(); return; }
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
  $("#connState").textContent = CFG.WORKER_URL ? "connecting…" : "offline brain";
  if(CFG.WORKER_URL) loadDashboard();
  loadKnowledge();
  greet(preview);
}
function greet(preview){
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  speak(g + ", Siddhu. Spidey is ready." + (preview ? " Preview mode — brain connects after setup." : ""));
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
  return vs.find(v=>/Google UK English Male/i.test(v.name))
      || vs.find(v=>/en[-_]GB/i.test(v.lang) && /male|daniel|george|arthur|brian/i.test(v.name))
      || vs.find(v=>/en[-_]GB/i.test(v.lang))
      || vs.find(v=>/^en/i.test(v.lang)) || vs[0];
}
if("speechSynthesis" in window) speechSynthesis.onvoiceschanged = ()=>pickVoice();
function speak(text){
  return new Promise(res=>{
    addBubble("spidey", text);
    if(!("speechSynthesis" in window)){ res(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g,""));
    const v = pickVoice(); if(v) u.voice = v;
    u.rate = 1.02; u.pitch = 0.9;
    state.speaking = true; setOrb("speaking");
    u.onend = u.onerror = ()=>{ state.speaking = false; if(state.mode==="active") setOrb("listening"); else if(state.mode==="passive") setOrb("idle"); res(); };
    speechSynthesis.speak(u);
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
  r.onend = ()=>{ state.recogOn = false; if(state.mode==="passive" || state.mode==="active") setTimeout(()=>startRecog(), 350); };
  r.onerror = e=>{ if(e.error==="not-allowed"){ setStateText("Mic permission denied — allow microphone for Spidey."); state.mode="idle"; updateButtons(); } };
  return r;
}
function startRecog(){
  if(state.recogOn || state.speaking) return;
  if(!state.recog) state.recog = makeRecog();
  if(!state.recog){ setStateText("Voice input needs Chrome on Android/PC."); return; }
  try{ state.recog.start(); state.recogOn = true; }catch(e){}
}
function stopRecog(){ try{ state.recog && state.recog.stop(); }catch(e){} state.recogOn = false; }

let finalBuf = "", recogTimer = null;
function onResult(ev){
  if(state.speaking) return; // don't listen to our own voice
  let interim = "", finalTxt = "";
  for(let i = ev.resultIndex; i < ev.results.length; i++){
    const tr = ev.results[i][0].transcript;
    if(ev.results[i].isFinal) finalTxt += tr; else interim += tr;
  }
  $("#liveText").textContent = interim || finalTxt;
  const heard = (finalTxt || "").trim();
  if(!heard) return;
  if(state.mode === "passive"){
    if(/\bspidey\b/i.test(heard)){ // wake word
      state.mode = "active"; setOrb("listening"); updateButtons();
      const rest = heard.replace(/^.*?\bspidey\b[:,]?\s*/i, "").trim();
      speak("Yes, Siddhu?").then(()=>{ if(rest) handleUserText(rest); else startRecog(); });
    }
    return;
  }
  if(state.mode === "active"){
    finalBuf = heard;
    clearTimeout(recogTimer);
    recogTimer = setTimeout(()=>{ const t = finalBuf; finalBuf=""; if(t) handleUserText(t); }, 450);
  }
}

/* ---------- CONVERSATION ---------- */
async function handleUserText(text){
  addBubble("me", text);
  $("#liveText").textContent = "";
  setOrb("thinking"); setStateText("Thinking…");
  stopRecog();
  let reply = null;

  // Local reminder intent: "remind me at 6 pm to ..." / "remind me in 30 minutes ..."
  const rem = parseReminder(text);
  if(rem){
    await saveReminder(rem);
    reply = "Done, Siddhu. I'll remind you " + rem.whenText + ": " + rem.text + ". It'll come on Telegram and Discord too.";
  }

  if(!reply && CFG.WORKER_URL){
    try{ reply = await askWorker(text); }catch(e){ reply = null; }
  }
  if(!reply) reply = offlineAnswer(text);
  if(!reply) reply = "I heard you, Siddhu, but my full brain isn't connected yet. Finish the setup steps and I'll answer everything — sheets, web, reminders, all of it.";
  state.history.push({ role:"user", text }, { role:"spidey", text: reply });
  await speak(reply);
  setStateText(state.mode==="active" ? "Listening… just talk. Say “thank you Spidey” to stop." : "Tap the core and talk, or say “Hey Spidey”");
  if(state.mode==="active") startRecog();
}
async function askWorker(text){
  const r = await fetch(CFG.WORKER_URL.replace(/\/$/,"") + "/chat", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ session: state.session, email: state.user?.email, idToken: state.idToken, text, history: state.history.slice(-10) })
  });
  if(!r.ok) throw new Error("worker " + r.status);
  const j = await r.json();
  return j.reply || null;
}
async function loadDashboard(){
  try{
    const r = await fetch(CFG.WORKER_URL.replace(/\/$/,"") + "/dashboard?email=" + encodeURIComponent(state.user?.email||""));
    if(!r.ok) throw 0;
    const j = await r.json();
    $("#cardOrders").textContent = j.ordersToday ?? "—";
    $("#cardRevenue").textContent = j.revenueToday ? "Rs " + Number(j.revenueToday).toLocaleString("en-IN") : "—";
    $("#cardMail").textContent = j.collegeMail ?? "—";
    $("#connState").textContent = "brain live"; $("#connState").classList.add("live");
  }catch(e){ $("#connState").textContent = "offline brain"; }
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
  const d = document.createElement("div"); d.className = "bubble " + who; d.textContent = text;
  $("#chatLog").appendChild(d); d.scrollIntoView({ behavior:"smooth", block:"end" });
}
function setOrb(s){ $("#orbWrap").dataset.state = s; }
function setStateText(t){ $("#stateText").textContent = t; }
function updateButtons(){ $("#wakeBtn").textContent = "Wake word: " + (state.mode==="passive" ? "ON" : "OFF"); $("#talkBtn").textContent = state.mode==="active" ? "⏹ Stop conversation" : "🎙 Talk to Spidey"; }
$("#talkBtn").addEventListener("click", ()=>{
  if(state.mode === "active"){ state.mode = "idle"; stopRecog(); speechSynthesis.cancel(); setOrb("idle"); setStateText("Tap the core and talk, or say “Hey Spidey”"); }
  else { state.mode = "active"; if("Notification" in window) Notification.requestPermission().catch(()=>{}); setOrb("listening"); setStateText("Listening… just talk."); startRecog(); }
  updateButtons();
});
$("#orbWrap").addEventListener("click", ()=> $("#talkBtn").click());
$("#wakeBtn").addEventListener("click", ()=>{
  if(state.mode === "passive"){ state.mode = "idle"; stopRecog(); setOrb("idle"); }
  else { state.mode = "passive"; setOrb("idle"); setStateText("Wake word on — say “Hey Spidey” anytime this app is open."); startRecog(); }
  updateButtons();
});
$("#textForm").addEventListener("submit", e=>{ e.preventDefault(); const v = $("#textInput").value.trim(); if(!v) return; $("#textInput").value=""; if(state.mode!=="active") state.mode="active"; handleUserText(v); updateButtons(); });

window.addEventListener("load", initLogin);
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
