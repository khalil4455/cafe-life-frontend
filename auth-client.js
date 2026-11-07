// auth-client.js — واجهة الدخول والجلسة للكلاينت (window.CafeAuth)
// السيرفر: كوكي HttpOnly (cafe_session) + Bearer احتياطي. كل الطلبات بـ credentials:'include'.
// ملاحظة أمان: التوكن متخزّن في localStorage عشان سحب/شراء index.html الحالي يستعمل Bearer.
//             المرحلة 3 (الجلسات) تشيلو وتخلّي الكوكي وحدو.
(function () {
  'use strict';
  if (window.CafeAuth) return;

  const API = (function () {
    try { if (typeof API_BASE !== 'undefined' && API_BASE) return API_BASE; } catch (e) {}
    try {
      const u = new URL(String(window.CAFE_LIFE_API_URL || 'https://api.signalforce.si'));
      if (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
    } catch (e) {}
    return 'https://api.signalforce.si';
  })();

  // مسارات الدفع: غيّرها هنا كان مختلفة عندك (الكلاينت يجرّب بالترتيب ويتخطّى الـ404)
  const PAY = {
    checkout: ['/payments/checkout', '/payments/create-checkout-session', '/payments/create-checkout', '/wallet/checkout'],
    verify: ['/payments/verify', '/payments/verify-session', '/payments/verify-payment', '/wallet/verify'],
  };

  const TOKEN_KEY = 'cafe_token';
  const mem = {};
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return mem[k] || ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } },
  };

  let token = store.get(TOKEN_KEY);
  let user = null;
  const chosen = {};

  class AuthError extends Error {
    constructor(code, status) { super(code); this.name = 'AuthError'; this.code = code; this.status = status; }
  }

  function emit() {
    try { window.dispatchEvent(new CustomEvent('cafe-auth:change', { detail: { user } })); } catch (e) {}
  }
  function setUser(u) { user = (u && typeof u === 'object') ? u : null; emit(); }
  function setToken(t) {
    token = String(t || '');
    if (token) store.set(TOKEN_KEY, token); else store.del(TOKEN_KEY);
  }
  function clearLocal(notify) {
    const had = Boolean(user);
    setToken('');
    user = null;
    if (notify || had) emit();
  }

  async function request(path, opts) {
    opts = opts || {};
    const headers = { Accept: 'application/json' };
    if (token && opts.auth !== false) headers.Authorization = 'Bearer ' + token;
    const init = { method: opts.method || 'GET', credentials: 'include', cache: 'no-store', headers };
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }

    let res;
    try { res = await fetch(API + path, init); } catch (e) { throw new AuthError('network_error', 0); }
    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (!res.ok || data.ok === false) {
      const err = new AuthError(String(data.error || ('http_' + res.status)), res.status);
      err.data = data;
      if (res.status === 401 && opts.auth !== false && !opts.keepSession) clearLocal(false);
      throw err;
    }
    return data;
  }

  /* ---------------- الدخول ---------------- */
  async function config() { return request('/auth/config', { auth: false }); }

  async function google(credential) {
    const d = await request('/auth/google', { method: 'POST', body: { credential: String(credential || '') }, auth: false });
    if (d.token) setToken(d.token);
    setUser(d.user);
    return user;
  }

  // يرجّع المستخدم أو null (ما يرميش خطأ كان الجلسة منتهية)
  async function restoreSession() {
    try {
      const d = await request('/auth/me', { keepSession: true });
      setUser(d.user);
      return user;
    } catch (e) {
      if (e.status === 401 && token) {          // توكن قديم: نجرّبو بالكوكي وحدو
        setToken('');
        try { const d2 = await request('/auth/me'); setUser(d2.user); return user; } catch (e2) {}
      }
      if (e.status === 401) clearLocal(false);
      return null;
    }
  }

  async function me() {
    const d = await request('/auth/me');
    setUser(d.user);
    return user;
  }

  async function createWsTicket() {
    const d = await request('/auth/ws-ticket', { method: 'POST', body: {} });
    return d.ticket;
  }

  async function updateProfile(fields) {
    const d = await request('/auth/profile', { method: 'POST', body: fields || {} });
    setUser(d.user);
    return user;
  }

  async function logout() {
    try { await request('/auth/logout', { method: 'POST', body: {}, keepSession: true }); }
    finally { clearLocal(true); }
  }

  async function logoutAll() {
    try { await request('/auth/logout-all', { method: 'POST', body: {}, keepSession: true }); }
    finally { clearLocal(true); }
  }

  // تحديث الرصيد محليا (wallet:update من السيرفر)
  function setTokens(n) {
    if (!user) return;
    const coins = Number(n);
    if (!Number.isSafeInteger(coins) || coins < 0) return;
    user = Object.assign({}, user, { coins });
    emit();
  }

  /* ---------------- الدفع (Stripe) ---------------- */
  async function tryPaths(kind, paths, send) {
    const list = chosen[kind] ? [chosen[kind]] : paths;
    let lastErr = null;
    for (const p of list) {
      try {
        const d = await send(p);
        chosen[kind] = p;
        return d;
      } catch (e) {
        if (e.status === 404 && !chosen[kind]) { lastErr = e; continue; }   // مسار غير موجود: نجرّبو اللي بعدو
        throw e;
      }
    }
    throw lastErr || new AuthError('payment_route_not_found', 404);
  }

  async function createCheckout(packageId) {
    const id = String(packageId || '');
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) throw new AuthError('invalid_package', 400);
    const d = await tryPaths('checkout', PAY.checkout, p => request(p, { method: 'POST', body: { packageId: id } }));
    if (!d || typeof d.url !== 'string' || !/^https:\/\//.test(d.url)) throw new AuthError('invalid_checkout_response', 502);
    return d;
  }

  async function verifyPayment(sessionId) {
    const sid = String(sessionId || '');
    if (!/^[A-Za-z0-9_\-]{8,200}$/.test(sid)) throw new AuthError('invalid_session', 400);
    return tryPaths('verify', PAY.verify, p => request(p, { method: 'POST', body: { sessionId: sid } }));
  }

  /* ---------------- مزامنة التبويبات ---------------- */
  window.addEventListener('storage', e => {
    if (e.key !== TOKEN_KEY) return;
    token = store.get(TOKEN_KEY);
    if (!token && user) { user = null; emit(); }
  });

  window.CafeAuth = Object.freeze({
    config, google, restoreSession, me, createWsTicket, updateProfile, logout, logoutAll,
    setTokens, createCheckout, verifyPayment, request,
    getToken: () => token,
    getUser: () => user,
    isLoggedIn: () => Boolean(user),
    apiBase: API,
  });
})();
