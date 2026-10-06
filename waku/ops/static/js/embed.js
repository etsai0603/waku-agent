// waku embedded chat — the bootstrap for embed.html (spec 008), LOADS LAST.
// Stands in for main.js on a page that is only the chat column: no views, no
// /api/data, no timers polling the whole dashboard. Classic <script>, shared
// global scope like the rest (static/README.md).

// --- the few globals render.js and dock.js expect from main.js -------------
// They are main.js's names with the chat column's meaning: there is no paused
// banner to clear and no view to re-render, and "refresh" re-reads only what
// the header draws.
let paused = false;
function render(){}

// What the header needs (History, the model picker, the thread to restore),
// read from /api/session?action=state rather than /api/data, which carries
// the memory, the traces and the spend: an embed session is refused that
// route (hosted/gateway/embed.py), and the chat does not need it.
//
// Always a person's doing, never a timer's: it runs when the page opens, after
// a turn they sent, and after a model they picked. Nothing here polls, so a
// framed chat left open never holds a hosted container awake.
async function refresh(){
  try {
    const res = await fetch("/api/session?action=state");
    noteStatus(res.status);
    if (!res.ok) return;
    const st = await res.json();
    D = {sessions: st.sessions || [], settings: st.settings || {},
         current_session: st.current_session};
    syncModelChip();
    applyTele();
  } catch(e){ /* the container is waking or gone: keep what is shown */ }
}

// --- the page around us (spec 008 F) ---------------------------------------
// The origins this page was served with: hosted, the gateway's frame-ancestors
// allowlist; locally, waku.one's three hosts (dashboard.py, embed_page).
const EMBED_ORIGINS = (document.body.dataset.embedOrigins || "").split(/\s+/).filter(Boolean);

// The origin of the page that framed us, or null. From document.referrer,
// which is the framing page for the iframe's first document and survives the
// /auth/embed redirect, and ONLY if it is on the allowlist: postMessage is
// never sent to "*", and never to an origin the gateway would not let frame
// this page. Not framed, no referrer, or a referrer off the list: null, and
// nothing is posted.
function embedParentOrigin(){
  if (window.parent === window) return null;
  let origin = null;
  try { origin = new URL(document.referrer).origin; } catch(e){ return null; }
  return EMBED_ORIGINS.includes(origin) ? origin : null;
}
function tellParent(message){
  const origin = embedParentOrigin();
  if (!origin) return;
  window.parent.postMessage({source: "waku-agent", ...message}, origin);
}

// turn-done after every turn, however it ended: credits may have moved even
// when the reply is an error. report-saved once per saved report. The header
// is re-read after each turn too, since nothing here polls: History learns of
// the conversation the turn just wrote to.
const reportsTold = new Set();
turnWatchers.push(ev => {
  if (ev.kind === "report" && ev.memory_id && !reportsTold.has(ev.memory_id)){
    reportsTold.add(ev.memory_id);
    tellParent({type: "report-saved", memory_id: ev.memory_id, title: ev.title || ""});
  } else if (ev.kind === "turn_end"){
    tellParent({type: "turn-done", credits_changed: true});
    refresh();
  }
});

// session-expired when a chat call comes back 401: the embed session ended
// (12 hours, or a sign-out anywhere). Every call the chat makes reports its
// status through noteStatus (util.js). Told once; waku.one asks /v1/embed for
// a new code and reloads the frame.
let expiredTold = false;
statusWatchers.push(status => {
  if (status !== 401 || expiredTold) return;
  expiredTold = true;
  tellParent({type: "session-expired"});
});

