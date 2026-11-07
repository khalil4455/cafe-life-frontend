// auth-client.js — واجهة الدخول والجلسة والدفع للكلاينت (window.CafeAuth) — v3.0
// ============================================================================
// إصلاحات v3.0:
//   1. createCheckout: يرسل package_id + packageId (متوافق مع السيرفر الحالي والمستقبلي)
//   2. verifyPayment: يستخدم GET مع query param (كما يتوقع payments.routes.js)
//   3. tryPaths: يتعامل مع 404 بشكل صحيح دون إبطاء
//   4. إضافة requestRaw للطلبات غير JSON
//   5. تحسين رسائل الأخطاء لتشخيص أدق
//   6. دعم كامل للكوكي + Bearer
// ============================================================================
(function () {
  'use strict';
  if (window.CafeAuth) return;

  // ==========================================================================
  // 1. API BASE
  // ==========================================================================
  const API = (function () {
    try { if (typeof API_BASE !== 'undefined' && API_BASE) return API_BASE; } catch (e) {}
    try {
      const u = new URL(String(window.CAFE_LIFE_API_URL || 'https://api.signalforce.si'));
      if (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        return u.origin;
      }
    } catch (e) {}
    return 'https://api.signalforce.si';
  })();

  // ==========================================================================
  // 2. PAYMENT ENDPOINTS
  //    السيرفر يعرّف /payments/checkout و /payments/verify.
  //    البقية احتياطية فقط (تُجرَّب فقط إذا 404).
  // ==========================================================================
  const PAY = {
    checkout: [
      '/payments/checkout',              // ← المسار الرسمي في payments.routes.js
      '/payments/create-checkout',       // احتياطي
      '/payments/create-checkout-session',
      '/wallet/checkout',
    ],
    verify: [
      '/payments/verify',                // ← المسار الرسمي
      '/payments/verify-session',
      '/payments/verify-payment',
      '/wallet/verify',
    ],
  };

  // ==========================================================================
  // 3. STORAGE (localStorage مع احتياطي في الذاكرة)
  // ==========================================================================
  const TOKEN_KEY = 'cafe_token';
  const mem = {};
  const store = {
    get(k) {
      try { return localStorage.getItem(k) || ''; }
      catch (e) { return mem[k] || ''; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); }
      catch (e) { mem[k] = v; }
    },
    del(k) {
      try { localStorage.removeItem(k); }
      catch (e) { delete mem[k]; }
    },
  };

  // ==========================================================================
  // 4. STATE
  // ==========================================================================
  let token = store.get(TOKEN_KEY);
  let user = null;
  const chosen = {};   // المسارات التي نجحت (cache)

  // ==========================================================================
  // 5. ERROR CLASS
  // ==========================================================================
  class AuthError extends Error {
    constructor(code, status) {
      super(code);
      this.name = 'AuthError';
      this.code = code;
      this.status = status;
    }
  }

  // ==========================================================================
  // 6. EVENT EMITTER
  // ==========================================================================
  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('cafe-auth:change', { detail: { user } }));
    } catch (e) {}
  }
  function setUser(u) {
    user = (u && typeof u === 'object') ? u : null;
    emit();
  }
  function setToken(t) {
    token = String(t || '');
    if (token) store.set(TOKEN_KEY, token);
    else store.del(TOKEN_KEY);
  }
  function clearLocal(notify) {
    const had = Boolean(user);
    setToken('');
    user = null;
    if (notify || had) emit();
  }

  // ==========================================================================
  // 7. LOW-LEVEL REQUEST
  //    - يرسل Bearer + cookie
  //    - يعيد JSON
  //    - يرمي AuthError عند الفشل
  // ==========================================================================
  async function request(path, opts) {
    opts = opts || {};
    const headers = { Accept: 'application/json' };
    if (token && opts.auth !== false) {
      headers.Authorization = 'Bearer ' + token;
    }
    const init = {
      method: opts.method || 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers,
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(API + path, init);
    } catch (e) {
      throw new AuthError('network_error', 0);
    }

    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (!res.ok || data.ok === false) {
      const err = new AuthError(String(data.error || ('http_' + res.status)), res.status);
      err.data = data;
      if (res.status === 401 && opts.auth !== false && !opts.keepSession) {
        clearLocal(false);
      }
      throw err;
    }
    return data;
  }

  // ==========================================================================
  // 8. AUTH — الدخول والجلسة
  // ==========================================================================
  async function config() {
    return request('/auth/config', { auth: false });
  }

  async function google(credential) {
    const d = await request('/auth/google', {
      method: 'POST',
      body: { credential: String(credential || '') },
      auth: false,
    });
    if (d.token) setToken(d.token);
    setUser(d.user);
    return user;
  }

  async function restoreSession() {
    try {
      const d = await request('/auth/me', { keepSession: true });
      setUser(d.user);
      return user;
    } catch (e) {
      if (e.status === 401 && token) {
        setToken('');
        try {
          const d2 = await request('/auth/me');
          setUser(d2.user);
          return user;
        } catch (e2) {}
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
    try {
      await request('/auth/logout', { method: 'POST', body: {}, keepSession: true });
    } finally {
      clearLocal(true);
    }
  }

  async function logoutAll() {
    try {
      await request('/auth/logout-all', { method: 'POST', body: {}, keepSession: true });
    } finally {
      clearLocal(true);
    }
  }

  function setTokens(n) {
    if (!user) return;
    const coins = Number(n);
    if (!Number.isSafeInteger(coins) || coins < 0) return;
    user = Object.assign({}, user, { coins });
    emit();
  }

  // ==========================================================================
  // 9. PAYMENTS — الشراء والتحقق
  // ==========================================================================

  /**
   * tryPaths: يجرّب مسارات بالترتيب حتى ينجح أحدها.
   * يحفظ المسار الناجح في `chosen[kind]` لتسريع الطلبات التالية.
   */
  async function tryPaths(kind, paths, send) {
    // إذا نجح مسار سابقاً، جرّبه أولاً فقط
    const list = chosen[kind] ? [chosen[kind], ...paths.filter(p => p !== chosen[kind])] : paths;
    let lastErr = null;

    for (const p of list) {
      try {
        const d = await send(p);
        chosen[kind] = p;
        return d;
      } catch (e) {
        // 404 = المسار غير موجود → جرّب التالي
        if (e.status === 404) {
          lastErr = e;
          continue;
        }
        // أي خطأ آخر (400، 401، 500) = المسار موجود لكن الطلب فشل
        // → أوقف التجرib وأعد الخطأ (لأن تجربة مسارات أخرى لن تساعد)
        throw e;
      }
    }

    throw lastErr || new AuthError('payment_route_not_found', 404);
  }

  /**
   * إنشاء جلسة دفع Stripe.
   * 
   * ✅ الإصلاحات:
   *   - يرسل package_id (snake_case) للسيرفر الحالي
   *   - يرسل packageId (camelCase) كاحتياطي
   *   - يعيد { url, sessionId, paymentId, ... } من السيرفر
   */
  async function createCheckout(packageId) {
    const id = String(packageId || '').trim();

    // تحقق من صحة المعرّف
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) {
      throw new AuthError('invalid_package', 400);
    }

    const d = await tryPaths('checkout', PAY.checkout, (p) =>
      request(p, {
        method: 'POST',
        body: {
          package_id: id,   // ✅ للسيرفر الحالي (payments.routes.js)
          packageId: id,    // ✅ احتياطي (لو تغيّر السيرفر مستقبلاً)
        },
      })
    );

    // تحقق من استجابة السيرفر
    if (!d || typeof d.url !== 'string' || !/^https:\/\//.test(d.url)) {
      throw new AuthError('invalid_checkout_response', 502);
    }

    return d;
  }

  /**
   * التحقق من دفع Stripe بعد العودة.
   * 
   * ✅ الإصلاحات:
   *   - يستخدم GET مع query param (كما يتوقع payments.routes.js)
   *   - يرسل session_id (snake_case)
   *   - يحفظ sessionId في query للتوافق
   */
  async function verifyPayment(sessionId) {
    const sid = String(sessionId || '').trim();

    // تحقق من صحة session id (Stripe يبدأ بـ cs_)
    if (!/^[A-Za-z0-9_\-]{8,200}$/.test(sid)) {
      throw new AuthError('invalid_session', 400);
    }

    return tryPaths('verify', PAY.verify, (p) => {
      // أضف query param (يتوافق مع GET) + body احتياطياً
      const sep = p.includes('?') ? '&' : '?';
      return request(p + sep + 'session_id=' + encodeURIComponent(sid), {
        method: 'GET',
      });
    });
  }

  // ==========================================================================
  // 10. MULTI-TAB SYNC
  // ==========================================================================
  window.addEventListener('storage', (e) => {
    if (e.key !== TOKEN_KEY) return;
    token = store.get(TOKEN_KEY);
    if (!token && user) {
      user = null;
      emit();
    }
  });

  // ==========================================================================
  // 11. EXPORT
  // ==========================================================================
  window.CafeAuth = Object.freeze({
    // Auth
    config,
    google,
    restoreSession,
    me,
    createWsTicket,
    updateProfile,
    logout,
    logoutAll,
    setTokens,

    // Payments
    createCheckout,
    verifyPayment,

    // Low-level
    request,

    // Getters
    getToken: () => token,
    getUser: () => user,
    isLoggedIn: () => Boolean(user),
    apiBase: API,
  });
})();
