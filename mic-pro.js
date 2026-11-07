// mic-pro.js — مايك احترافي لـ Café Life (ملف خاص بالصوت: ما تلمس غيرو كي تطوّر المايك)
// السلسلة: AEC + (voiceIsolation كان موجود) -> فلتر هدير -> إزالة ضجيج طيفية (AudioWorklet) -> ضاغط -> بوّابة ناعمة -> محدّد
// يستعمل من index.html:  const m = await MicPro.open();  m.track = الصوت اللي يتبعث   |   MicPro.close()
(function () {
  if (window.MicPro) return;

  const DEF = { nr: 18, gain: 1.4, mode: 'pro' };
  let cfg = Object.assign({ monitor: false }, DEF);
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('micpro') || '{}')); } catch (e) {}
  cfg.monitor = false;                                     // اسمع صوتك: يتطفى كل مرة (خطر feedback)
  const save = () => { try { localStorage.setItem('micpro', JSON.stringify({ nr: cfg.nr, gain: cfg.gain })); } catch (e) {} };

  /* ===== إزالة الضجيج الطيفية (Wiener + decision-directed) — تخدم في thread الصوت =====
     FFT 512 بتداخل 50%، تقدير ضجيج لكل تردد (يتأقلم وحدو)، تنعيم باش ما يبقاش "صوت روبوت" */
  const WORKLET = `
class NSPro extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'reduction', defaultValue: 18, minValue: 0, maxValue: 40, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    const N = 512, H = 256, B = N / 2 + 1;
    this.N = N; this.H = H; this.B = B; this.gmin = 0.12;
    this.w = new Float32Array(N); for (let i = 0; i < N; i++) this.w[i] = Math.sin(Math.PI * (i + 0.5) / N);
    this.cs = new Float32Array(N / 2); this.sn = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cs[i] = Math.cos(2 * Math.PI * i / N); this.sn[i] = -Math.sin(2 * Math.PI * i / N); }
    const lg = Math.log2(N); this.rev = new Uint16Array(N);
    for (let i = 1; i < N; i++) this.rev[i] = (this.rev[i >> 1] >> 1) | ((i & 1) << (lg - 1));
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.inb = new Float32Array(N); this.pend = new Float32Array(H); this.np = 0; this.ola = new Float32Array(N);
    this.oq = new Float32Array(8192); this.ow = 0; this.rd = 0;
    this.P = new Float32Array(B); this.S = new Float32Array(B); this.nz = new Float32Array(B);
    this.gp = new Float32Array(B).fill(1); this.pp = new Float32Array(B).fill(1); this.g = new Float32Array(B);
    this.fr = 0; this.nE = 1e-9;
  }
  fft() {
    const N = this.N, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cs[k], wi = this.sn[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  frame() {
    const N = this.N, H = this.H, B = this.B, re = this.re, im = this.im, w = this.w;
    const P = this.P, S = this.S, nz = this.nz, gp = this.gp, pp = this.pp, g = this.g;
    this.inb.copyWithin(0, H); this.inb.set(this.pend, N - H);
    for (let i = 0; i < N; i++) { re[i] = this.inb[i] * w[i]; im[i] = 0; }
    this.fft();
    let E = 0;
    for (let k = 0; k < B; k++) { const p = re[k] * re[k] + im[k] * im[k]; P[k] = p; E += p; }
    const fr = this.fr++;
    if (fr < 24) {                                   // معايرة أولى (أول 0.13 ثانية)
      for (let k = 0; k < B; k++) { S[k] = P[k]; nz[k] = (nz[k] * fr + P[k]) / (fr + 1); }
    } else {
      const up = (E < this.nE * 3) ? 1.01 : 1.0006;  // ضجيج فقط: يتأقلم بسرعة، كلام: ما يطلعش
      for (let k = 0; k < B; k++) {
        S[k] = 0.8 * S[k] + 0.2 * P[k];
        if (S[k] < nz[k]) nz[k] = 0.85 * nz[k] + 0.15 * S[k]; else nz[k] *= up;
      }
    }
    let nsum = 0; for (let k = 0; k < B; k++) nsum += nz[k];
    this.nE = nsum * 1.5 + 1e-12;
    const gmin = this.gmin;
    for (let k = 0; k < B; k++) {
      const post = P[k] / (nz[k] * 1.5 + 1e-12);
      const prio = 0.97 * gp[k] * gp[k] * pp[k] + 0.03 * Math.max(post - 1, 0);
      pp[k] = post;
      let G = prio / (1 + prio); if (G < gmin) G = gmin; g[k] = G;
    }
    let gs = 0;
    for (let k = 0; k < B; k++) {
      const a = g[k > 0 ? k - 1 : 0], b = g[k], c = g[k < B - 1 ? k + 1 : B - 1];
      const s = (a + 2 * b + c) * 0.25; gp[k] = s; gs += s;
      re[k] *= s; im[k] *= s;
      if (k > 0 && k < B - 1) { re[N - k] *= s; im[N - k] *= s; }
    }
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this.fft();
    const iN = 1 / N;
    for (let i = 0; i < N; i++) this.ola[i] += re[i] * iN * w[i];
    for (let i = 0; i < H; i++) this.oq[this.ow++ & 8191] = this.ola[i];
    this.ola.copyWithin(0, H); this.ola.fill(0, N - H);
    if ((fr & 15) === 0) this.port.postMessage({ n: 10 * Math.log10(this.nE / B + 1e-12), g: gs / B });
  }
  process(inp, out, par) {
    const x = inp[0] && inp[0][0], y = out[0] && out[0][0];
    if (!y) return true;
    this.gmin = Math.pow(10, -par.reduction[0] / 20);
    if (!x) { y.fill(0); return true; }
    for (let i = 0; i < x.length; i++) { this.pend[this.np++] = x[i]; if (this.np === this.H) { this.frame(); this.np = 0; } }
    for (let i = 0; i < y.length; i++) y[i] = (this.ow - this.rd > 0) ? this.oq[this.rd++ & 8191] : 0;
    return true;
  }
}
registerProcessor('ns-pro', NSPro);
`;

  /* ===== الحالة ===== */
  const MODES = {
    pro:     { ns: false, ours: true,  label: 'احترافي' },      // إلغاء الصدى + إزالة ضجيجنا (من غير نظام المتصفح)
    both:    { ns: true,  ours: true,  label: 'الاثنين' },      // نظام المتصفح + نظامنا
    browser: { ns: true,  ours: false, label: 'المتصفح فقط' }   // بلا معالجة منا (فلتر + محدّد برك)
  };
  if (!MODES[cfg.mode]) cfg.mode = 'pro';
  const save2 = () => { try { localStorage.setItem('micpro', JSON.stringify({ nr: cfg.nr, gain: cfg.gain, mode: cfg.mode })); } catch (e) {} };
  let ctx = null, raw = null, timer = null, blobUrl = null, dstStream = null;
  let live = { ns: null, makeup: null, mon: null };
  let level = -90, gateOpen = false, nsInfo = { n: -90, g: 1 }, hasNS = false;
  let rec = null;                                         // جمع قياسات وقت الاختبار
  const GATE = { MARGIN_DB: 7, MIN_DB: -62, CLOSED: 0.35, HOLD_MS: 300 };

  async function open() {
    close();
    const M = MODES[cfg.mode];
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    try { ctx.resume && ctx.resume(); } catch (e) {}
    const base = { echoCancellation: true, noiseSuppression: M.ns, autoGainControl: false, channelCount: 1, sampleRate: 48000 };
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: M.ns ? Object.assign({ advanced: [{ voiceIsolation: true }] }, base) : base, video: false });
    } catch (e) {
      raw = await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
    }
    const src = ctx.createMediaStreamSource(raw);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 14000; lp.Q.value = 0.7;   // كان 8000: يخلّي الصوت مكتوم
    let ns = null;
    if (M.ours) {
      try {
        if (ctx.audioWorklet) {
          if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(blobUrl);
          ns = new AudioWorkletNode(ctx, 'ns-pro', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
          ns.parameters.get('reduction').value = cfg.nr;
          ns.port.onmessage = e => { nsInfo = e.data; };
        }
      } catch (e) { ns = null; }
    }
    hasNS = !!ns;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 20; comp.ratio.value = 2.2; comp.attack.value = 0.008; comp.release.value = 0.25;   // ضغط خفيف (ما يعملش pumping)
    const makeup = ctx.createGain(); makeup.gain.value = cfg.gain;
    const gate = ctx.createGain(); gate.gain.value = M.ours ? GATE.CLOSED : 1;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    const an = ctx.createAnalyser(); an.fftSize = 1024;           // بعد التنقية (قبل البوّابة)
    const anRaw = ctx.createAnalyser(); anRaw.fftSize = 1024;     // الأصلي من المتصفح
    const mon = ctx.createGain(); mon.gain.value = cfg.monitor ? 1 : 0;
    const dst = ctx.createMediaStreamDestination();
    src.connect(anRaw); src.connect(hp);
    if (M.ours) {
      if (ns) { hp.connect(ns); ns.connect(lp); } else hp.connect(lp);
      lp.connect(an); lp.connect(comp); comp.connect(makeup); makeup.connect(gate);
    } else { hp.connect(an); hp.connect(makeup); makeup.connect(gate); }
    gate.connect(lim); lim.connect(dst); lim.connect(mon); mon.connect(ctx.destination);
    live = { ns, makeup, mon };
    dstStream = dst.stream;

    const buf = new Float32Array(an.fftSize), buf2 = new Float32Array(anRaw.fftSize);
    const dbOf = (a, b) => { a.getFloatTimeDomainData(b); let sum = 0; for (let k = 0; k < b.length; k++) sum += b[k] * b[k]; return 20 * Math.log10(Math.sqrt(sum / b.length) + 1e-9); };
    let floor = -60, holdUntil = 0;
    timer = setInterval(() => {
      const db = dbOf(an, buf); level = db;
      if (rec) { rec.pro.push(db); rec.raw.push(dbOf(anRaw, buf2)); }
      if (!M.ours) { gateOpen = db > -60; return; }
      const now = performance.now(), openNow = now < holdUntil;
      if (db < floor) floor = db; else floor += openNow ? 0.004 : 0.05;
      floor = Math.max(-85, Math.min(-40, floor));
      if (db > floor + GATE.MARGIN_DB && db > GATE.MIN_DB) holdUntil = now + GATE.HOLD_MS;
      gateOpen = now < holdUntil;
      gate.gain.setTargetAtTime(gateOpen ? 1 : GATE.CLOSED, ctx.currentTime, gateOpen ? 0.01 : 0.15);
    }, 30);

    const track = dst.stream.getAudioTracks()[0];
    try { track.contentHint = 'speech'; } catch (e) {}
    return { stream: dst.stream, track, ns: hasNS, mode: cfg.mode };
  }

  function close() {
    clearInterval(timer); timer = null; rec = null;
    try { raw && raw.getTracks().forEach(t => t.stop()); } catch (e) {} raw = null;
    try { ctx && ctx.close(); } catch (e) {} ctx = null; dstStream = null;
    live = { ns: null, makeup: null, mon: null }; level = -90; gateOpen = false; hasNS = false;
  }

  const meter = () => ({ db: level, gate: gateOpen, ns: hasNS, noise: nsInfo.n, nsGain: nsInfo.g, mode: cfg.mode, on: !!ctx });

  /* ===== اختبار: يسجّل 6 ثواني من الأصلي ومن المنقّى باش تسمع الفرق وتشوف الأرقام ===== */
  const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : -90; };
  async function recordTest(ms) {
    if (!ctx || !raw || !dstStream) throw new Error('شغّل المايك أول (زر 🎤)');
    ms = ms || 6000; rec = { raw: [], pro: [] };
    const mk = stream => { const ch = []; const mr = new MediaRecorder(stream); mr.ondataavailable = e => e.data.size && ch.push(e.data); const done = new Promise(r => { mr.onstop = () => r(new Blob(ch, { type: mr.mimeType || 'audio/webm' })); }); mr.start(); return { mr, done }; };
    const a = mk(new MediaStream([raw.getAudioTracks()[0].clone()])), b = mk(dstStream);
    await new Promise(r => setTimeout(r, ms));
    a.mr.stop(); b.mr.stop();
    const [ba, bb] = await Promise.all([a.done, b.done]);
    const st = { rawNoise: pct(rec.raw, 0.1), rawSpeech: pct(rec.raw, 0.9), proNoise: pct(rec.pro, 0.1), proSpeech: pct(rec.pro, 0.9) };
    rec = null;
    return { rawUrl: URL.createObjectURL(ba), proUrl: URL.createObjectURL(bb), stats: st };
  }

  /* ===== لوحة الإعدادات ===== */
  function applyLive() {
    if (!ctx) return;
    try { if (live.ns) live.ns.parameters.get('reduction').setValueAtTime(cfg.nr, ctx.currentTime); } catch (e) {}
    try { if (live.makeup) live.makeup.gain.setTargetAtTime(cfg.gain, ctx.currentTime, 0.05); } catch (e) {}
    try { if (live.mon) live.mon.gain.setTargetAtTime(cfg.monitor ? 1 : 0, ctx.currentTime, 0.05); } catch (e) {}
  }
  let panel = null;
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 12px);width:min(94vw,380px);max-height:86vh;overflow:auto;background:rgba(28,21,17,.97);color:#f3e6d6;border-radius:18px;padding:14px;z-index:30;display:none;font:14px system-ui;direction:rtl;box-shadow:0 10px 40px rgba(0,0,0,.5);touch-action:pan-y';
    const btn = 'border:0;border-radius:10px;padding:8px 10px;font:700 13px system-ui;background:#6f4e37;color:#fff;width:auto';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>🎛️ المايك الاحترافي</b><button id="mpX" style="' + btn + '">✕</button></div>' +
      '<div style="height:10px;background:#0007;border-radius:6px;overflow:hidden"><div id="mpBar" style="height:100%;width:0;background:#27ae60"></div></div>' +
      '<div id="mpInfo" style="font-size:12px;opacity:.85;margin:5px 0 8px">شغّل المايك باش تشوف المستوى</div>' +
      '<div style="font-size:13px;margin-bottom:4px">طريقة التنقية (جرّبهم بالتسجيل تحت):</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:10px"><button id="mdPro" style="' + btn + '">احترافي</button><button id="mdBoth" style="' + btn + '">الاثنين</button><button id="mdBrw" style="' + btn + '">المتصفح فقط</button></div>' +
      '<label style="display:block;font-size:13px">إزالة الضجيج: <b id="mpNrV"></b> dB</label><input id="mpNr" type="range" min="0" max="30" step="1" style="width:100%;padding:0;border:0">' +
      '<label style="display:block;font-size:13px;margin-top:6px">علو الصوت: <b id="mpGV"></b>×</label><input id="mpG" type="range" min="0.6" max="3" step="0.1" style="width:100%;padding:0;border:0">' +
      '<div style="display:flex;gap:6px;margin:10px 0;flex-wrap:wrap"><button id="mpP1" style="' + btn + '">عادي</button><button id="mpP2" style="' + btn + '">مقهى / ضجيج عالي</button><button id="mpP3" style="' + btn + '">هادئ</button></div>' +
      '<button id="mpRec" style="' + btn + ';background:#c0392b;width:100%;padding:11px">🔴 اختبر صوتي (6 ثواني: اسكت ثلاث ثواني ثم تكلّم)</button>' +
      '<div id="mpRes" style="margin-top:8px;font-size:12px"></div>' +
      '<label style="font-size:13px;display:flex;gap:8px;align-items:center;margin-top:8px"><input id="mpMon" type="checkbox" style="width:auto"> اسمع صوتك (بالسماعات برك! وإلا يصفّر)</label>';
    document.body.appendChild(panel);
    const $ = id => panel.querySelector('#' + id);
    const sync = () => {
      $('mpNr').value = cfg.nr; $('mpG').value = cfg.gain; $('mpNrV').textContent = cfg.nr; $('mpGV').textContent = (+cfg.gain).toFixed(1); $('mpMon').checked = cfg.monitor;
      [['mdPro', 'pro'], ['mdBoth', 'both'], ['mdBrw', 'browser']].forEach(([id, m]) => { $(id).style.background = cfg.mode === m ? '#27ae60' : '#6f4e37'; });
    };
    sync();
    $('mpX').onclick = togglePanel;
    $('mpNr').oninput = e => { cfg.nr = +e.target.value; sync(); applyLive(); save2(); };
    $('mpG').oninput = e => { cfg.gain = +e.target.value; sync(); applyLive(); save2(); };
    $('mpMon').onchange = e => { cfg.monitor = e.target.checked; applyLive(); };
    const preset = (nr, g) => () => { cfg.nr = nr; cfg.gain = g; sync(); applyLive(); save2(); };
    $('mpP1').onclick = preset(18, 1.4); $('mpP2').onclick = preset(26, 1.7); $('mpP3').onclick = preset(10, 1.2);
    const setMode = m => async () => {
      cfg.mode = m; sync(); save2();
      if (ctx) { try { const r = await open(); window.MicPro.onTrack && window.MicPro.onTrack(r); } catch (e) { $('mpInfo').textContent = '⚠️ ' + e.message; } }
    };
    $('mdPro').onclick = setMode('pro'); $('mdBoth').onclick = setMode('both'); $('mdBrw').onclick = setMode('browser');
    $('mpRec').onclick = async () => {
      const b = $('mpRec'), out = $('mpRes');
      try {
        b.disabled = true; out.textContent = '';
        for (let k = 3; k > 0; k--) { b.textContent = '🔴 اسكت… ' + k; await new Promise(r => setTimeout(r, 1000)); }
        b.textContent = '🔴 تكلّم توّا…';
        const r = await recordTest(3000);
        const s = r.stats, f = x => Math.round(x);
        out.innerHTML =
          '<div style="background:#0006;border-radius:10px;padding:8px;line-height:1.7">' +
          '<b>الأرقام (dB):</b><br>ضجيج الصمت: أصلي <b>' + f(s.rawNoise) + '</b> ← منقّى <b>' + f(s.proNoise) + '</b><br>' +
          'الكلام: أصلي <b>' + f(s.rawSpeech) + '</b> ← منقّى <b>' + f(s.proSpeech) + '</b><br>' +
          'وضوح (كلام - ضجيج): أصلي <b>' + f(s.rawSpeech - s.rawNoise) + '</b> ← منقّى <b>' + f(s.proSpeech - s.proNoise) + '</b></div>' +
          '<div style="margin-top:8px">🎧 الأصلي (بسماعات):<audio controls src="' + r.rawUrl + '" style="width:100%"></audio></div>' +
          '<div style="margin-top:6px">🎧 المنقّى:<audio controls src="' + r.proUrl + '" style="width:100%"></audio></div>';
      } catch (e) { out.textContent = '⚠️ ' + e.message; }
      b.disabled = false; b.textContent = '🔴 اختبر صوتي (6 ثواني: اسكت ثلاث ثواني ثم تكلّم)';
    };
    setInterval(() => {
      if (panel.style.display === 'none') return;
      const m = meter();
      $('mpBar').style.width = Math.max(0, Math.min(100, (m.db + 70) / 70 * 100)) + '%';
      $('mpBar').style.background = m.gate ? '#27ae60' : '#7f8c8d';
      $('mpInfo').textContent = m.on ? ((m.gate ? '🗣️ كلام' : '🤫 صمت') + ' | ' + (m.db | 0) + ' dB | ' + MODES[cfg.mode].label + (m.ns ? ' | إزالة ذكية ✅ (تخفيض ' + Math.round(-20 * Math.log10(m.nsGain + 1e-6)) + ' dB)' : '')) : 'المايك مكتوم: اضغط 🎤 باش تشغّلو';
    }, 120);
  }
  function togglePanel() { if (!panel) buildPanel(); panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; }

  (function mount() {
    const b = document.getElementById('btns'); if (!b) return setTimeout(mount, 300);
    const gb = document.createElement('button'); gb.textContent = '⚙️ المايك'; gb.onclick = togglePanel; b.appendChild(gb);
  })();

  window.MicPro = { open, close, meter, togglePanel, recordTest, cfg, onTrack: null, _worklet: WORKLET };
})();