// --- the full dashboard, in a new tab ------------------------------------------
// The "Dashboard" button. This frame's session is the embed one, which opens
// the chat and nothing else, so a plain link to "/" would land on the sign-in
// page. Instead the button asks the gateway for a one-time sign-in code with
// the session the frame already has (POST /auth/dashboard, hosted/gateway/
// embed.py DASHBOARD_PATH) and opens /auth/enter?code= in a new tab: the same
// hand-off a sign-in uses, which makes the dashboard's own session in a tab
// that is first-party.
// The tab is opened FIRST, empty, while the click still counts as the
// person's: a window.open after an await is a popup most browsers block. It
// is then cut loose from this frame (opener = null) before it navigates.
// Locally there is no gateway and nothing to sign in to: the route is not
// there, and the tab goes straight to the dashboard. Only a same-origin
// /auth/enter address from the gateway is followed, never anything else.
const DASHBOARD_HANDOFF = "/auth/dashboard";
async function openDashboard(){
  const tab = window.open("", "_blank");
  let target = "/";
  try {
    const res = await fetch(DASHBOARD_HANDOFF, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    noteStatus(res.status);
    if (res.ok){
      const answer = await res.json();
      if (answer && typeof answer.url === "string" && answer.url.startsWith("/auth/enter?code=")) target = answer.url;
    }
  } catch(e){ /* the plain address still works: it asks them to sign in */ }
  if (tab){
    tab.opener = null;
    tab.location.replace(target);
  } else {
    window.open(target, "_blank", "noopener");
  }
}

// --- the console's theme (waku-memory spec 040 T) ---------------------------
// Framed, the chat wears the theme of the page around it, not its own. The
// first paint comes from the server: waku.one adds ?theme= to the address and
// dashboard.py puts data-theme on <html> before any CSS applies. After that
// the console posts {"source": "waku-console", "type": "theme", "theme": ...}
// whenever its theme changes, an OS change included when it follows the
// system.
//
// NEVER STORED. The frame shares localStorage with the person's own dashboard
// on the same host, where "waku-theme" is the choice they made with the
// toggle. The console's theme is the console's: writing it there would change
// the dashboard's look the next time they open it directly. So it is applied
// and held here, and the stored choice is read only when no console theme
// came at all (an old waku.one, or the page opened on its own).
const CONSOLE_THEMES = ["light", "dark"];
const servedTheme = document.documentElement.dataset.theme;
let consoleTheme = CONSOLE_THEMES.includes(servedTheme) ? servedTheme : null;
function applyConsoleTheme(t){
  consoleTheme = t;
  applyTheme(t);   // theme.js; deliberately not cycleTheme, which stores it
}

// --- what the page around us may ask (waku-memory spec 040 P2, T, V) --------
// Three messages, and only these three:
//   {"source": "waku-console", "type": "new-chat"}: waku.one's own "New chat"
//     starts one here, through the same newChat() as "+ New chat". A chat
//     that is already empty is left as it is.
//   {"source": "waku-console", "type": "theme", "theme": "light"|"dark"}: the
//     console's theme, applied and not stored (above).
//   {"source": "waku-console", "type": "ask", "prompt": "brief-new",
//    "since": "<ISO-8601 time>"}: the bird's brief card's "Ask Waku"
//     (waku-memory spec 040 V). Starts a new chat and sends ONE fixed sentence
//     as if the person had typed it. The console never sends words: `prompt`
//     is an id this page maps to its own sentence (ASK_PROMPTS), so neither
//     waku.one nor anything impersonating it can put text in the person's
//     mouth. `since` is the only value that reaches the sentence, and only as
//     a time this page parsed and wrote back itself: an ISO-8601 timestamp
//     with a zone, within the last 90 days, not in the future.
// Accepted ONLY from window.parent, and only when its origin is on the
// allowlist this page was served with: never from "*", never from this
// frame's own origin, never from another window. Every other message is
// ignored, a theme other than exactly "light" or "dark" included, and an ask
// with an unknown prompt id or a bad `since`.
const ASK_PROMPTS = {
  "brief-new": since => "Brief me on what's new in my Waku Memory since " + since + ".",
};
const ASK_SINCE_DAYS = 90;
const ASK_SKEW_MS = 5 * 60 * 1000;   // a console clock a little ahead is not "the future"
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The `since` an ask may carry, written back as this page's own ISO string,
// or null when it is not a zoned ISO-8601 time in the last 90 days.
function askSince(value, now){
  if (typeof value !== "string" || !ISO_TIME.test(value)) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  if (t > now + ASK_SKEW_MS || t < now - ASK_SINCE_DAYS * 86400000) return null;
  return new Date(t).toISOString();
}

// The sentence an ask sends, or null for anything this page does not know.
function askSentence(data, now){
  if (typeof data.prompt !== "string" || !Object.prototype.hasOwnProperty.call(ASK_PROMPTS, data.prompt)) return null;
  const since = askSince(data.since, now);
  return since ? ASK_PROMPTS[data.prompt](since) : null;
}

// A new chat, then the sentence through sendChat, which waits for the new
// chat to open before it posts (render.js), exactly as a message typed in
// that gap does.
function askInNewChat(sentence){
  if (CHAT.length) newChat();
  sendChat({value: sentence, focus(){}});
}

function acceptParentMessage(event){
  if (!event || event.source !== window.parent || window.parent === window) return false;
  const own = window.location && window.location.origin;
  if (!event.origin || event.origin === own || !EMBED_ORIGINS.includes(event.origin)) return false;
  const data = event.data;
  if (!data || typeof data !== "object" || data.source !== "waku-console") return false;
  if (data.type === "theme"){
    if (typeof data.theme !== "string" || !CONSOLE_THEMES.includes(data.theme)) return false;
    applyConsoleTheme(data.theme);
    return true;
  }
  if (data.type === "ask"){
    const sentence = askSentence(data, Date.now());
    if (!sentence) return false;
    askInNewChat(sentence);
    return true;
  }
  if (data.type !== "new-chat") return false;
  if (!CHAT.length) return false;   // already a new chat: nothing to start
  newChat();
  return true;
}
window.addEventListener("message", acceptParentMessage);

// --- voice: the browser's own speech recognition -----------------------------
// The dashboard's mic records audio for the local Whisper, which a hosted
// container does not have. Here the browser turns speech into text itself, so
// the button shows only where the browser can: Chrome, Edge and Safari. Chrome
// sends the audio to Google to do it. Nothing records until the person clicks.
// The ring's size follows the microphone's loudness, read every frame.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = null;

const RING_FRAG = `precision highp float;
uniform float uTime; uniform float uAmplitude; uniform vec2 uResolution; uniform vec3 uInk; uniform vec3 uBg;
float bayer(vec2 c){vec2 p=floor(mod(c,8.0));float x=p.x,y=p.y;
 float i=1.0*mod(x,2.0)+2.0*mod(y,2.0)+4.0*mod(floor(x/2.0),2.0)+8.0*mod(floor(y/2.0),2.0)+16.0*mod(floor(x/4.0),2.0)+32.0*mod(floor(y/4.0),2.0);
 return (i+0.5)/64.0;}
void main(){vec2 uv=gl_FragCoord.xy/uResolution*2.0-1.0;uv.x*=uResolution.x/uResolution.y;
 float t=uTime*0.5;float a=clamp(uAmplitude,0.0,1.2);
 float r=0.21+a*0.11+sin(t*0.9)*0.012;float th=0.07+a*0.05+sin(t*0.63)*0.009;
 float d=length(uv);float ring=smoothstep(r+th,r,d)-smoothstep(r,r-th,d);
 float glow=exp(-14.0*abs(d-r));float halo=exp(-6.5*d*(1.0+a*0.35));
 float k=clamp(ring*0.75+glow*0.5+halo*0.08,0.0,1.0);
 gl_FragColor=vec4(mix(uBg,uInk,step(bayer(gl_FragCoord.xy),k)),1.0);}`;

// A token as the shader's [r, g, b], laid over the ground when it is see-through.
function tokenRGB(probe, token, ground){
  probe.style.color = `var(${token})`;
  const c = getComputedStyle(probe).color;
  const n = (c.replace(/^color\(srgb/, "").match(/[\d.]+/g) || []).map(Number);
  const rgb = c.startsWith("color(") ? n.slice(0, 3) : n.slice(0, 3).map(v => v / 255);
  const a = n.length > 3 ? n[3] : 1;
  return ground ? rgb.map((v, i) => v * a + ground[i] * (1 - a)) : rgb;
}

function drawRing(state){
  const canvas = document.getElementById("listen-ring");
  const gl = canvas && canvas.getContext("webgl", {antialias: false});
  if (!gl) return;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, RING_FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = n => gl.getUniformLocation(prog, n);
  const probe = document.createElement("span"); probe.hidden = true; canvas.after(probe);
  let amp = 0.08;
  const frame = now => {
    if (listening !== state) { probe.remove(); return; }
    const box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    const w = Math.round(box.width * ratio), h = Math.round(box.height * ratio);
    if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    if (state.analyser){
      state.analyser.getFloatTimeDomainData(state.buf);
      let sum = 0; for (const v of state.buf) sum += v * v;
      state.level = Math.min(1.1, 0.04 + Math.sqrt(Math.sqrt(sum / state.buf.length)) * 1.6);
    } else state.level = Math.max(0.06, state.level * 0.95);
    // Rises fast and falls slower, so each syllable shows as its own swell.
    amp += (state.level - amp) * (state.level > amp ? 0.35 : 0.1);
    const ground = tokenRGB(probe, "--surface-bg");
    gl.uniform1f(u("uTime"), now * 0.001); gl.uniform1f(u("uAmplitude"), amp);
    gl.uniform2f(u("uResolution"), w, h);
    gl.uniform3fv(u("uInk"), tokenRGB(probe, "--text-muted", ground)); gl.uniform3fv(u("uBg"), ground);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    document.getElementById("listen-done").style.transform = `translate(-50%, -50%) scale(${1 + amp * 0.12})`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function startListening(){
  if (!SpeechRec || listening) return;
  const state = {words: "", level: 0.06, rec: new SpeechRec(), stream: null, ctx: null, analyser: null};
  listening = state;
  const words = document.getElementById("listen-words");
  words.textContent = "…";
  document.getElementById("listen").hidden = false;
  state.rec.continuous = true; state.rec.interimResults = true;
  state.rec.lang = navigator.language || "en-US";
  state.rec.onresult = e => {
    let text = ""; for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    state.words = text.trim(); words.textContent = state.words || "…";
    if (!state.analyser) state.level = 0.7;   // no meter: each result is a swell
  };
  state.rec.onerror = e => {
    if (listening === state && (e.error === "not-allowed" || e.error === "service-not-allowed"))
      words.textContent = "The microphone is blocked. Allow it in the address bar, then try again.";
  };
  try { state.rec.start(); } catch(e){ /* already started */ }
  drawRing(state);
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({audio: true});
    if (listening !== state){ state.stream.getTracks().forEach(t => t.stop()); return; }
    state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.analyser = state.ctx.createAnalyser(); state.analyser.fftSize = 1024;
    state.ctx.createMediaStreamSource(state.stream).connect(state.analyser);
    state.buf = new Float32Array(state.analyser.fftSize);
  } catch(e){ /* no meter: the ring swells on each recognised result instead */ }
}

// keep: the dot. The words go in the field, unsent, for the person to check.
function stopListening(keep){
  const state = listening;
  if (!state) return;
  listening = null;
  try { state.rec.stop(); } catch(e){}
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  if (state.ctx) state.ctx.close();
  document.getElementById("listen").hidden = true;
  const input = document.getElementById("dmsg");
  if (keep && state.words && input){ input.value = state.words; autogrow(input); input.focus(); }
}

function wireVoice(){
  const button = document.getElementById("dvoice");
  if (!button || !SpeechRec) return;
  button.hidden = false;
  button.onclick = startListening;
  document.getElementById("listen-cancel").onclick = () => stopListening(false);
  document.getElementById("listen-done").onclick = () => stopListening(true);
  // Send sends what was said at once; the dot only puts it in the field.
  document.getElementById("listen-send").onclick = () => {
    const input = document.getElementById("dmsg");
    if (listening && listening.words && input){ stopListening(true); sendChat(input); }
  };
}

// --- bootstrap --------------------------------------------------------------
applyTheme(consoleTheme || currentTheme());
watchSlots();
wireComposer();
wireVoice();
syncChatLogs();
(async () => {
  await refresh();
  // Restore the current thread so a reload never looks like it lost the chat.
  if (D && D.current_session) await loadThreadInto(D.current_session, {setSession: true});
})();
