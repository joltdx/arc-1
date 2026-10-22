/*
 * ARC-1 browser ADT session spike (plan: docs/plans/2026-10-20-browser-embedded-runtime.md, Phase 1).
 *
 * Paste into the DevTools console on any page served from the ABAP origin, or load via index.html
 * in this folder. It adds a floating panel; every request is also logged to the console and kept in
 * `window.arcSpike.log`. Use "Report" to copy a Markdown summary.
 *
 * Mirrors ARC-1's ADT protocol (src/adt/http.ts, crud.ts, devtools.ts): CSRF fetch on
 * /sap/bc/adt/core/discovery, X-sap-adt-sessiontype, LOCK/UNLOCK, text/plain source PUT,
 * activation, and the Eclipse-style close-session request with the NW 7.50 HEAD fallback.
 *
 * Never records cookie values, CSRF tokens or lock handles (only presence/length).
 * Writes only to a generated $TMP program (Z_ARC1_SPK_xxxxxx). Review the report before committing it.
 */
(() => {
  'use strict';

  if (window.arcSpike?.panel) window.arcSpike.panel.remove();

  const LS_KEY = 'arcSpike.state';
  const params = new URLSearchParams(location.search);
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  })();

  const S = (window.arcSpike = {
    log: [],
    notes: [],
    env: null,
    csrf: null,
    loops: {},
    cfg: {
      sapClient: params.get('sap-client') || stored.sapClient || '',
      readProgram: stored.readProgram || 'SAPMSSY0',
      hostProbeUrl: stored.hostProbeUrl || location.pathname + location.search,
      testProgram: stored.testProgram || `Z_ARC1_SPK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    },
  });

  const saveState = (extra = {}) => {
    try {
      const prev = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      localStorage.setItem(LS_KEY, JSON.stringify({ ...prev, ...S.cfg, ...extra }));
    } catch {
      /* storage blocked: state is per-tab only */
    }
  };
  const loadShared = () => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  };

  const tabId = Math.random().toString(36).slice(2, 6);
  const now = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const progUrl = () => `/sap/bc/adt/programs/programs/${encodeURIComponent(S.cfg.testProgram.toLowerCase())}`;

  // ---------------------------------------------------------------- output

  function out(kind, msg, data) {
    const line = `[arcSpike ${tabId}] ${msg}`;
    (kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log)(line, data ?? '');
    if (S.logEl) {
      const div = document.createElement('div');
      div.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
      div.style.color = kind === 'error' ? '#ff8a80' : kind === 'warn' ? '#ffd180' : kind === 'ok' ? '#b9f6ca' : '#e0e0e0';
      S.logEl.prepend(div);
    }
  }
  function note(text) {
    S.notes.push({ at: now(), tab: tabId, text });
    out('warn', `NOTE: ${text}`);
  }

  // ---------------------------------------------------------------- cookies (names/attributes only)

  async function cookieSnapshot() {
    const snap = { via: 'document.cookie', cookies: [] };
    if (window.cookieStore?.getAll) {
      try {
        const all = await window.cookieStore.getAll();
        snap.via = 'cookieStore';
        snap.cookies = all.map((c) => ({
          name: c.name,
          path: c.path,
          domain: c.domain,
          sameSite: c.sameSite,
          secure: c.secure,
          expires: c.expires ? new Date(c.expires).toISOString() : 'session',
          valueLength: (c.value || '').length,
        }));
        return snap;
      } catch {
        /* fall through */
      }
    }
    snap.cookies = document.cookie
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return { name: i < 0 ? p : p.slice(0, i), valueLength: i < 0 ? 0 : p.length - i - 1 };
      });
    return snap;
  }
  const cookieNames = (snap) => snap.cookies.map((c) => c.name).sort();
  function contextIdFromPage() {
    const m = document.cookie.match(/(?:^|;\s*)sap-contextid=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---------------------------------------------------------------- request helper

  /**
   * @param {string} step  label for the report
   * @param {object} o     { method, path, session: 'stateful'|'stateless'|undefined, headers, body, contentType,
   *                         redirect, csrf: bool (default: non-GET/HEAD), retryCsrf: bool (default true) }
   */
  async function req(step, o) {
    const method = o.method || 'GET';
    const url = new URL(o.path, location.origin);
    if (S.cfg.sapClient && url.pathname.startsWith('/sap/') && !url.searchParams.has('sap-client')) {
      url.searchParams.set('sap-client', S.cfg.sapClient);
    }
    // ARC-1 buildUrl() always adds sap-language (config default EN) to ADT URLs.
    if (url.pathname.startsWith('/sap/bc/adt/') && !url.searchParams.has('sap-language')) {
      url.searchParams.set('sap-language', 'EN');
    }
    const headers = { Accept: '*/*', ...(o.headers || {}) };
    if (o.session) headers['X-sap-adt-sessiontype'] = o.session;
    if (o.contentType) headers['Content-Type'] = o.contentType;
    const wantsCsrf = o.csrf ?? !['GET', 'HEAD'].includes(method);
    if (wantsCsrf && S.csrf && !headers['X-CSRF-Token']) headers['X-CSRF-Token'] = S.csrf;

    const t0 = performance.now();
    let res;
    let body = '';
    let error = null;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: o.body,
        credentials: 'include',
        cache: 'no-store',
        redirect: o.redirect || 'follow',
      });
      if (method !== 'HEAD' && res.type !== 'opaqueredirect') body = await res.text();
    } catch (e) {
      error = String(e);
    }
    const ms = Math.round(performance.now() - t0);

    const ct = res?.headers.get('content-type') || '';
    const finalUrl = res?.url ? new URL(res.url) : null;
    const entry = {
      at: now(),
      tab: tabId,
      step,
      method,
      path: url.pathname + url.search.replace(/lockHandle=[^&]+/, 'lockHandle=<redacted>'),
      session: o.session || '-',
      redirectMode: o.redirect || 'follow',
      status: res ? res.status : 'NETWORK_ERROR',
      statusText: res?.statusText || '',
      type: res?.type || '',
      redirected: res?.redirected || false,
      finalPath: finalUrl && finalUrl.pathname !== url.pathname ? finalUrl.pathname : '',
      contentType: ct,
      bytes: body.length,
      ms,
      responseHeaderNames: res ? [...res.headers.keys()].sort() : [],
      csrfHeader: res?.headers.get('x-csrf-token') ? (res.headers.get('x-csrf-token') === 'Required' ? 'Required' : 'present') : '',
      sapHeaders: res
        ? Object.fromEntries([...res.headers].filter(([k]) => /^sap-(server|system|perf|messages)/i.test(k)))
        : {},
      looksLikeLogin:
        /text\/html/i.test(ct) && /\/sap\/bc\/adt\//.test(url.pathname)
          ? true
          : /saml|logon|login|j_username|sap-user/i.test(/text\/html/i.test(ct) ? body.slice(0, 4000) : ''),
      bodySnippet: body.replace(/\s+/g, ' ').slice(0, 400),
      error,
    };
    entry.raw = { body, headers: res ? Object.fromEntries(res.headers) : {} };
    S.log.push(entry);

    const ok = res && res.status >= 200 && res.status < 300 && !entry.looksLikeLogin;
    out(
      ok ? 'ok' : 'error',
      `${step}: ${method} ${entry.path} [${entry.session}] → ${entry.status} ${entry.type}${entry.redirected ? ' REDIRECTED' : ''} ${ct} ${ms}ms${entry.looksLikeLogin ? ' LOGIN-PAGE?' : ''}`,
      { ...entry, raw: undefined },
    );

    // CSRF refresh + one retry, like ARC-1.
    if (res?.status === 403 && /required/i.test(res.headers.get('x-csrf-token') || '') && o.retryCsrf !== false) {
      note(`${step}: CSRF token rejected (403 Required) — refetching and retrying once`);
      await fetchCsrf(`${step} (csrf refresh)`, o.session);
      return req(`${step} (retry)`, { ...o, retryCsrf: false });
    }
    return { res, body, entry, ok };
  }

  function extract(xml, tag) {
    const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}>([^<]*)</(?:[\\w-]+:)?${tag}>`));
    return m ? m[1] : '';
  }

  // ---------------------------------------------------------------- building blocks

  /** ARC-1 fetchCsrfToken(): core discovery first; on 404/405 or no token, legacy /sap/bc/adt/discovery (pre-7.50). */
  async function fetchCsrf(step = 'csrf', session) {
    const usable = (r) => {
      const t = r.res?.headers.get('x-csrf-token');
      return r.res?.ok && t && t.toLowerCase() !== 'required' ? t : null;
    };
    let r = await req(step, {
      path: '/sap/bc/adt/core/discovery',
      session,
      headers: { 'X-CSRF-Token': 'fetch' },
      csrf: false,
    });
    if ([404, 405].includes(r.res?.status) || (r.res?.ok && !usable(r))) {
      r = await req(`${step} (legacy discovery)`, {
        path: '/sap/bc/adt/discovery',
        session,
        headers: { 'X-CSRF-Token': 'fetch' },
        csrf: false,
      });
    }
    const token = usable(r);
    if (token) {
      S.csrf = token;
      out('ok', `${step}: got CSRF token (length ${token.length})`);
    } else {
      note(`${step}: no CSRF token returned (status ${r.entry.status})`);
    }
    return r;
  }

  async function lock(step = 'lock') {
    const r = await req(step, {
      method: 'POST',
      path: `${progUrl()}?_action=LOCK&accessMode=MODIFY`,
      session: 'stateful',
      headers: {
        Accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result, application/*;q=0.8',
      },
    });
    const handle = extract(r.body, 'LOCK_HANDLE');
    r.lockHandle = handle;
    if (handle) out('ok', `${step}: lock handle length ${handle.length}, IS_LOCAL=${extract(r.body, 'IS_LOCAL')}`);
    return r;
  }

  async function unlock(handle, step = 'unlock') {
    return req(step, {
      method: 'POST',
      path: `${progUrl()}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
      session: 'stateful',
    });
  }

  /** ARC-1 closeStatefulSession(): stateless GET core/http/sessions (close-session), 404 → HEAD core/discovery. */
  async function closeSession(step = 'close-session') {
    const ctx = contextIdFromPage();
    const headers = { 'sap-adt-purpose': 'close-session' };
    if (ctx) headers['sap-contextid'] = ctx;
    else note(`${step}: sap-contextid not readable from JS (HttpOnly or absent); sending close without the header`);
    const r = await req(step, { path: '/sap/bc/adt/core/http/sessions', session: 'stateless', headers });
    if (r.res?.status === 404) {
      note(`${step}: /core/http/sessions is 404 (NW 7.50?) — falling back to HEAD /core/discovery`);
      const f = await req(`${step} (7.50 fallback)`, {
        method: 'HEAD',
        path: '/sap/bc/adt/core/discovery',
        session: 'stateless',
      });
      if (f.res?.status === 404) {
        // Not ARC-1 behavior (ARC-1 just warns here): probe whether a stateless request to legacy discovery
        // is enough to end the context on releases without /core/discovery (e.g. 7.31/7.40).
        note(`${step}: /core/discovery also 404 (pre-7.50) — ARC-1 has no close path here; trying stateless HEAD on legacy discovery`);
        return req(`${step} (legacy fallback, not in ARC-1)`, {
          method: 'HEAD',
          path: '/sap/bc/adt/discovery',
          session: 'stateless',
        });
      }
      return f;
    }
    return r;
  }

  async function hostProbe(step) {
    if (!S.cfg.hostProbeUrl) return null;
    const r = await req(step, { path: S.cfg.hostProbeUrl, headers: { Accept: '*/*' }, csrf: false });
    return r;
  }

  // ---------------------------------------------------------------- tests

  const tests = {
    async env() {
      const snap = await cookieSnapshot();
      S.env = {
        at: now(),
        origin: location.origin,
        pagePath: location.pathname,
        sapClient: S.cfg.sapClient || '(none — server default)',
        userAgent: navigator.userAgent,
        isSecureContext,
        crossOriginIsolated: window.crossOriginIsolated,
        hasNavigatorLocks: !!navigator.locks,
        hasCookieStore: !!window.cookieStore,
        hasDecompressionStream: typeof DecompressionStream === 'function',
        hasWorker: typeof Worker === 'function',
        cookies: snap,
        contextIdVisibleToPage: contextIdFromPage() !== null,
      };
      out('ok', 'env recorded', S.env);
      const ctx = snap.cookies.find((c) => c.name === 'sap-contextid');
      if (ctx) note(`sap-contextid already present BEFORE any ADT call (path ${ctx.path ?? 'unknown'}) — host app may itself be stateful`);
      return S.env;
    },

    async discovery() {
      await req('discovery', { path: '/sap/bc/adt/discovery', headers: { Accept: 'application/atomsvc+xml' } });
      await req('core-discovery', { path: '/sap/bc/adt/core/discovery', headers: { Accept: 'application/atomsvc+xml' } });
      const c = await req('components', {
        path: '/sap/bc/adt/system/components',
        headers: { Accept: 'application/atom+xml;type=feed' },
      });
      if (c.ok) {
        const doc = new DOMParser().parseFromString(c.body, 'application/xml');
        const comps = [...doc.getElementsByTagNameNS('*', 'entry')].map((e) => ({
          name: e.getElementsByTagNameNS('*', 'id')[0]?.textContent || '',
          title: e.getElementsByTagNameNS('*', 'title')[0]?.textContent || '',
        }));
        const basis = comps.find((x) => x.name === 'SAP_BASIS');
        S.env = { ...(S.env || {}), sapBasis: basis ? basis.title.split(';').slice(0, 3).join(';') : 'not found' };
        out('ok', `SAP_BASIS: ${S.env.sapBasis}`);
        return;
      }
      // ARC-1 fallback (features.ts detectReleaseFromSyntaxConfigurations): Standard ABAP entry's etag = release.
      const sc = await req('syntax-configurations', {
        path: '/sap/bc/adt/abapsource/syntax/configurations',
        headers: { Accept: 'application/vnd.sap.adt.syntaxconfigurations+xml' },
      });
      const etag = sc.ok ? sc.body.match(/version="X"[\s\S]*?etag="([^"]+)"/)?.[1] : null;
      S.env = {
        ...(S.env || {}),
        sapBasis: etag ? `${etag} (syntax configurations)` : 'unknown (no components feed, no syntax configurations)',
        sapServerHeader: c.res?.headers.get('sap-server') || '',
      };
      note(`release: ${S.env.sapBasis}`);
    },

    async readSource() {
      const name = S.cfg.readProgram.toLowerCase();
      await req('read-source', {
        path: `/sap/bc/adt/programs/programs/${encodeURIComponent(name)}/source/main`,
        headers: { Accept: 'text/plain' },
      });
    },

    /** Full write lifecycle with host-session checks around the stateful window. */
    async writeFlow() {
      const name = S.cfg.testProgram;
      if (!/^[ZY][A-Z0-9_]{1,29}$/.test(name)) throw new Error(`Test program name ${name} must be Z*/Y*, ≤30 chars`);
      saveState();

      const c0 = await cookieSnapshot();
      await hostProbe('host-probe (before)');
      await fetchCsrf('csrf (stateless)');

      const exists = await req('exists?', { path: `${progUrl()}`, headers: { Accept: 'application/*' } });
      if (exists.res?.status === 404) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs"
                     xmlns:adtcore="http://www.sap.com/adt/core"
                     adtcore:description="ARC-1 browser spike (safe to delete)"
                     adtcore:name="${name}"
                     adtcore:type="PROG/P"
                     adtcore:masterLanguage="EN">
  <adtcore:packageRef adtcore:name="$TMP"/>
</program:abapProgram>`;
        const cr = await req('create', {
          method: 'POST',
          path: `/sap/bc/adt/programs/programs?_package=${encodeURIComponent('$TMP')}`,
          body: xml,
          contentType: 'application/*',
        });
        if (!cr.ok) return note(`create failed (${cr.entry.status}); stopping write flow`);
      }

      const lk = await lock('lock (stateful)');
      const c1 = await cookieSnapshot();
      diffCookies('after stateful LOCK', c0, c1);
      if (!lk.lockHandle) return note('no lock handle; stopping write flow');

      // While the ADT stateful context is open: does the host app still work?
      // No ADT read here: in a browser it would carry the shared sap-contextid cookie, and with an explicit
      // `stateless` header it would end the context (ARC-1 closes sessions exactly that way). See sharedJarRead.
      await hostProbe('host-probe (ADT stateful context open)');

      const src = `REPORT ${name.toLowerCase()}.\n* ARC-1 browser spike ${now()} tab ${tabId}\nWRITE / 'hello from the browser'.\n`;
      const put = await req('put source', {
        method: 'PUT',
        path: `${progUrl()}/source/main?lockHandle=${encodeURIComponent(lk.lockHandle)}`,
        session: 'stateful',
        body: src,
        contentType: 'text/plain',
      });
      await unlock(lk.lockHandle, 'unlock (stateful)');
      const c2 = await cookieSnapshot();
      await closeSession();
      const c3 = await cookieSnapshot();
      diffCookies('after close-session', c2, c3);

      await hostProbe('host-probe (after close-session)');

      const act = await req('activate', {
        method: 'POST',
        path: '/sap/bc/adt/activation?method=activate&preauditRequested=false',
        body: `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${progUrl()}" adtcore:name="${name}"/>
</adtcore:objectReferences>`,
        contentType: 'application/*',
        headers: { Accept: 'application/xml' },
      });
      if (/type="E"|<msg[^>]*type="E"/.test(act.body)) note('activation returned error messages (see activate body)');

      const back = await req('read back (active)', {
        path: `${progUrl()}/source/main?version=active`,
        headers: { Accept: 'text/plain' },
      });
      const same = back.body.replace(/\r\n/g, '\n').trim() === src.trim();
      if (put.ok) note(`round-trip: active source ${same ? 'MATCHES' : 'DIFFERS FROM'} what was PUT`);
      await hostProbe('host-probe (end)');
      out('ok', `write flow done for ${name} (kept for lock tests; use "Delete test prog" to clean up)`);
    },

    /**
     * Browser-specific: the cookie jar is shared, so reads issued while a lock is held carry sap-contextid.
     * Does a header-less read (what ARC-1 reads send) keep the context, and does an explicit `stateless` read end it?
     * Only meaningful where the LOCK actually creates a stateful context (write flow PUT succeeded).
     */
    async sharedJarRead() {
      await fetchCsrf('csrf (stateless)');
      const lk = await lock('jar: lock');
      if (!lk.lockHandle) return note('jar: no lock handle');
      const put = (step) =>
        req(step, {
          method: 'PUT',
          path: `${progUrl()}/source/main?lockHandle=${encodeURIComponent(lk.lockHandle)}`,
          session: 'stateful',
          body: `REPORT ${S.cfg.testProgram.toLowerCase()}.\n* ${step} ${now()}\n`,
          contentType: 'text/plain',
        });
      const read = (step, session) =>
        req(step, { path: `${progUrl()}/source/main`, session, headers: { Accept: 'text/plain' } });

      const p0 = await put('jar: PUT right after lock');
      await read('jar: read, no session header');
      const p1 = await put('jar: PUT after header-less read');
      await read('jar: read, explicit stateless', 'stateless');
      const p2 = await put('jar: PUT after stateless read');
      note(
        `jar: PUT after lock ${p0.entry.status}; after header-less read ${p1.entry.status}; ` +
          `after explicit-stateless read ${p2.entry.status} (423 = that read ended the stateful context)`,
      );
      await unlock(lk.lockHandle, 'jar: unlock');
      await closeSession();
    },

    // ---- two-tab / two-browser lock tests -------------------------------------------------

    /** Lock and keep holding (no unlock, no close). Run in tab A. */
    async holdLock() {
      await fetchCsrf('csrf (stateful)', 'stateful');
      const lk = await lock('hold-lock');
      if (lk.lockHandle) {
        saveState({ heldLock: { handle: lk.lockHandle, at: now(), tab: tabId, program: S.cfg.testProgram } });
        out('ok', `holding lock on ${S.cfg.testProgram}. Now: try lock in another tab / incognito, or close this tab.`);
      }
    },

    /** Try to lock without unlocking afterwards. Run in tab B (same browser) or in an incognito window. */
    async tryLock() {
      if (!S.csrf) await fetchCsrf('csrf (stateful)', 'stateful');
      const held = loadShared().heldLock;
      const lk = await lock('try-lock');
      if (lk.lockHandle) {
        const sameHandle = held && held.handle === lk.lockHandle;
        note(
          `try-lock SUCCEEDED${held ? ` while tab ${held.tab} holds a lock since ${held.at}` : ''}; ` +
            `same handle as held: ${held ? sameHandle : 'n/a (no shared state — different browser profile?)'}. ` +
            'Success while another tab holds it ⇒ both tabs share one SAP stateful context (shared cookie jar).',
        );
        S.lastTryHandle = lk.lockHandle;
      } else {
        note(`try-lock FAILED with ${lk.entry.status}: ${lk.entry.bodySnippet.slice(0, 200)}`);
      }
    },

    /**
     * Tab A, instead of holdLock: on pagehide, send a keepalive stateless close-session so SAP can end the
     * context (and its enqueue locks) without waiting for the session timeout. A normal fetch is cancelled on unload.
     */
    async holdLockAutoRelease() {
      await tests.holdLock();
      if (!loadShared().heldLock) return;
      window.addEventListener('pagehide', () => {
        const url = new URL('/sap/bc/adt/core/http/sessions', location.origin);
        if (S.cfg.sapClient) url.searchParams.set('sap-client', S.cfg.sapClient);
        url.searchParams.set('sap-language', 'EN');
        fetch(url, {
          keepalive: true,
          credentials: 'include',
          headers: { Accept: '*/*', 'X-sap-adt-sessiontype': 'stateless', 'sap-adt-purpose': 'close-session' },
        });
      });
      out('ok', 'pagehide close registered: close this tab, then Poll lock from an incognito window');
    },

    /** Tab A, after Hold lock: PUT with the held handle. 423 ⇒ something (e.g. another tab) ended the shared context. */
    async putHeld() {
      const held = loadShared().heldLock;
      if (!held) return out('warn', 'no held lock in localStorage');
      if (!S.csrf) await fetchCsrf('csrf (no session header)');
      const r = await req('put-held', {
        method: 'PUT',
        path: `${progUrl()}/source/main?lockHandle=${encodeURIComponent(held.handle)}`,
        session: 'stateful',
        body: `REPORT ${S.cfg.testProgram.toLowerCase()}.\n* put-held ${now()} tab ${tabId}\n`,
        contentType: 'text/plain',
      });
      note(`put-held with lock from tab ${held.tab} (${held.at}): ${r.entry.status}`);
    },

    /** Tab B: send only the stateless close-session request, as a second ARC-1 tab would after its own write. */
    async closeOnly() {
      await closeSession('close-only');
    },

    async releaseLock() {
      const handle = S.lastTryHandle || loadShared().heldLock?.handle;
      if (!handle) return out('warn', 'no known lock handle in this tab or localStorage');
      if (!S.csrf) await fetchCsrf('csrf (stateful)', 'stateful');
      await unlock(handle, 'release-lock');
      await closeSession();
      saveState({ heldLock: null });
      S.lastTryHandle = null;
    },

    /** After closing the tab that held the lock: poll until a lock succeeds, then release. */
    async pollLock() {
      const every = Number(prompt('Poll every N seconds?', '30')) || 30;
      const maxMin = Number(prompt('Give up after N minutes?', '90')) || 90;
      const held = loadShared().heldLock;
      const start = Date.now();
      S.loops.pollLock = true;
      note(`poll-lock started (every ${every}s, max ${maxMin}min); held lock recorded at ${held?.at ?? 'unknown'}`);
      while (S.loops.pollLock && Date.now() - start < maxMin * 60000) {
        await fetchCsrf('poll csrf', 'stateful');
        const lk = await lock('poll-lock');
        if (lk.lockHandle) {
          const since = held?.at ? Math.round((Date.now() - Date.parse(held.at)) / 1000) : null;
          note(`poll-lock acquired after ${Math.round((Date.now() - start) / 1000)}s of polling; ${since ?? '?'}s since the hold`);
          await unlock(lk.lockHandle, 'poll-unlock');
          await closeSession();
          saveState({ heldLock: null });
          break;
        }
        await closeSession('poll close-session');
        await sleep(every * 1000);
      }
      S.loops.pollLock = false;
    },

    // ---- session timeout -------------------------------------------------------------------

    async probeOnce() {
      await req('session-probe follow', { path: '/sap/bc/adt/core/discovery', session: 'stateless' });
      await req('session-probe manual', { path: '/sap/bc/adt/core/discovery', session: 'stateless', redirect: 'manual' });
      await req('session-probe POST', {
        method: 'POST',
        path: '/sap/bc/adt/activation?method=activate&preauditRequested=false',
        body: '<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>',
        contentType: 'application/*',
        retryCsrf: false,
      });
    },

    async sessionWatch() {
      const every = Number(prompt('Probe every N seconds?', '60')) || 60;
      S.loops.watch = true;
      const start = Date.now();
      note(`session-watch started (every ${every}s)`);
      while (S.loops.watch) {
        const r = await req('session-watch', { path: '/sap/bc/adt/core/discovery', session: 'stateless' });
        if (!r.ok) {
          note(`session-watch: first non-OK after ${Math.round((Date.now() - start) / 60000)} min`);
          await tests.probeOnce();
          break;
        }
        await sleep(every * 1000);
      }
      S.loops.watch = false;
    },

    stopLoops() {
      S.loops = {};
      out('warn', 'loops stopped');
    },

    async deleteTestProg() {
      await fetchCsrf('csrf (stateful)', 'stateful');
      const lk = await lock('delete: lock');
      if (!lk.lockHandle) return note('delete: could not lock');
      await req('delete', {
        method: 'DELETE',
        path: `${progUrl()}?lockHandle=${encodeURIComponent(lk.lockHandle)}`,
        session: 'stateful',
      });
      await closeSession();
      const gone = await req('delete: verify', { path: progUrl(), headers: { Accept: 'application/*' } });
      note(`delete: object now returns ${gone.entry.status}`);
      saveState({ heldLock: null });
    },

    async report() {
      const md = buildReport();
      console.log(md);
      try {
        await navigator.clipboard.writeText(md);
        out('ok', 'report copied to clipboard (also in console)');
      } catch {
        out('warn', 'clipboard blocked; report printed to console and shown in a text box');
        showText(md);
      }
      return md;
    },

    downloadJson() {
      const blob = new Blob(
        [JSON.stringify({ env: S.env, notes: S.notes, log: S.log.map((e) => ({ ...e, raw: undefined })) }, null, 2)],
        { type: 'application/json' },
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `arc1-browser-spike-${location.host}-${Date.now()}.json`;
      a.click();
    },
  };

  function diffCookies(label, before, after) {
    const b = new Set(cookieNames(before));
    const a = new Set(cookieNames(after));
    const added = [...a].filter((n) => !b.has(n));
    const removed = [...b].filter((n) => !a.has(n));
    const ctx = after.cookies.find((c) => c.name === 'sap-contextid');
    note(
      `cookies ${label} (via ${after.via}): added [${added.join(', ')}], removed [${removed.join(', ')}]; ` +
        `sap-contextid ${ctx ? `visible to page, path=${ctx.path ?? '?'}, expires=${ctx.expires ?? '?'}, valueLength=${ctx.valueLength}` : 'NOT visible to page (HttpOnly or path does not cover this page)'}`,
    );
  }

  function buildReport() {
    const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
    const lines = [];
    lines.push('# ARC-1 browser ADT session spike — raw report', '');
    lines.push('## Environment', '', '```json', JSON.stringify(S.env, null, 2), '```', '');
    lines.push('## Notes', '');
    for (const n of S.notes) lines.push(`- ${n.at} [tab ${n.tab}] ${n.text}`);
    lines.push('', '## Requests', '');
    lines.push('| # | time | step | method | path | session | status | type | redir | final path | content-type | ms | login? |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    S.log.forEach((e, i) =>
      lines.push(
        `| ${i + 1} | ${e.at.slice(11, 19)} | ${esc(e.step)} | ${e.method} | ${esc(e.path)} | ${e.session} | ${e.status} | ${e.type} | ${e.redirected ? 'yes' : ''} | ${esc(e.finalPath)} | ${esc(e.contentType)} | ${e.ms} | ${e.looksLikeLogin ? 'YES' : ''} |`,
      ),
    );
    lines.push('', '## Non-2xx / suspicious bodies', '');
    for (const [i, e] of S.log.entries()) {
      if ((typeof e.status === 'number' && e.status >= 200 && e.status < 300 && !e.looksLikeLogin) || !e.bodySnippet) continue;
      lines.push(`- #${i + 1} ${e.step} (${e.status}): \`${esc(e.bodySnippet.slice(0, 300))}\``);
    }
    lines.push('', '## Response header names seen', '');
    const hdrs = new Set(S.log.flatMap((e) => e.responseHeaderNames));
    lines.push([...hdrs].sort().join(', '));
    return lines.join('\n');
  }

  function showText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    Object.assign(ta.style, { width: '100%', height: '200px', fontSize: '11px' });
    S.panel.appendChild(ta);
    ta.select();
  }

  // ---------------------------------------------------------------- serial runner + UI

  let chain = Promise.resolve();
  const run = (name) => {
    chain = chain.then(async () => {
      out('info', `▶ ${name}`);
      try {
        await tests[name]();
      } catch (e) {
        out('error', `${name} threw: ${e}`);
      }
    });
    return chain;
  };
  // Loops must not block the queue, otherwise "stop" would wait behind them.
  const runLoop = (name) => {
    out('info', `▶ ${name}`);
    tests[name]().catch((e) => out('error', `${name} threw: ${e}`));
  };

  const panel = document.createElement('div');
  S.panel = panel;
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    width: '440px',
    maxHeight: '70vh',
    overflow: 'auto',
    zIndex: 2147483647,
    background: '#1e1e1e',
    color: '#e0e0e0',
    font: '12px/1.4 ui-monospace, monospace',
    padding: '8px',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,.4)',
  });
  panel.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>ARC-1 ADT spike · tab ${tabId}</b><span style="cursor:pointer" data-x>✕</span></div>`;
  panel.querySelector('[data-x]').onclick = () => panel.remove();

  const fields = [
    ['sapClient', 'sap-client'],
    ['readProgram', 'read program'],
    ['testProgram', 'test program ($TMP)'],
    ['hostProbeUrl', 'host probe URL'],
  ];
  for (const [key, label] of fields) {
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.innerHTML = `<span style="width:130px">${label}</span>`;
    const input = document.createElement('input');
    input.value = S.cfg[key];
    Object.assign(input.style, { flex: '1', font: 'inherit', background: '#333', color: '#fff', border: '1px solid #555' });
    input.onchange = () => {
      S.cfg[key] = key === 'testProgram' ? input.value.trim().toUpperCase() : input.value.trim();
      saveState();
    };
    row.appendChild(input);
    panel.appendChild(row);
  }

  const buttons = [
    ['1 Env', () => run('env')],
    ['2 Discovery', () => run('discovery')],
    ['3 Read source', () => run('readSource')],
    ['4 Write flow', () => run('writeFlow')],
    ['5 Shared-jar read', () => run('sharedJarRead')],
    ['Hold lock', () => run('holdLock')],
    ['Hold lock (auto-release)', () => run('holdLockAutoRelease')],
    ['Put held', () => run('putHeld')],
    ['Close session', () => run('closeOnly')],
    ['Try lock', () => run('tryLock')],
    ['Release lock', () => run('releaseLock')],
    ['Poll lock', () => runLoop('pollLock')],
    ['Probe once', () => run('probeOnce')],
    ['Session watch', () => runLoop('sessionWatch')],
    ['Stop loops', () => tests.stopLoops()],
    ['Delete test prog', () => run('deleteTestProg')],
    ['Report (copy)', () => run('report')],
    ['JSON', () => tests.downloadJson()],
  ];
  const bar = document.createElement('div');
  Object.assign(bar.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '6px 0' });
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, { font: 'inherit', padding: '2px 6px', cursor: 'pointer' });
    b.onclick = fn;
    bar.appendChild(b);
  }
  panel.appendChild(bar);
  S.logEl = document.createElement('div');
  panel.appendChild(S.logEl);
  document.body.appendChild(panel);

  S.run = run;
  S.tests = tests;
  saveState();
  out('ok', `ready on ${location.origin}. Run 1 → 4 in order, then the lock/session tests. API: arcSpike.run('env') etc.`);
})();
