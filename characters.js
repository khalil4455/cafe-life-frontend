// characters.js — شخصيات Kenney (FBX). إن فشل التحميل يبقى الشكل الافتراضي.
(function () {
  const VER = 5, Q4 = '?v=' + VER;
  const BASE = 'models/';
  const NPM = 'https://cdn.jsdelivr.net/npm/';
  const T3 = NPM + 'three@0.128.0/examples/js/';
  const HEIGHT = 1.85;
  let R = null, pend = [];
  const MODELS = [];
  const V = THREE.Vector3, Q = new THREE.Quaternion();
  const AXES = [new V(1, 0, 0), new V(0, 1, 0), new V(0, 0, 1)];

  window.turn = function (g, t, dt) {
    let d = t - g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.rotation.y += d * Math.min(1, dt * 12);
  };
  const _walk = window.walk;
  window.walk = function (g, on, dt) { _walk(g, on, dt); if (g.userData.mdl && on) g.position.y = 0; };

  const hash = n => [...n].reduce((a, c) => a + c.charCodeAt(0), 0);
  const loc = (g, o) => { const v = new V(); o.getWorldPosition(v); return g.worldToLocal(v); };

  // يجد المحور والإشارة اللذين يزيدان metric عند تدوير العظمة
  function calib(g, b, c, metric) {
    const q0 = b.quaternion.clone();
    g.updateMatrixWorld(true);
    const m0 = metric(loc(g, c));
    let best = { d: 0, ax: AXES[0], sg: 1 };
    AXES.forEach(ax => {
      b.quaternion.copy(q0).multiply(new THREE.Quaternion().setFromAxisAngle(ax, 1.2));
      g.updateMatrixWorld(true);
      const d = metric(loc(g, c)) - m0;
      if (Math.abs(d) > Math.abs(best.d)) best = { d, ax, sg: d > 0 ? 1 : -1 };
    });
    b.quaternion.copy(q0); g.updateMatrixWorld(true);
    return { b, c, q0, ax: best.ax, sg: best.sg };
  }

  function attach(g, name) {
    if (g.userData.mdl || !g.parent || !R) return;
    let m = null;
    try {
      m = THREE.SkeletonUtils.clone(R.base);
      const skin = R.skins[hash(name || '') % R.skins.length];
      m.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true; o.frustumCulled = false;
        const arr = Array.isArray(o.material), ms = (arr ? o.material : [o.material]).map(x => {
          const y = x.clone(); y.skinning = !!o.isSkinnedMesh; y.map = skin; if (y.color) y.color.set(0xffffff); y.needsUpdate = true; return y;
        });
        o.material = arr ? ms : ms[0];
      });
      m.updateMatrixWorld(true);
      const la = m.getObjectByName('LeftArm'), ra = m.getObjectByName('RightArm');
      if (la && ra) { const a = new V(), b = new V(); la.getWorldPosition(a); ra.getWorldPosition(b); if (a.x < b.x) m.rotation.y = Math.PI; }
      m.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(m);
      const s = HEIGHT / ((box.max.y - box.min.y) || 1);
      m.scale.setScalar(s);
      m.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
      g.add(m); g.updateMatrixWorld(true);

      const M = { g, m, baseY: m.position.y, drop: 0, legs: [], arms: [], act: {}, cur: null, fr: 0, armNeed: false, sit: false, lx: g.position.x, lz: g.position.z };
      const get = n => m.getObjectByName(n);
      ['Left', 'Right'].forEach(side => {
        const up = get(side + 'UpLeg'), kn = get(side + 'Leg');
        if (up && kn) {
          const L = calib(g, up, kn, v => v.z);           // الفخذ للأمام
          L.kq0 = kn.quaternion.clone();
          M.legs.push(L);
        }
        const ar = get(side + 'Arm'), fo = get(side + 'ForeArm');
        if (ar && fo) M.arms.push(calib(g, ar, fo, v => -v.y)); // الذراع للأسفل
      });
      const hp = get('Hips');
      if (hp) M.drop = Math.max(0, loc(g, hp).y - 0.72);

      M.mixer = new THREE.AnimationMixer(m);
      M.act.idle = M.mixer.clipAction(R.clips.idle);
      M.act.idle.play(); M.cur = 'idle';
      if (R.clips.walk) { M.act.walk = M.mixer.clipAction(R.clips.walk); M.act.walk.timeScale = 0.85; }
      else M.act.walk = M.act.idle;

      g.children.forEach(c => { if (!c.isSprite && c !== m) c.visible = false; });
      g.userData.mdl = M;
      MODELS.push(M);
    } catch (e) {
      console.warn('تعذّر تركيب الشخصية، نستعمل الشكل الافتراضي', e);
      if (m && m.parent) m.parent.remove(m);
      g.children.forEach(c => { c.visible = true; });
      g.userData.mdl = null;
    }
  }

  let dbgDone = false;
  function debug(M) {
    if (dbgDone) return; dbgDone = true;
    try {
      let sm = null; M.m.traverse(o => { if (o.isSkinnedMesh && !sm) sm = o; });
      const A = M.arms[0], deg = A ? Math.round(A.q0.angleTo(A.b.quaternion) * 57.3) : -1;
      let def = -1;
      if (sm) {
        sm.updateMatrixWorld(true); sm.skeleton.update();
        const p = sm.geometry.attributes.position, st = Math.max(1, Math.floor(p.count / 300)), a = new V(), b = new V();
        let t = 0, c = 0;
        for (let i = 0; i < p.count; i += st) { a.fromBufferAttribute(p, i).applyMatrix4(sm.matrixWorld); sm.boneTransform(i, b).applyMatrix4(sm.matrixWorld); t += a.distanceTo(b); c++; }
        def = t / c / HEIGHT;
      }
      const sk = sm ? [].concat(sm.material)[0].skinning : 'x';
      window.log && window.log('', '🔧 skin=' + sk + ' arm=' + deg + '° def=' + def.toFixed(3) + ' tr=' + R.clips.idle.tracks.length);
    } catch (e) { window.log && window.log('', '🔧 خطأ: ' + e.message); }
  }

  const _fig = window.fig;
  window.fig = function (c, name) {
    const g = _fig(c, name);
    if (R) attach(g, name); else pend.push([g, name]);
    return g;
  };

  const _tick = window.cafeTick;
  window.cafeTick = function (dt) {
    _tick(dt);
    for (let i = MODELS.length - 1; i >= 0; i--) {
      const M = MODELS[i], g = M.g;
      if (!g.parent) { MODELS.splice(i, 1); continue; }
      const sitting = g.userData.lL.rotation.x < -1;
      const moved = Math.hypot(g.position.x - M.lx, g.position.z - M.lz) / Math.max(dt, 0.001) > 0.4;
      M.lx = g.position.x; M.lz = g.position.z;

      const want = moved && !sitting ? 'walk' : 'idle';
      if (M.cur !== want) {
        const n = M.act[want], o = M.act[M.cur];
        n.reset().fadeIn(0.2).play();
        if (o && o !== n) o.fadeOut(0.2);
        M.cur = want;
      }
      M.mixer.update(dt);

      // هل الذراعان ما زالتا مفتوحتين (وضع T) بعد تشغيل الحركة؟
      if (M.fr < 6 && ++M.fr === 5) debug(M);
      if (M.fr === 5 && !M.armChk && M.arms.length) {
        M.armChk = true;
        let r = 0;
        M.arms.forEach(A => { const a = loc(g, A.b), f = loc(g, A.c); r += (a.y - f.y) / (a.distanceTo(f) || 1); });
        M.armNeed = r / M.arms.length < 0.5;
      }
      if (M.armNeed) M.arms.forEach(A => A.b.quaternion.copy(A.q0).multiply(Q.setFromAxisAngle(A.ax, A.sg * 1.35)));

      // الجلوس: دائمًا انطلاقًا من الوضع الأصلي حتى لا يتراكم الدوران
      if (sitting) {
        M.legs.forEach(L => {
          L.b.quaternion.copy(L.q0).multiply(Q.setFromAxisAngle(L.ax, L.sg * 1.45));
          L.c.quaternion.copy(L.kq0).multiply(Q.setFromAxisAngle(L.ax, -L.sg * 1.5));
        });
        M.m.position.y = M.baseY - M.drop; M.sit = true;
      } else {
        M.m.position.y = M.baseY;
        if (M.sit) { M.legs.forEach(L => { L.b.quaternion.copy(L.q0); L.c.quaternion.copy(L.kq0); }); M.sit = false; }
      }
    }
  };

  function ld(src, cb) {
    const s = document.createElement('script');
    s.src = src; s.onload = cb; s.onerror = () => console.warn('تعذّر تحميل', src);
    document.head.appendChild(s);
  }
  function boot() {
    const L = new THREE.FBXLoader(), TL = new THREE.TextureLoader();
    const skins = ['skaterMaleA', 'skaterFemaleA', 'criminalMaleA', 'cyborgFemaleA'].map(n => TL.load(BASE + 'skins/' + n + '.png' + Q4));
    L.load(BASE + 'characterMedium.fbx' + Q4, base => {
      const clips = {}; let left = 2;
      const done = () => {
        if (--left) return;
        if (!clips.idle) return console.warn('لا توجد حركة وقوف');
        R = { base, clips, skins };
        pend.forEach(([g, n]) => attach(g, n)); pend = [];
        try { [W.g, NPC[0] && NPC[0].g].forEach(g => g && attach(g, 'القهوجي')); } catch (e) {}
        if (window.log) window.log('', '🧍 v' + VER + ' ' + (clips.idle.name || '?') + ' / ' + ((clips.walk && clips.walk.name) || '-'));
      };
      // كل ملف حركة فيه مقطعان: "Targeting Pose" (وضع T لإطار واحد) والحركة الحقيقية. نتجاهل الأول.
      [['idle', 'idle', /idle/i], ['run', 'walk', /run/i]].forEach(([f, k, re]) =>
        L.load(BASE + f + '.fbx' + Q4, a => {
          const an = a.animations || [];
          clips[k] = an.find(x => re.test(x.name)) ||
            an.filter(x => !/target|pose/i.test(x.name)).sort((p, q) => q.duration - p.duration)[0];
          done();
        }, undefined, done));
    }, undefined, () => console.warn('ملف الشخصية غير موجود، نستعمل الشكل الافتراضي'));
  }
  ld(NPM + 'fflate@0.6.9/umd/index.js', () =>
    ld(T3 + 'loaders/FBXLoader.js', () =>
      ld(T3 + 'utils/SkeletonUtils.js', boot)));
})();
