'use strict';

/* ================= storage & state ================= */
/* ---------- second tier for saved replies: IndexedDB ----------
   localStorage holds about 5 MB, so a busy day evicted saved replies and the next
   visit paid to fetch them again. Every saved reply (keys 'c:') is also written to
   IndexedDB, which is far larger. When localStorage is full or a reply is evicted
   from it, the reply stays reachable from memory (loaded from IndexedDB a moment
   after start-up), so it is shown - and re-checked with its free tag - instead of
   being fetched from scratch. */
const T2 = { mem: {}, db: null, q: {}, timer: 0, max: 4000, memMax: 1000 };
function t2Is(key) { return key.indexOf('onegit.c:') === 0; }
function t2Put(key, str) {
  try {
    if (typeof indexedDB === 'undefined') return;
    T2.q[key] = str;
    if (!T2.timer) T2.timer = setTimeout(t2Flush, 1500);
  } catch (e) { }
}
function t2Flush() {
  T2.timer = 0;
  try {
    if (!T2.db) { T2.timer = setTimeout(t2Flush, 3000); return; }
    const q = T2.q; T2.q = {};
    const keys = Object.keys(q);
    if (!keys.length) return;
    const st = T2.db.transaction('c', 'readwrite').objectStore('c');
    const now = Date.now();
    keys.forEach(k => { if (q[k] === null) st.delete(k); else st.put({ k, v: q[k], at: now }); });
  } catch (e) { }
}
function t2Hydrate() {
  try {
    const st = T2.db.transaction('c', 'readonly').objectStore('c');
    const rows = [];
    const rq = st.openCursor();
    rq.onsuccess = () => {
      const cur = rq.result;
      if (cur) { rows.push({ k: cur.value.k, at: cur.value.at || 0, v: cur.value.v }); cur.continue(); return; }
      /* keep the newest T2.max; forget the rest */
      rows.sort((a, b) => b.at - a.at);
      const drop = rows.slice(T2.max);
      if (drop.length) { try { const w = T2.db.transaction('c', 'readwrite').objectStore('c'); drop.forEach(r => w.delete(r.k)); } catch (e) { } }
      rows.slice(0, T2.max).forEach(r => {
        try {
          /* only what localStorage no longer holds needs to live in memory */
          if (Object.keys(T2.mem).length < T2.memMax && localStorage.getItem(r.k) === null && !(r.k in T2.mem)) {
            const rest = r.k.slice(r.k.indexOf(':', 8) + 1);
            if (rest.indexOf('/') === 0) T2.mem[r.k] = r.v;
          }
        } catch (e) { }
      });
    };
  } catch (e) { }
}
try {
  if (typeof indexedDB !== 'undefined') {
    const rq = indexedDB.open('gitly-cache', 1);
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore('c', { keyPath: 'k' }); } catch (e) { } };
    rq.onsuccess = () => { T2.db = rq.result; setTimeout(t2Hydrate, 1200); };
  }
} catch (e) { }
/* a reply leaves localStorage but is kept in memory and IndexedDB */
function t2Evict(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && Object.keys(T2.mem).length < T2.memMax) { T2.mem[key] = v; t2Put(key, v); }
    localStorage.removeItem(key);
  } catch (e) { }
}
const LS = {
  get(k, d) {
    try {
      const key = 'onegit.' + k;
      let v = localStorage.getItem(key);
      if (v === null && t2Is(key) && key in T2.mem) v = T2.mem[key];
      return v === null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  set(k, v) {
    const key = 'onegit.' + k;
    let str;
    try { str = JSON.stringify(v); } catch (e) { return false; }
    const cacheEntry = t2Is(key);
    if (cacheEntry) t2Put(key, str);
    try { localStorage.setItem(key, str); if (cacheEntry) delete T2.mem[key]; return true; }
    catch (e) {
      /* storage full - the disposable API cache goes first, then try again.
         Accounts, the token and preferences must never be the thing that fails. */
      try { pruneCache(0); } catch (e1) { }
      try { pruneImages(); } catch (e2) { }
      try { localStorage.setItem(key, str); if (cacheEntry) delete T2.mem[key]; return true; }
      catch (e3) { if (cacheEntry && Object.keys(T2.mem).length < T2.memMax) { T2.mem[key] = str; return true; } return cacheEntry; }
    }
  },
  del(k) {
    const key = 'onegit.' + k;
    try { localStorage.removeItem(key); } catch (e) { }
    if (t2Is(key)) { delete T2.mem[key]; t2Put(key, null); }
  }
};
/* keep the cached API replies from filling the device's storage: they are only
   a speed-up, so they are the first thing to go when space runs short. */
/* These are the screens someone actually lands on. Their saved replies are the
   last thing to go, so the app always has something to show even with no
   requests left at all. */
const CACHE_KEEP = ['/user', '/user/repos', '/notifications', '/issues', '/user/starred', '/user/events', '/gists'];
function cacheIsKept(k) { return CACHE_KEEP.some(p => k.indexOf(p) > -1); }
/* images saved for READMEs are disposable too - they go before anything the
   user would miss, so the account list and the token always have room */
function pruneImages() {
  try {
    (LS.get('imgIdx', []) || []).forEach(k => { try { localStorage.removeItem('onegit.img:' + k); } catch (e) { } });
    LS.del('imgIdx');
  } catch (e) { }
}
function pruneCache(keep) {
  try {
    const keys = Object.keys(localStorage).filter(k => k.indexOf('onegit.c:') === 0);
    if (!keys.length) return;
    if (!keep || keep <= 0) {
      /* even then, the essentials stay: a full cache is better than a dead app */
      keys.filter(k => !cacheIsKept(k)).forEach(k => t2Evict(k));
      return;
    }
    let over = keys.length - keep;
    if (over <= 0) return;
    /* drop the least recently saved first (not whatever the browser lists first), and a
       tenth extra, so a full cache is not re-sorted on every single write */
    over += Math.ceil(keep / 10);
    const droppable = keys.filter(k => !cacheIsKept(k)).map(k => {
      let at = 0; try { at = (JSON.parse(localStorage.getItem(k)) || {}).at || 0; } catch (e) { }
      return [k, at];
    }).sort((a, b) => a[1] - b[1]);
    while (over > 0 && droppable.length) { t2Evict(droppable.shift()[0]); over--; }
  } catch (e) { }
}
/* Which account everything cached below belongs to. A reply saved for one
   account must never be handed to another - and keeping them apart is what lets
   a switch show that account's screens at once instead of wiping the lot. */
let ACCT = String(LS.get('cur', '') || '').toLowerCase();
/* one-time: drop replies saved before they were kept per account */
try {
  Object.keys(localStorage).forEach(k => {
    if (k.indexOf('onegit.c:') !== 0 && k.indexOf('onegit.offline.list.') !== 0) return;
    const rest = k.slice(k.indexOf(':', 8) + 1);
    if (rest.indexOf('/') !== 0) { try { localStorage.removeItem(k); } catch (e) { } }
  });
} catch (e) { }

let TOKEN = LS.get('token', null);
let TOKEN_SCOPES = LS.get('tokenScopes', null);
/* what kind of credential is the current account signed in with */
function loginMethod() {
  const t = TOKEN || '';
  if (t.startsWith('github_pat_')) return 'fine';
  if (t.startsWith('gho_')) return 'oauth';
  if (t.startsWith('ghp_')) return 'classic';
  if (t.startsWith('ghu_')) return 'app';
  return 'token';
}
function loginMethodLabel() {
  switch (loginMethod()) {
    case 'fine': return 'Fine-grained personal access token (github_pat_)';
    case 'classic': return 'Personal access token, classic (ghp_)';
    case 'oauth': return 'GitHub sign-in, device flow';
    case 'app': return 'GitHub App user token';
    default: return 'Personal access token';
  }
}
let RSEQ = 0;
let lastOfflineToast = 0;
const API_MEM = {};
/* When GitHub says the hour's requests are gone it also says when they come
   back. Until then nothing is sent: the app serves what it has saved and waits.
   Hammering on is what turns one limit into a wall of errors on every screen. */
let RL_UNTIL = Number(LS.get('rlUntil', 0)) || 0;
let RL_LEFT = null, RL_MAX = null;
/* true when the activity on screen came from GitHub's own feed because the API
   was out of budget - the app says so rather than pretending */
let FEED_FALLBACK = false;
/* Below this the app stops spending: it will still revalidate for free, but it
   will not make a request that costs, so the last of the hour is never burnt on
   something the user did not ask for. */
const RL_FLOOR = 300;
function rlActive() { return RL_UNTIL > Date.now(); }
/* GitHub keeps separate hourly budgets: REST ("core"), GraphQL and search. Running
   out of one must not stop the others, so each is tracked on its own. */
let GQL_UNTIL = Number(LS.get('gqlUntil', 0)) || 0;
let SEARCH_UNTIL = 0;
function gqlActive() { return GQL_UNTIL > Date.now(); }
function gqlSet(until) { if (!until || until <= Date.now()) return; GQL_UNTIL = Math.max(GQL_UNTIL, until); LS.set('gqlUntil', GQL_UNTIL); }
function blockedFor(path) {
  if (String(path).indexOf('/graphql') === 0) return gqlActive();
  if (String(path).indexOf('/search') === 0) return SEARCH_UNTIL > Date.now();
  return rlActive();
}
function budgetLow() { return RL_LEFT !== null && RL_LEFT <= RL_FLOOR; }
function budgetNote() { try { return RL_LEFT === null ? '' : (RL_LEFT + (RL_MAX ? '/' + RL_MAX : '') + ' requests left this hour'); } catch (e) { return ''; } }
function rlSet(until) {
  if (!until || until <= Date.now()) return;
  RL_UNTIL = Math.max(RL_UNTIL, until);
  LS.set('rlUntil', RL_UNTIL);
  try { updateLimitBar(); } catch (e) { }   /* say so the moment we know */
}
/* real version from the installed package (never goes stale when rebuilding);
   the constant is only a fallback for very old builds without the bridge */
const APPV = (window.OneGit && window.OneGit.appVersion ? String(window.OneGit.appVersion() || '') : '') || '3.16';
const UPD_REPO = 'BonkerUnkilBonki/Gitly-Update';
/* when this app was installed/updated - ANY release published after this
   moment counts as an update, no version parsing at all */
const INSTALLED_AT = (window.OneGit && window.OneGit.appInstallTime ? Number(window.OneGit.appInstallTime() || 0) : 0);
/* pulls a version number out of a release - tags like v2.60, names like
   "vStable 2.60" or plain "V2.60" all yield 2.60; tag-only words like
   "vStable" fall back to the release name */
function releaseVersion(rel) {
  const src = [rel && rel.tag_name, rel && rel.name].filter(Boolean).join(' ');
  const m = String(src).match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : '';
}
let USER = null;
let pins = LS.get('pins', []);
let gistId = LS.get('gistId', null);
let syncTimer = null;
const repoCache = new Map();

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => '&' + '#' + c.charCodeAt(0) + ';');
}
function nf(n) { n = n | 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm'; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k'; return String(n); }
function tAgo(iso) { if (!iso) return ''; const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 2592e3) return Math.floor(s / 86400) + 'd ago'; if (s < 31536e3) return Math.floor(s / 2592e3) + 'mo ago'; return Math.floor(s / 31536e3) + 'y ago'; }
function fmtSize(b) { if (b == null || b === '') return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
function toast(msg) {
  const box = $('#toasts');
  if (!box) return;
  /* One toast at a time. Tapping a button repeatedly used to stack nine copies
     of the same message up the screen, which buried the thing being reported. */
  box.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}
/* File contents with a line-number gutter, one row per line so long lines can
   wrap (like the GitHub app) without the numbers drifting out of step. */
function codeWithLines(text) {
  let body = String(text == null ? '' : text);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const rows = body.split('\n').map((ln, i) =>
    '<div class="coderow"><span class="ln" aria-hidden="true">' + (i + 1) + '</span>' +
    '<span class="codetext">' + esc(ln || ' ') + '</span></div>').join('');
  return '<div class="codewrap">' + rows + '</div>';
}
/* A commit is a short title plus an optional longer description, exactly as
   GitHub writes one: the title, a blank line, then the body. Every path that
   commits builds its message here so the shape never drifts. */
function commitComposer(prefix, title, titlePh) {
  return '<label class="fldlabel">' + esc(i18n('commitMessage')) + '</label>' +
    '<input class="fld" id="' + prefix + 'Title" value="' + esc(title || '') + '"' +
    (titlePh ? ' placeholder="' + esc(titlePh) + '"' : '') + ' autocomplete="off" autocapitalize="sentences">' +
    '<label class="fldlabel" style="margin-top:14px">' + esc(i18n('commitDesc')) +
    ' <span class="dim" style="font-weight:400">' + esc(i18n('optional')) + '</span></label>' +
    '<textarea class="replyta cmdesc" id="' + prefix + 'Desc" rows="3" placeholder="' + esc(i18n('commitDescPh')) + '"></textarea>';
}
function commitMsg(prefix, fallback) {
  const tEl = $('#' + prefix + 'Title'), dEl = $('#' + prefix + 'Desc');
  const t = ((tEl && tEl.value) || '').trim() || fallback;
  const d = ((dEl && dEl.value) || '').trim();
  return d ? t + '\n\n' + d : t;
}

function spinner(sm) { return '<div class="spinwrap' + (sm ? ' sm' : '') + '"><div class="spinner"></div></div>'; }
/* Errors are explained, never dumped: GitHub's own wording is not something to
   put in front of anyone. */
function errCard(e) {
  const msg = (e && e.message) || '';
  if ((e && e.rateLimited) || /rate limit|secondary rate/i.test(msg)) {
    let when = ' Gitly will start again shortly.';
    if (RL_UNTIL > Date.now()) {
      const m = Math.max(1, Math.round((RL_UNTIL - Date.now()) / 60000));
      when = ' Gitly will start again in about ' + m + ' minute' + (m === 1 ? '' : 's') + '.';
    }
    return '<div class="card empty"><div class="ltitle">GitHub is asking us to slow down</div>' +
      '<div class="lsub" style="margin-top:8px">This hour\u2019s GitHub requests are used up.' + when +
      ' Everything already loaded stays on screen, and nothing has been lost.</div></div>';
  }
  return '<div class="card empty">' + esc(msg || 'Something went wrong') + '</div>';
}
function isoDaysAgo(d) { const dt = new Date(Date.now() - d * 864e5); return dt.toISOString().slice(0, 10); }

const LANG = { JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Kotlin: '#A97BFF', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Go: '#00ADD8', Rust: '#dea584', Ruby: '#701516', Swift: '#F05138', Dart: '#00B4AB', PHP: '#4F5D95', HTML: '#e34c26', CSS: '#563d7c', Shell: '#89e051', Vue: '#41b883' };
function langColor(l) { return LANG[l] || '#8a8a8a'; }

const SVG = {
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.2"/><ellipse cx="12" cy="12" rx="4" ry="9.2"/><line x1="2.8" y1="12" x2="21.2" y2="12"/><path d="M4.4 6.8h15.2M4.4 17.2h15.2"/></svg>',
  commit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.5"/><line x1="1" y1="12" x2="8.5" y2="12"/><line x1="15.5" y1="12" x2="23" y2="12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 5 3 12 8 19"/><polyline points="16 5 21 12 16 19"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" fill="#229ED9" width="20" height="20"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
};

/* ================= api ================= */
/* Counts every request this app sends, by endpoint, for the current clock hour
   (GitHub's limit resets on the hour). Shown in the limit bar so it is clear
   what is spending the budget. 304 replies are counted separately: they are free. */
function usageKey(path) {
  return String(path).split('?')[0]
    .replace(/^\/repos\/[^\/]+\/[^\/]+/, '/repos/{repo}')
    .replace(/^\/users\/[^\/]+/, '/users/{user}')
    .replace(/\/\d+/g, '/#');
}
function usageCount(path, status) {
  try {
    const hr = usageWin();
    let u = LS.get('usage.' + (ACCT || ''), null);
    if (!u || u.h !== hr) u = { h: hr, n: {} };
    const k = usageKey(path) + (status === 304 ? ' (304 free)' : '');
    u.n[k] = (u.n[k] || 0) + 1;
    LS.set('usage.' + (ACCT || ''), u);
  } catch (e) { }
}
function usageTop(n) {
  try {
    const u = LS.get('usage.' + (ACCT || ''), null);
    if (!u || u.h !== usageWin()) return [];
    return Object.keys(u.n).map(k => [k, u.n[k]]).sort((a, b) => b[1] - a[1]).slice(0, n || 5);
  } catch (e) { return []; }
}

/* ===== live budgets =====
   GitHub reports the budget in the headers of every reply, and this reads ONLY
   those. The app never sends a request of its own to find the numbers out (no
   /rate_limit polling, no refresh button), so showing them costs nothing at all.
   The numbers are as of the last reply the app received for something else. */
/* The hour's allowance belongs to the ACCOUNT that spends it, so it is kept per
   account. It used to be one global object, which is why switching accounts
   showed the previous account's numbers - it looked like both accounts shared
   one credit. */
const BUDGET = { core: null, graphql: null, search: null };
function budgetKey() { return 'budget.' + (ACCT || ''); }
/* load the saved numbers for whoever is signed in now */
function budgetLoad() {
  try {
    const saved = LS.get(budgetKey(), null);
    BUDGET.core = (saved && saved.core) || null;
    BUDGET.graphql = (saved && saved.graphql) || null;
    BUDGET.search = (saved && saved.search) || null;
    RL_LEFT = BUDGET.core ? BUDGET.core.left : null;
    RL_MAX = BUDGET.core ? BUDGET.core.limit : null;
    paintBudgetChip();
  } catch (e) { }
}
function budgetSet(name, limit, left, reset) {
  try {
    if (!Object.prototype.hasOwnProperty.call(BUDGET, name)) return;
    if (!isFinite(limit) || !isFinite(left)) return;
    BUDGET[name] = { limit: limit, left: left, reset: reset || 0, at: Date.now() };
    if (name === 'core') { RL_LEFT = left; RL_MAX = limit; }
    /* keep it with the account that spent it */
    try { LS.set(budgetKey(), { core: BUDGET.core, graphql: BUDGET.graphql, search: BUDGET.search }); } catch (e) { }
    paintBudgetChip();
  } catch (e) { }
}
function budgetFromRes(res) {
  try {
    const rs = res.headers.get('X-RateLimit-Resource') || 'core';
    const lim = res.headers.get('X-RateLimit-Limit'), rem = res.headers.get('X-RateLimit-Remaining'), rst = res.headers.get('X-RateLimit-Reset');
    if (lim !== null && rem !== null) budgetSet(rs, Number(lim), Number(rem), Number(rst || 0) * 1000);
  } catch (e) { }
}
/* spread the load: a request that would be paid for goes to whichever budget has more room */
function preferGql() {
  const c = BUDGET.core, g = BUDGET.graphql;
  return !!(c && g && !gqlActive() && c.left < c.limit * 0.6 && g.left > c.left);
}
function usageWin() { return (BUDGET.core && BUDGET.core.reset) || Math.floor(Date.now() / 3600000); }
function usageMine() {
  try {
    const u = LS.get('usage.' + (ACCT || ''), null);
    if (!u || u.h !== usageWin()) return 0;
    let n = 0;
    for (const k in u.n) { if (k.indexOf('(304') >= 0 || k.indexOf('/graphql') === 0 || k.indexOf('/search') === 0) continue; n += u.n[k]; }
    return n;
  } catch (e) { return 0; }
}
function fmtN(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
function budgetColor(b) { if (!b || !b.limit) return '#8a8a8a'; const f = b.left / b.limit; return f > 0.5 ? '#2ecc71' : (f > 0.2 ? '#f5a623' : '#ff5d5d'); }
function resetIn(b) {
  if (!b || !b.reset) return '';
  const sec = Math.max(0, Math.round((b.reset - Date.now()) / 1000));
  return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
}
/* there is no floating chip any more: the numbers live in Settings > API budget.
   This just keeps that card current when a reply changes them (no request is made). */
function paintBudgetChip() {
  try {
    const old = document.getElementById('budgetChip'); if (old) old.remove();
    const card = document.getElementById('budgetCard');
    if (card) card.innerHTML = budgetBodyHTML();
  } catch (e) { }
}
function budgetAgo(b) {
  if (!b || !b.at) return '';
  const m = Math.floor((Date.now() - b.at) / 60000);
  return m < 1 ? 'just now' : m + ' min ago';
}
function budgetMeter(label, b, note) {
  if (!b) return '<div class="bmrow"><div class="bmtop"><b>' + label + '</b><span>not read yet</span></div></div>';
  const pct = Math.max(0, Math.min(100, Math.round(b.left / b.limit * 100)));
  return '<div class="bmrow"><div class="bmtop"><b>' + label + '</b><span>' + fmtN(b.left) + ' / ' + fmtN(b.limit) + ' left</span></div>' +
    '<div class="bmbar"><i style="width:' + pct + '%;background:' + budgetColor(b) + '"></i></div>' +
    '<div class="bmsub">' + (note ? note + ' \u00b7 ' : '') + (b.reset ? 'resets in ' + resetIn(b) + ' \u00b7 ' : '') + 'read ' + budgetAgo(b) + '</div></div>';
}
function budgetBodyHTML() {
  const c = BUDGET.core;
  let who = '';
  if (c) {
    const used = c.limit - c.left, mine = Math.min(usageMine(), used), other = Math.max(0, used - mine);
    who = '<div class="bmsub" style="margin-top:10px">REST used this window: <b>' + fmtN(used) + '</b>. Sent by this app\u2019s screens: about <b>' + fmtN(mine) +
      '</b>. From elsewhere (widgets, background checks, other devices or apps on your account): about <b>' + fmtN(other) + '</b>.</div>';
  }
  const top = usageTop(6);
  return budgetMeter('REST', BUDGET.core, 'most of the app') + budgetMeter('GraphQL', BUDGET.graphql, 'separate budget (points)') + budgetMeter('Search', BUDGET.search, 'separate, per minute') +
    who + streamsHTML() + (ROUTE_NOTE ? '<div class="bmsub" style="margin-top:6px">Last fallback answer came via ' + esc(ROUTE_NOTE) + '</div>' : '') +
    (top.length ? '<div class="bmsub" style="margin-top:10px">Busiest endpoints this window: ' + top.map(t => esc(t[0]) + ' \u00d7' + t[1]).join(' \u00b7 ') + '</div>' : '') +
    '<div class="bmsub" style="margin-top:12px">Read from the replies GitHub already sends for other things. Looking at this sends no request and uses no budget, so a meter that has not been used yet says \u201cnot read yet\u201d.</div>';
}
let acctSwitching = false;
/* consecutive 401s with the live token, and when the last one landed */
let BAD_401 = 0, BAD_401_T = 0;
/* Identical GETs fired at the same time (a screen and the background sync, say)
   share one request instead of racing each other - which matters a lot on a
   slow connection. */
const API_INFLIGHT = {};
/* drop every in-flight entry - called whenever the session changes, so a reply
   that belonged to the previous account can never be handed to the new one */
function dropInflight() { try { for (const k in API_INFLIGHT) delete API_INFLIGHT[k]; } catch (e) { } }
/* the in-memory replies are per account as well - they used to survive a switch
   and hand the previous account's data to the new one */
function dropApiMem() { try { for (const k in API_MEM) delete API_MEM[k]; } catch (e) { } }
async function api(path, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  /* the key carries the token: two accounts asking for the same path must never
     share one reply (that is how a sign-in used to adopt the previous account) */
  const ikey = path + '\u0000' + (TOKEN || '');
  if (isGet && !opts.status && API_INFLIGHT[ikey]) return API_INFLIGHT[ikey];
  const run = apiOnce(path, opts);
  if (isGet && !opts.status) {
    API_INFLIGHT[ikey] = run;
    run.then(() => { delete API_INFLIGHT[ikey]; }, () => { delete API_INFLIGHT[ikey]; });
  }
  return run;
}
/* GitHub answers a conditional request with 304 when nothing has changed, and
   a 304 does not count against the hourly limit at all - so a screen that is
   simply being kept up to date costs nothing. That is what lets the app keep
   running all day instead of running out. */
function cacheKey(path, status) { return 'c:' + (ACCT ? ACCT + ':' : '') + path + (status ? '\u0000st' : ''); }
/* the durable copy of a list - kept under 'offline.' so no cache-clearing path
   touches it, and per account for the same reason as the cache */
function durableKey(path) { return 'offline.list.' + (ACCT ? ACCT + '.' : '') + path; }

/* ===== routes: when one budget is gone, the next one takes over =====
   GitHub keeps separate hourly budgets (REST, GraphQL, search). Only some of them
   can answer the same question, so the order is: REST (its free 304 checks come
   first, in apiOnce) -> GraphQL -> REST search -> GitHub's public feeds (no budget
   at all) -> what is saved on the device. A step is skipped while its own budget
   is used up. Every answer is shaped like the REST reply the screens already
   expect, so no screen needs to change. A route that cannot answer simply returns
   undefined and the next one is tried. */
const GQL_REPO = 'databaseId nameWithOwner name description stargazerCount forkCount isPrivate isFork isArchived url pushedAt updatedAt createdAt primaryLanguage{name} owner{login avatarUrl} defaultBranchRef{name}';
function gqlRepoToRest(n) {
  return {
    id: n.databaseId, name: n.name, full_name: n.nameWithOwner, description: n.description || null,
    stargazers_count: n.stargazerCount || 0, forks_count: n.forkCount || 0, private: !!n.isPrivate,
    fork: !!n.isFork, archived: !!n.isArchived, html_url: n.url, language: n.primaryLanguage ? n.primaryLanguage.name : null,
    pushed_at: n.pushedAt, updated_at: n.updatedAt, created_at: n.createdAt,
    owner: { login: n.owner ? n.owner.login : '', avatar_url: n.owner ? n.owner.avatarUrl : '' },
    default_branch: n.defaultBranchRef ? n.defaultBranchRef.name : 'main'
  };
}
function qsGet(qs, k) { try { return new URLSearchParams(qs).get(k); } catch (e) { return null; } }
function splitPath(path) { const i = path.indexOf('?'); return { base: i < 0 ? path : path.slice(0, i), qs: i < 0 ? '' : path.slice(i + 1) }; }
let ROUTE_NOTE = '';

/* what to ask GraphQL for each REST path it can stand in for (first page only:
   GraphQL pages by cursor, not by page number) */
const GQL_ISS = 'databaseId number title state createdAt updatedAt closedAt url comments{totalCount} author{login avatarUrl} repository{nameWithOwner} labels(first:8){nodes{name color}}';
function gqlIssueToRest(x) {
  const pr = x.__typename === 'PullRequest';
  const o = {
    id: x.databaseId, number: x.number, title: x.title, state: x.state === 'OPEN' ? 'open' : 'closed',
    created_at: x.createdAt, updated_at: x.updatedAt, closed_at: x.closedAt || null, html_url: x.url,
    comments: x.comments ? x.comments.totalCount : 0,
    user: x.author ? { login: x.author.login, avatar_url: x.author.avatarUrl } : null,
    repository_url: 'https://api.github.com/repos/' + (x.repository ? x.repository.nameWithOwner : ''),
    labels: ((x.labels && x.labels.nodes) || []).filter(Boolean).map(l => ({ name: l.name, color: l.color }))
  };
  if (pr) {
    o.pull_request = { html_url: x.url, merged_at: x.mergedAt || null };
    o.draft = !!x.isDraft; o.merged_at = x.mergedAt || null; o.merged = !!x.mergedAt;
    o.head = { ref: x.headRefName || '' }; o.base = { ref: x.baseRefName || '' };
  }
  return o;
}
/* the search words that stand in for each REST list of issues / pull requests */
function issueQ(base, qs) {
  let m;
  const st = qsGet(qs, 'state') || 'open', stw = st === 'all' ? '' : ' is:' + st;
  if (base === '/issues') {
    const f = qsGet(qs, 'filter') || 'assigned';
    const who = f === 'created' ? 'author:@me' : f === 'mentioned' ? 'mentions:@me' : (f === 'subscribed' || f === 'all') ? 'involves:@me' : 'assignee:@me';
    return who + stw;
  }
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/issues$/.exec(base))) return 'repo:' + decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]) + stw;
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/pulls$/.exec(base))) return 'is:pr repo:' + decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]) + stw;
  return null;
}
function gqlPlan(path) {
  const { base, qs } = splitPath(path);
  const pg = qsGet(qs, 'page');
  if (pg && pg !== '1') return null;
  const n = Math.max(1, Math.min(100, Number(qsGet(qs, 'per_page')) || 30));
  let m;
  if (base === '/user') return {
    query: 'query{viewer{databaseId login name avatarUrl bio company location websiteUrl url createdAt email followers{totalCount} following{totalCount} repositories(ownerAffiliations:OWNER){totalCount}}}',
    vars: {},
    pick: d => { const v = d.viewer; return { id: v.databaseId, login: v.login, name: v.name || null, avatar_url: v.avatarUrl, bio: v.bio || null, company: v.company || null,
      location: v.location || null, blog: v.websiteUrl || '', html_url: v.url, created_at: v.createdAt, email: v.email || null,
      followers: v.followers ? v.followers.totalCount : 0, following: v.following ? v.following.totalCount : 0,
      public_repos: v.repositories ? v.repositories.totalCount : 0, type: 'User' }; } };
  if (base === '/user/repos') return {
    query: 'query($n:Int!){viewer{repositories(first:$n,orderBy:{field:UPDATED_AT,direction:DESC},affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]){nodes{' + GQL_REPO + '}}}}',
    vars: { n }, pick: d => d.viewer.repositories.nodes.filter(Boolean).map(gqlRepoToRest) };
  if (base === '/user/starred') return {
    query: 'query($n:Int!){viewer{starredRepositories(first:$n,orderBy:{field:STARRED_AT,direction:DESC}){nodes{' + GQL_REPO + '}}}}',
    vars: { n }, pick: d => d.viewer.starredRepositories.nodes.filter(Boolean).map(gqlRepoToRest) };
  if ((m = /^\/users\/([^\/]+)\/repos$/.exec(base))) return {
    query: 'query($l:String!,$n:Int!){user(login:$l){repositories(first:$n,orderBy:{field:' + (qsGet(qs, 'sort') === 'pushed' ? 'PUSHED_AT' : 'UPDATED_AT') + ',direction:DESC},ownerAffiliations:[OWNER],privacy:PUBLIC){nodes{' + GQL_REPO + '}}}}',
    vars: { l: decodeURIComponent(m[1]), n }, pick: d => d.user.repositories.nodes.filter(Boolean).map(gqlRepoToRest) };
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)$/.exec(base))) return {
    query: 'query($o:String!,$r:String!){repository(owner:$o,name:$r){' + GQL_REPO + ' homepageUrl diskUsage isTemplate hasIssuesEnabled hasWikiEnabled viewerPermission licenseInfo{spdxId name} watchers{totalCount} issues(states:OPEN){totalCount} parent{nameWithOwner} repositoryTopics(first:20){nodes{topic{name}}}}}',
    vars: { o: decodeURIComponent(m[1]), r: decodeURIComponent(m[2]) },
    pick: d => {
      const x = d.repository, r = gqlRepoToRest(x), vp = x.viewerPermission || 'READ';
      r.homepage = x.homepageUrl || null; r.size = x.diskUsage || 0; r.is_template = !!x.isTemplate;
      r.has_issues = x.hasIssuesEnabled !== false; r.has_wiki = !!x.hasWikiEnabled;
      r.open_issues_count = x.issues ? x.issues.totalCount : 0;
      r.watchers_count = r.subscribers_count = x.watchers ? x.watchers.totalCount : 0;
      r.license = x.licenseInfo ? { spdx_id: x.licenseInfo.spdxId, name: x.licenseInfo.name } : null;
      r.topics = ((x.repositoryTopics && x.repositoryTopics.nodes) || []).map(t => t.topic.name);
      r.permissions = { admin: vp === 'ADMIN', maintain: vp === 'ADMIN' || vp === 'MAINTAIN', push: /^(ADMIN|MAINTAIN|WRITE)$/.test(vp), triage: vp !== 'READ', pull: true };
      return r;
    } };
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/releases$/.exec(base))) return {
    query: 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){releases(first:$n,orderBy:{field:CREATED_AT,direction:DESC}){nodes{databaseId tagName name description isPrerelease isDraft createdAt publishedAt url author{login avatarUrl} releaseAssets(first:20){nodes{databaseId name size downloadCount url contentType}}}}}}',
    vars: { o: decodeURIComponent(m[1]), r: decodeURIComponent(m[2]), n: Math.min(n, 30) },
    pick: d => d.repository.releases.nodes.filter(Boolean).map(x => ({
      id: x.databaseId, tag_name: x.tagName, name: x.name, body: x.description || '', prerelease: !!x.isPrerelease, draft: !!x.isDraft,
      created_at: x.createdAt, published_at: x.publishedAt, html_url: x.url,
      author: x.author ? { login: x.author.login, avatar_url: x.author.avatarUrl } : null,
      assets: ((x.releaseAssets && x.releaseAssets.nodes) || []).filter(Boolean).map(a => ({ id: a.databaseId, name: a.name, size: a.size, download_count: a.downloadCount, browser_download_url: a.url, content_type: a.contentType }))
    })) };
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/commits$/.exec(base))) {
    if (qsGet(qs, 'path') || qsGet(qs, 'author') || qsGet(qs, 'since') || qsGet(qs, 'until')) return null;
    return {
      query: 'query($o:String!,$r:String!,$e:String!,$n:Int!){repository(owner:$o,name:$r){object(expression:$e){... on Commit{history(first:$n){nodes{oid message committedDate url author{name email date user{login avatarUrl}}}}}}}}',
      vars: { o: decodeURIComponent(m[1]), r: decodeURIComponent(m[2]), e: qsGet(qs, 'sha') || 'HEAD', n },
      pick: d => d.repository.object.history.nodes.filter(Boolean).map(x => ({
        sha: x.oid, html_url: x.url,
        commit: { message: x.message, author: { name: x.author ? x.author.name : '', email: x.author ? x.author.email : '', date: x.author ? x.author.date : x.committedDate }, committer: { date: x.committedDate } },
        author: x.author && x.author.user ? { login: x.author.user.login, avatar_url: x.author.user.avatarUrl } : null
      })) };
  }
  const iq = issueQ(base, qs);
  if (iq) return {
    query: 'query($q:String!,$n:Int!){search(query:$q,type:ISSUE,first:$n){nodes{__typename ... on Issue{' + GQL_ISS + '} ... on PullRequest{' + GQL_ISS + ' isDraft mergedAt headRefName baseRefName}}}}',
    vars: { q: iq + ' sort:updated-desc', n },
    pick: d => d.search.nodes.filter(x => x && x.number).map(gqlIssueToRest) };
  if (base === '/search/repositories') {
    let q = qsGet(qs, 'q'); if (!q) return null;
    const so = qsGet(qs, 'sort');
    if (so === 'stars' || so === 'forks' || so === 'updated') q += ' sort:' + so + '-' + (qsGet(qs, 'order') === 'asc' ? 'asc' : 'desc');
    return {
      query: 'query($q:String!,$n:Int!){search(query:$q,type:REPOSITORY,first:$n){repositoryCount nodes{... on Repository{' + GQL_REPO + '}}}}',
      vars: { q, n },
      pick: d => ({ total_count: d.search.repositoryCount, incomplete_results: false, items: d.search.nodes.filter(x => x && x.nameWithOwner).map(gqlRepoToRest) }) };
  }
  return null;
}

/* route 2: GraphQL - its own hourly budget */
async function gqlFallback(path) {
  if (!TOKEN || gqlActive()) return undefined;
  const plan = gqlPlan(path);
  if (!plan) return undefined;
  const res = await fetch('https://api.github.com/graphql', { method: 'POST', cache: 'no-store',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: plan.query, variables: plan.vars }) });
  budgetFromRes(res);
  usageCount('/graphql (route)', res.status);
  const rem = res.headers.get('X-RateLimit-Remaining'), rst = Number(res.headers.get('X-RateLimit-Reset') || 0) * 1000;
  if (rem === '0' && rst) gqlSet(rst + 2000);
  if (res.status === 403 || res.status === 429) { gqlSet(Date.now() + 15 * 60000); return undefined; }
  if (!res.ok) return undefined;
  const j = await res.json().catch(() => null);
  if (!j || !j.data) return undefined;
  try { return plan.pick(j.data); } catch (e) { return undefined; }
}

/* route 3: REST search - its own budget, and it can list repositories by owner */
async function searchFallback(path) {
  if (!TOKEN || SEARCH_UNTIL > Date.now()) return undefined;
  const { base, qs } = splitPath(path);
  const pg = qsGet(qs, 'page');
  if (pg && pg !== '1') return undefined;
  const n = Math.max(1, Math.min(100, Number(qsGet(qs, 'per_page')) || 30));
  let q = null, m, kind = 'repositories';
  const iq2 = issueQ(base, qs);
  if (iq2) { q = iq2; kind = 'issues'; }
  else if (base === '/user/repos' && USER && USER.login) q = 'user:' + USER.login;
  else if ((m = /^\/users\/([^\/]+)\/repos$/.exec(base))) q = 'user:' + decodeURIComponent(m[1]);
  if (!q) return undefined;
  const res = await fetch('https://api.github.com/search/' + kind + '?q=' + encodeURIComponent(q) + '&sort=updated&order=desc&per_page=' + n,
    { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  budgetFromRes(res);
  usageCount('/search (route)', res.status);
  if (res.status === 403 || res.status === 429 || res.headers.get('X-RateLimit-Remaining') === '0') SEARCH_UNTIL = Date.now() + 65000;
  if (!res.ok) return undefined;
  const j = await res.json().catch(() => null);
  return j && Array.isArray(j.items) ? j.items : undefined;
}

/* route 4: GitHub's public feeds - served by github.com, no budget at all */
async function feedFallback(path) {
  const { base, qs } = splitPath(path);
  const pg = qsGet(qs, 'page');
  if (pg && pg !== '1') return undefined;
  let m;
  if ((m = /^\/repos\/([^\/]+\/[^\/]+)\/commits$/.exec(base))) {
    if (qsGet(qs, 'path') || qsGet(qs, 'author') || qsGet(qs, 'since') || qsGet(qs, 'until')) return undefined;
    const items = await atomFeed(feedForCommits(decodeURIComponent(m[1]), qsGet(qs, 'sha') || 'HEAD'));
    return items.length ? items.map(e => {
      const sha = String(e.link || '').split('/').pop();
      return { sha, html_url: e.link, commit: { message: e.title, author: { name: e.author, date: e.updated }, committer: { date: e.updated } },
        author: e.author ? { login: e.author, avatar_url: 'https://github.com/' + encodeURIComponent(e.author) + '.png?size=64' } : null };
    }) : undefined;
  }
  if ((m = /^\/repos\/([^\/]+\/[^\/]+)\/releases$/.exec(base))) {
    const items = await atomFeed(feedForReleases(decodeURIComponent(m[1])));
    return items.length ? items.map(e => {
      const tag = decodeURIComponent(String(e.link || '').split('/releases/tag/')[1] || e.title || '');
      let h = 0; for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
      return { id: Math.abs(h), tag_name: tag, name: e.title, body: String(e.summary || '').replace(/<[^>]+>/g, ''), prerelease: false, draft: false,
        created_at: e.updated, published_at: e.updated, html_url: e.link, author: e.author ? { login: e.author } : null, assets: [] };
    }) : undefined;
  }
  return undefined;
}

/* ===================== STREAMS =====================
   A "stream" is one independent way of getting the same answer from GitHub.
   Every stream here is a documented, free GitHub surface - nothing is scraped,
   no third-party mirror is used, and no accounts are pooled:

     1. REST, signed in        api.github.com        5,000 / hour, per account
     2. GraphQL, signed in     api.github.com/graphql  its own 5,000-point budget
     3. REST search, signed in api.github.com/search   its own budget (per minute)
     4. REST, not signed in    api.github.com        60 / hour, per network (public data only)
     5. Public Atom feeds      github.com/*.atom     no API budget at all
     6. Raw file host          raw.githubusercontent.com  no API budget at all
     7. Saved on the device    last known answer, always available

   Streams 1 is tried first (its free 304 checks come first, in apiOnce); the rest
   are tried in order by routeFallback. A stream that is out of budget, or that
   failed on the network, is put to sleep for a while and skipped - then it wakes
   up by itself and is used again. A stream that simply cannot answer a given
   question (no GraphQL equivalent, say) is skipped for that question only and
   is not penalised. */
const STREAM_HEALTH = (() => { try { return LS.get('streamHealth', {}) || {}; } catch (e) { return {}; } })();
function streamSave() { try { LS.set('streamHealth', STREAM_HEALTH); } catch (e) { } }
function streamAsleep(id) { const h = STREAM_HEALTH[id]; return !!(h && h.until && h.until > Date.now()); }
function streamSleep(id, ms) {
  const h = STREAM_HEALTH[id] || (STREAM_HEALTH[id] = { fails: 0, until: 0 });
  h.until = Math.max(h.until || 0, Date.now() + ms); streamSave();
}
function streamFailed(id) {
  /* network trouble: 20s, then 1 min, 5 min, 15 min - capped, and reset on success */
  const h = STREAM_HEALTH[id] || (STREAM_HEALTH[id] = { fails: 0, until: 0 });
  h.fails = Math.min(4, (h.fails || 0) + 1);
  h.until = Date.now() + [0, 20e3, 60e3, 300e3, 900e3][h.fails]; streamSave();
}
function streamWorked(id) {
  const h = STREAM_HEALTH[id]; STREAM_LAST = id;
  if (h && (h.fails || h.until)) { h.fails = 0; h.until = 0; streamSave(); }
}
let STREAM_LAST = '';

/* stream 4: GitHub's REST API without signing in. It is a separate budget (it is
   counted per network address, not per account), so it still answers while the
   account's own budgets are spent. Public data only. */
let PUB_UNTIL = Number(LS.get('pubUntil', 0)) || 0;
const PUB_BUDGET = { limit: 60, left: null, reset: 0 };
function pubActive() { return PUB_UNTIL > Date.now(); }
function publicPathFor(path) {
  const { base, qs } = splitPath(path);
  const login = USER && USER.login ? encodeURIComponent(USER.login) : '';
  const n = Math.max(1, Math.min(100, Number(qsGet(qs, 'per_page')) || 30));
  const pg = qsGet(qs, 'page') || '1';
  if (base === '/user') return login ? '/users/' + login : null;
  if (base === '/user/repos') return login ? '/users/' + login + '/repos?sort=updated&per_page=' + n + '&page=' + pg : null;
  if (base === '/user/starred') return login ? '/users/' + login + '/starred?per_page=' + n + '&page=' + pg : null;
  if (/^\/user(\/|$)/.test(base) || /^\/notifications/.test(base) || base === '/issues' || /^\/gists(\/|$)/.test(base)) return null;
  if (/^\/(users|orgs|repos|search\/(repositories|users|topics))(\/|$)/.test(base)) {
    /* things that only make sense with a sign-in */
    if (/\/(subscription|collaborators|invitations|actions\/(secrets|variables)|keys|hooks|traffic)(\/|$)/.test(base)) return null;
    return path;
  }
  return null;
}
async function publicRestFallback(path) {
  if (pubActive() || navigator.onLine === false) return undefined;
  const p = publicPathFor(path);
  if (!p) return undefined;
  const res = await fetch('https://api.github.com' + p, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' });
  /* this budget is the network's, not the account's: it must never be written
     into the account's own meters (budgetFromRes is deliberately not used) */
  try {
    const rem = res.headers.get('X-RateLimit-Remaining'), rst = Number(res.headers.get('X-RateLimit-Reset') || 0) * 1000;
    if (rem !== null) { PUB_BUDGET.left = Number(rem); PUB_BUDGET.reset = rst; paintBudgetChip(); }
    if (rem === '0' && rst) { PUB_UNTIL = rst + 2000; LS.set('pubUntil', PUB_UNTIL); }
  } catch (e) { }
  usageCount('public:' + p, res.status);
  if (res.status === 403 || res.status === 429) {
    const ra = Number(res.headers.get('Retry-After') || 0);
    PUB_UNTIL = Math.max(PUB_UNTIL, Date.now() + (ra ? ra * 1000 : 10 * 60000)); LS.set('pubUntil', PUB_UNTIL);
    return undefined;
  }
  if (!res.ok) return undefined;          /* 404 / 401 / 410: this stream cannot see it - not a failure */
  const j = await res.json().catch(() => null);
  if (j === null || j === undefined) return undefined;
  if (path.indexOf('/user/repos') === 0 || path.indexOf('/user/starred') === 0) {
    const now = Date.now();
    if (now - (STREAM_PUBLIC_TOAST || 0) > 300000) { STREAM_PUBLIC_TOAST = now; try { toast('Showing public repositories \u2014 private ones return with your budget'); } catch (e) { } }
  }
  return j;
}
let STREAM_PUBLIC_TOAST = 0;

/* stream 6: raw.githubusercontent.com - file contents with no API budget.
   Public repositories only. Answers the REST "contents" and "readme" shapes. */
function b64FromBytes(buf) {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function rawFallback(path) {
  if (navigator.onLine === false) return undefined;
  const { base, qs } = splitPath(path);
  let m;
  const mk = async (o, n, ref, fpath) => {
    const url = 'https://raw.githubusercontent.com/' + o + '/' + n + '/' + encodeURIComponent(ref || 'HEAD').replace(/%2F/g, '/') + '/' + fpath.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null;
    const name = fpath.split('/').pop();
    return { type: 'file', name, path: fpath, sha: '', size: buf.length, encoding: 'base64', content: b64FromBytes(buf),
      download_url: url, html_url: 'https://github.com/' + o + '/' + n + '/blob/' + (ref || 'HEAD') + '/' + fpath };
  };
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/contents\/(.+)$/.exec(base))) {
    const fpath = decodeURIComponent(m[3]);
    if (/\/$/.test(fpath)) return undefined;
    return (await mk(decodeURIComponent(m[1]), decodeURIComponent(m[2]), qsGet(qs, 'ref'), fpath)) || undefined;
  }
  if ((m = /^\/repos\/([^\/]+)\/([^\/]+)\/readme$/.exec(base))) {
    for (const nm of ['README.md', 'readme.md', 'README.markdown', 'README', 'README.rst', 'README.txt']) {
      const f = await mk(decodeURIComponent(m[1]), decodeURIComponent(m[2]), qsGet(qs, 'ref'), nm).catch(() => null);
      if (f) return f;
    }
  }
  return undefined;
}

/* stream 5, extra shapes: a repository's tags from its public Atom feed */
async function tagsFeedFallback(path) {
  const { base } = splitPath(path);
  const m = /^\/repos\/([^\/]+\/[^\/]+)\/tags$/.exec(base);
  if (!m) return undefined;
  const full = decodeURIComponent(m[1]);
  const items = await atomFeed('https://github.com/' + full + '/tags.atom');
  return items.length ? items.map(e => {
    const name = decodeURIComponent(String(e.link || '').split('/releases/tag/')[1] || e.title || '');
    return { name, commit: { sha: '', url: e.link }, zipball_url: 'https://github.com/' + full + '/archive/refs/tags/' + name + '.zip',
      tarball_url: 'https://github.com/' + full + '/archive/refs/tags/' + name + '.tar.gz', node_id: '' };
  }) : undefined;
}

/* the registry, in the order they are tried */
const STREAMS = [
  { id: 'graphql', label: 'GraphQL',            token: true,  fn: gqlFallback,        own: () => gqlActive() },
  { id: 'search',  label: 'REST search',        token: true,  fn: searchFallback,     own: () => SEARCH_UNTIL > Date.now() },
  { id: 'public',  label: 'Public REST',        token: false, fn: publicRestFallback, own: () => pubActive() },
  { id: 'feed',    label: 'Public feeds',       token: false, fn: async p => (await feedFallback(p)) || (await tagsFeedFallback(p)), own: () => false },
  { id: 'raw',     label: 'Raw file host',      token: false, fn: rawFallback,        own: () => false }
];
function streamStatus(id) {
  if (id === 'rest') return rlActive() ? 'limit' : 'ok';
  const st = STREAMS.find(x => x.id === id);
  if (!st) return 'ok';
  if (st.token && !TOKEN) return 'off';
  if (st.own() ) return 'limit';
  if (streamAsleep(id)) return 'rest';
  return 'ok';
}
/* one line for the limit bar and the budget sheet: every stream and whether it is usable */
function streamsLine() {
  const mark = id => { const s = streamStatus(id); return s === 'ok' ? '\u2713' : (s === 'off' ? '\u2013' : '\u2717'); };
  return 'REST ' + mark('rest') + ' \u00b7 ' + STREAMS.map(s => s.label + ' ' + mark(s.id)).join(' \u00b7 ');
}
function streamsHTML() {
  const rows = [['rest', 'REST (signed in)', rlActive() ? 'out of requests' : (BUDGET.core ? fmtN(BUDGET.core.left) + ' left' : 'ready')]]
    .concat(STREAMS.map(s => {
      const st = streamStatus(s.id);
      let note = st === 'ok' ? 'ready' : st === 'off' ? 'needs sign-in' : st === 'rest' ? 'paused \u2014 retries soon' : 'out of requests';
      if (s.id === 'public' && PUB_BUDGET.left !== null && st === 'ok') note = PUB_BUDGET.left + ' / 60 left';
      return [s.id, s.label, note];
    }));
  return '<div class="bmsub" style="margin-top:10px"><b>Streams</b> \u2014 the app moves to the next one on its own:</div>' +
    rows.map(r => {
      const st = streamStatus(r[0]), col = st === 'ok' ? '#2ecc71' : (st === 'off' ? '#8a8a8a' : '#ff5d5d');
      return '<div class="bmsub" style="display:flex;justify-content:space-between;gap:8px"><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + col + ';margin-right:6px"></i>' + r[1] + (STREAM_LAST === r[0] ? ' <b>\u00b7 last used</b>' : '') + '</span><span>' + r[2] + '</span></div>';
    }).join('') +
    '<div class="bmsub" style="margin-top:6px">Public REST counts per network, not per account, so it can still answer when your account is out. Private data needs a signed-in stream.</div>';
}

/* is this read about public data that the free host can answer? */
function repoKnownPublic(o, n) {
  try { const r = cached('/repos/' + o + '/' + n); return !!(r && r.private === false); } catch (e) { return false; }
}
function publicFirst(path) {
  try {
    if (pubActive() || navigator.onLine === false) return false;
    if (PUB_BUDGET.left !== null && PUB_BUDGET.left <= 10) return false;     /* keep the reserve */
    if (publicPathFor(path) === null) return false;
    const { base } = splitPath(path);
    const me = USER && USER.login ? String(USER.login).toLowerCase() : '';
    let m;
    if ((m = /^\/users\/([^\/]+)(\/|$)/.exec(base))) return decodeURIComponent(m[1]).toLowerCase() !== me;
    if (/^\/search\/(repositories|users)$/.test(base)) return true;
    if ((m = /^\/repos\/([^\/]+)\/([^\/]+)(\/|$)/.exec(base))) {
      if (/^\/repos\/[^\/]+\/[^\/]+$/.test(base)) return false;            /* the repo record itself: one signed-in call tells us if it is public */
      return repoKnownPublic(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    }
  } catch (e) { }
  return false;
}
async function routeFallback(path) {
  /* shared by every caller: first stream that can answer wins */
  for (const st of STREAMS) {
    if (st.token && !TOKEN) continue;
    if (st.own() || streamAsleep(st.id)) continue;
    try {
      const v = await st.fn(path);
      if (v !== undefined && v !== null) {
        ROUTE_NOTE = st.label; streamWorked(st.id);
        try { LS.set(cacheKey(path), { d: v, at: Date.now(), etag: '', fb: 1 }); } catch (e) { }
        try { updateLimitBar(); } catch (e) { }
        return v;
      }
    } catch (e) {
      /* the stream broke (network, blocked host): rest it a little and move on to the next */
      streamFailed(st.id);
    }
  }
  return undefined;
}

const STATS_WAIT = {};
const NOTAG_TTL = 15 * 60000;
async function apiOnce(path, opts = {}) {
  /* GitHub said "still computing" for this stats endpoint a moment ago: do not ask again yet */
  if (STATS_WAIT[path]) {
    if (Date.now() < STATS_WAIT[path] && !FORCE_FRESH) return null;
    delete STATS_WAIT[path];
  }
  /* out of requests: answer from what is saved and do not call out at all */
  if (blockedFor(path)) {
    const saved0 = LS.get(cacheKey(path, opts.status), null);
    if (saved0 && (saved0.raw ? typeof saved0.d === 'string' : saved0.d !== undefined)) return saved0.d;
    const durable = LS.get(durableKey(path), undefined);
    if (durable !== undefined) return durable;
    if ((!opts.method || opts.method === 'GET') && !opts.status) {
      const alt0 = await routeFallback(path).catch(() => undefined);
      if (alt0 !== undefined) return alt0;
    }
    const err = new Error('rate limited');
    err.rateLimited = true;
    throw err;
  }
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  if (opts.accept) headers.Accept = opts.accept;
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.noAuth) { delete headers.Authorization; }
  const isGet = !opts.method || opts.method === 'GET';
  const canCache = isGet && !opts.status;
  /* ask only for what changed: replay the tag GitHub gave the saved reply */
  const savedEtag = (() => { try { const c = LS.get(cacheKey(path, opts.status), null); return c && c.etag ? c.etag : ''; } catch (e) { return ''; } })();
  if (isGet && savedEtag && (!opts.fresh || opts.etag)) headers['If-None-Match'] = savedEtag;
  /* The hour is nearly gone. A conditional request still costs nothing when
     nothing changed, so reads carry on - but anything that would certainly be
     charged, and any background work, waits for the budget to come back. */
  if (isGet && budgetLow() && path.indexOf('/search') !== 0 && (opts._bg || opts.fresh || !savedEtag)) {
    const saved2 = LS.get(cacheKey(path, opts.status), null);
    if (saved2 && (saved2.raw ? typeof saved2.d === 'string' : saved2.d !== undefined)) return saved2.d;
    if (!opts._bg && !opts.status) { const alt2 = await routeFallback(path).catch(() => undefined); if (alt2 !== undefined) return alt2; }
  }
  /* A reply saved on the device that is still current is used as-is. This is
     what keeps every screen - not just the feed - showing what it already has
     when you switch tabs or reopen the app, instead of reloading from the net. */
  if (isGet && !FORCE_FRESH && !opts.fresh && !opts._bg) {
    const c = LS.get(cacheKey(path, opts.status), null);
    if (c && (!c.fb || Date.now() - (c.at || 0) < NOTAG_TTL) && (c.raw ? typeof c.d === 'string' : c.d !== undefined)) {
      /* Hand back what is saved on the device straight away and refresh it in
         the background. A tab switch never waits on the network, and the data
         is never more than one visit out of date - no waiting period. */
      /* on/off probes (opts.status) have no tag, so every refresh of one is a paid
         request: trust the saved answer for 10 minutes unless a write marked it stale */
      if (opts.status && !c.stale && Date.now() - (c.at || 0) < 600000) return c.d;
      /* a saved reply with no tag cannot be re-checked for free: any refresh of it is a
         paid request. Keep it as-is for 15 minutes before asking again (a write marks it
         stale, and a hand refresh always goes through) */
      if (!c.etag && !c.stale && Date.now() - (c.at || 0) < NOTAG_TTL) return c.d;
      bgRefresh(path, opts);
      return c.d;
    }
  }
  /* Public data goes to the free, account-independent host first: another
     person's profile, public repositories, public search, and repositories already
     known to be public. This spends the network's own 60/hour, not the account's
     5,000 - and 10 of those 60 are kept back so it can still act as a fallback. */
  if (isGet && !opts.status && !opts._bg && !opts.noAuth && !opts.accept && !opts.text && publicFirst(path)) {
    const altP = await publicRestFallback(path).catch(() => undefined);
    if (altP !== undefined) {
      try { LS.set(cacheKey(path), { d: altP, at: Date.now(), etag: '', fb: 1 }); } catch (e) { }
      return altP;
    }
  }
  if (isGet && !opts.status && !opts._bg && !savedEtag && preferGql() && gqlPlan(path)) {
    const alt3 = await gqlFallback(path).catch(() => undefined);
    if (alt3 !== undefined) { ROUTE_NOTE = 'GraphQL (balanced)'; try { LS.set(cacheKey(path), { d: alt3, at: Date.now(), etag: '', fb: 1 }); } catch (e) { } return alt3; }
  }
  const sentToken = TOKEN;
  let res;
  try {
    res = await fetch('https://api.github.com' + path, { method: opts.method || 'GET', headers, body: opts.body || undefined, cache: 'no-store' });
    usageCount(path, res.status);
  } catch (netErr) {
    if (canCache) {
      const c = LS.get(cacheKey(path), null);
      if (c && (c.raw ? typeof c.d === 'string' : c.d !== undefined)) {
        if (Date.now() - (lastOfflineToast || 0) > 30000) { lastOfflineToast = Date.now(); try { toast('Offline — showing saved data'); } catch (e) {} }
        return c.d;
      }
    }
    throw netErr;
  }
  /* remember which scopes the current token actually has (header is present
     on classic PATs and OAuth tokens; fine-grained tokens return an empty list) */
  try { const sc = res.headers.get('X-OAuth-Scopes'); if (typeof sc === 'string') { TOKEN_SCOPES = sc; LS.set('tokenScopes', sc); } } catch (e) {}
  /* GitHub reports the budget on every reply, so the limit is known before it
     bites rather than discovered as an error */
  try {
    const rem = res.headers.get('X-RateLimit-Remaining');
    const rst = Number(res.headers.get('X-RateLimit-Reset') || 0) * 1000;
    budgetFromRes(res);
    const resrc = res.headers.get('X-RateLimit-Resource') || 'core';
    if (resrc === 'core') {
      if (rem !== null) { RL_LEFT = Number(rem); const lim = res.headers.get('X-RateLimit-Limit'); if (lim) RL_MAX = Number(lim); }
      if (rem === '0' && rst) rlSet(rst + 2000);
    } else if (resrc === 'graphql') {
      if (rem === '0' && rst) gqlSet(rst + 2000);
    } else if (resrc === 'search') {
      if (rem === '0') SEARCH_UNTIL = Date.now() + 65000;
    }
  } catch (e) {}
  /* nothing changed, and this reply was free - hand back what is saved */
  if (res.status === 304) {
    const c = LS.get(cacheKey(path, opts.status), null);
    if (c && (c.raw ? typeof c.d === 'string' : c.d !== undefined)) {
      try { LS.set(cacheKey(path, opts.status), { d: c.d, at: Date.now(), etag: c.etag, raw: c.raw }); } catch (e) { }
      return c.d;
    }
    /* no saved copy after all: fall through and ask again without the tag */
    delete headers['If-None-Match'];
    res = await fetch('https://api.github.com' + path, { method: opts.method || 'GET', headers, body: opts.body || undefined, cache: 'no-store' });
  }
  if (res.ok && String(path).split('?')[0] === '/user') BAD_401 = 0;
  if (res.status === 401) {
    /* A 401 only means "you are signed out" when the token we just used is
       still the live one. A reply that lands after an account switch, or one
       unlucky endpoint, must never throw the session away. */
    const stale = sentToken !== TOKEN || acctSwitching;
    if (!stale && sentToken) {
      let reallyBad = true;
      try {
        const chk = await fetch('https://api.github.com/user', {
          headers: { Authorization: 'Bearer ' + sentToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          cache: 'no-store'
        });
        reallyBad = chk.status === 401;
      } catch (e) { reallyBad = false; }   /* a network hiccup is not a bad token */
      /* one 401 can be a single unlucky endpoint; three in a row with no good
         /user in between means the token really is dead */
      if (reallyBad && USER && !acctSwitching && sentToken === TOKEN) {
        const now = Date.now();
        if (now - BAD_401_T > 120000) BAD_401 = 0;
        BAD_401_T = now; BAD_401++;
        if (BAD_401 >= 3) { BAD_401 = 0; doLogout('Session expired — sign in again', { keep: true }); }
      }
    }
    throw new Error('Invalid or expired token');
  }
  if (opts.status) {
    const d = await res.json().catch(() => null);
    const out = { status: res.status, ok: res.ok, data: d };
    /* save it too: these probes are what kept asking GitHub again on every
       visit even though nothing about them had changed */
    if (isGet) { try { LS.set(cacheKey(path, true), { d: out, at: Date.now(), etag: res.headers.get('ETag') || '' }); } catch (e) { } }
    return out;
  }
  if (res.status === 204) return null;
  if (opts.text) { const t = await res.text(); if (!res.ok) throw new Error('HTTP ' + res.status); if (canCache) { const k = cacheKey(path); if (API_MEM[k] !== t) { API_MEM[k] = t; try { LS.set(k, { raw: 1, d: t, at: Date.now(), etag: res.headers.get('ETag') || '' }); } catch (e) {} } } return t; }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && /rate limit|secondary rate/i.test(String((data && data.message) || ''))) {
      const rsrc = res.headers.get('X-RateLimit-Resource') || '';
      if (rsrc === 'graphql' || path.indexOf('/graphql') === 0) gqlSet(Date.now() + 15 * 60000);
      else if (rsrc === 'search' || path.indexOf('/search') === 0) SEARCH_UNTIL = Date.now() + 65000;
      else if (!rlActive()) rlSet(Date.now() + 15 * 60000);   /* no reset header: wait a quarter hour */
      if (isGet && !opts.status) { const alt1 = await routeFallback(path).catch(() => undefined); if (alt1 !== undefined) return alt1; }
      const err = new Error('rate limited');
      err.rateLimited = true;
      throw err;
    }
    let m = (data && data.message) || ('HTTP ' + res.status);
    if (data && Array.isArray(data.errors) && data.errors.length) {
      const extra = data.errors.map(x => x && x.message).filter(Boolean).join('; ');
      if (extra) m += ' — ' + extra;
    }
    throw new Error(m);
  }
  /* GraphQL reports a refusal as HTTP 200 with an errors array - a rate limit, a
     missing scope, a bad query. Reading straight past that is what made the
     Commits tab say "No commits found yet." when the truth was that GitHub had
     refused the request. Now every screen hears about it, because the check is
     here rather than repeated (and missed) at each call site. */
  if (String(path).split('?')[0] === '/graphql' && data && Array.isArray(data.errors) && data.errors.length) {
    const gmsg = data.errors.map(x => (x && x.message) || '').filter(Boolean).join('; ') || 'GitHub refused that request';
    if (/rate limit|secondary rate/i.test(gmsg)) {
      gqlSet(Date.now() + 15 * 60000);          /* GraphQL keeps its own budget */
      const gerr = new Error(gmsg);
      gerr.rateLimited = true;
      throw gerr;
    }
    throw new Error(gmsg);
  }
  /* A write used to wipe every saved reply, so the moment the API ran out there
     was nothing left to show on any screen - that is what turned a limit into a
     dead app. Now a write only marks the replies stale: each one is revalidated
     for free next time it is asked for, and until then the app can still show
     it. Nothing is thrown away. */
  /* GraphQL is POST-only, but almost all of it is reading (Commits tab, Productivity,
     profile days). Those change nothing on GitHub, so they must not drop a single
     saved tag. The one real mutation (the pull-request draft toggle) drops what it
     can change itself, in toggleDraft. */
  if (!isGet && res.ok && String(path).split('?')[0] !== '/graphql') {
    try { staleApiCache(path); } catch (e) { }
    /* a commit made from the app: the Commits tab may show it on its next open */
    if (/\/(contents|git\/(commits|refs))(\/|$)/.test(path)) { try { LS.del(gqlFreshKey('c.allcomm')); } catch (e) { } }
  }
  /* a 202 on a stats endpoint means "still computing": remember it for a while so
     reopening the screen does not pay for the same empty answer again */
  if (isGet && res.status === 202 && path.indexOf('/stats/') > -1) STATS_WAIT[path] = Date.now() + 90000;
  if (canCache && data !== null && data !== undefined) {
    const k = cacheKey(path), s = JSON.stringify(data);
    if (API_MEM[k] !== s) {
      API_MEM[k] = s;
      try { LS.set(k, { d: data, at: Date.now(), etag: res.headers.get('ETag') || '' }); pruneCache(700); } catch (e) { }
      /* a second copy under 'offline.' - neither 'c:' nor 'c.' - so the lists a
         screen is built from survive any cache clearing at all */
      if (cacheIsKept(path)) { try { LS.set(durableKey(path), data); } catch (e) { } }
    }
  }
  return data;
}

/* ================= GitHub's own feeds =================
   Everything here is served by github.com, not api.github.com. It is the same
   syndication a feed reader uses, so it carries no API rate limit at all. When
   the API is unavailable this is what keeps the app showing live data instead
   of a message about being out of requests. */
function parseAtom(xml) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const entries = doc.querySelectorAll('entry');
    entries.forEach(en => {
      const txt = sel => { const n = en.querySelector(sel); return n ? (n.textContent || '').trim() : ''; };
      let link = '';
      const l = en.querySelector('link');
      if (l) link = l.getAttribute('href') || '';
      out.push({ title: txt('title'), updated: txt('updated'), link,
        author: txt('author > name'), summary: txt('content') || txt('summary') });
    });
  } catch (e) { }
  return out;
}
async function atomFeed(url) {
  /* github.com sends no CORS headers, so the page cannot read its feeds on its
     own. The device is not bound by that, so it fetches them - and only from
     github.com. In a plain browser this falls back to a direct request. */
  try {
    if (window.OneGit && window.OneGit.fetchText) {
      const body = await window.OneGit.fetchText(url);
      if (body) { const items = parseAtom(body); if (items.length) return items; }
    }
  } catch (e) { }
  const r = await fetch(url, { headers: { Accept: 'application/atom+xml, application/xml, text/xml' }, cache: 'no-store' });
  if (!r.ok) throw new Error('feed ' + r.status);
  return parseAtom(await r.text());
}
/* the feed for a person, a repository's commits, or its releases */
function feedForUser(login) { return 'https://github.com/' + login + '.atom'; }
function feedForCommits(full, branch) { return 'https://github.com/' + full + '/commits/' + (branch || 'HEAD') + '.atom'; }
function feedForReleases(full) { return 'https://github.com/' + full + '/releases.atom'; }

/* ================= actions are never lost =================
   If GitHub cannot be reached - out of budget, or no connection - an action is
   kept and replayed rather than refused. The app does not tell the user "no";
   it tells them it will go through. */
function pendingActions() { try { return LS.get('queue', []) || []; } catch (e) { return []; } }
function queueAction(path, method, body, label) {
  try {
    const q = pendingActions();
    q.push({ path, method, body, label: label || '', at: Date.now() });
    LS.set('queue', q.slice(-50));
    updateQueueBadge();
    toast((label || 'Action') + ' saved \u2014 it will go through when GitHub is reachable');
    return true;
  } catch (e) { return false; }
}
function updateQueueBadge() {
  try {
    const n = pendingActions().length;
    document.body.classList.toggle('has-queue', n > 0);
    const b = document.getElementById('queueBadge');
    if (b) { b.textContent = n ? (n + ' waiting') : ''; b.hidden = !n; }
  } catch (e) { }
}
async function flushQueue() {
  const q = pendingActions();
  if (!q.length || rlActive()) return;
  if (navigator.onLine === false) return;
  const left = [];
  let sent = 0;
  for (const r of q) {
    try { await apiOnce(r.path, { method: r.method, body: r.body }); sent++; }
    catch (e) {
      if (e && (e.rateLimited || /rate limit|Failed to fetch|NetworkError|load failed/i.test(e.message || ''))) left.push(r);
      /* anything else was a real rejection - it must not be replayed forever */
    }
  }
  LS.set('queue', left);
  updateQueueBadge();
  if (sent) { toast('Sent ' + sent + ' saved action' + (sent === 1 ? '' : 's')); }
}
/* one helper for a write that should never be lost */
async function writeOrQueue(path, method, body, label) {
  try { return await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) {
    const soft = e && (e.rateLimited || /rate limit|Failed to fetch|NetworkError|load failed/i.test(e.message || ''));
    if (soft && queueAction(path, method, body === undefined ? undefined : JSON.stringify(body), label)) return null;
    throw e;
  }
}

/* says, plainly, where the activity on screen came from */
function feedNoteHTML() {
  return '<div class="card feednote"><b>Live from GitHub\u2019s public feed</b>' +
    '<span>This hour\u2019s API requests are used up, so Gitly is reading the same feed a feed reader would. ' +
    'It keeps working \u2014 nothing is missing, and it switches back by itself.</span></div>';
}

/* instant cache read for paint-first rendering */
/* ---------- "new" animation ----------
   A refresh should never blank the page (that is what the spinner felt like).
   Instead we remember what a list has already shown and animate only the rows
   that are genuinely new, so the user can see what actually arrived. */
const SEEN_IDS = {};
function newness(key, ids) {
  const prev = SEEN_IDS[key];
  SEEN_IDS[key] = new Set((ids || []).map(String));
  if (!prev) return function () { return false; };
  return function (id) { return !prev.has(String(id)); };
}
/* A live list: when new data arrives we insert ONLY the new rows at the top and
   let them slide down over the ones already on screen. Nothing is redrawn, so a
   refresh never looks like a page reload. */
let LIVE_REFRESH = null;
/* True while a refresh is in flight. While it is set, a render that has to
   happen anyway plays the refresh animation instead of the page entrance,
   so a refresh never looks like a reload. */
let REFRESHING = false;
/* The entrance animation belongs to a screen you have just OPENED. A list that
   is rebuilt in place - a refresh, or a tab you come back to - must not animate
   its rows all over again, so the animation is switched on only for the render
   that follows opening a screen, and off again a moment later. */
let ENTER_T = 0;
/* Switching account redraws the same screen with different data. Running the
   entrance animation for that made the whole page fade out and back in - which
   looked like the screen breaking every time the account button was tapped. */
let SKIP_ENTER = false;
function enterView() {
  try {
    document.body.classList.add('entering');
    clearTimeout(ENTER_T);
    ENTER_T = setTimeout(() => { try { document.body.classList.remove('entering'); } catch (e) { } }, 1100);
  } catch (e) { }
}
function beginRefresh() {
  REFRESHING = true;
  try { document.body.classList.add('refreshing'); } catch (e) { }
}
/* Freezes the entrance animation of everything currently on screen, so that
   dropping the refresh state cannot make the page animate itself again. */
/* Freezes the entrance animation of the rows inside one container. */
function settleRows(root) {
  try {
    if (!root) return;
    Array.prototype.slice.call(root.querySelectorAll('.lrow')).forEach(n => {
      if (!n.classList.contains('new-in') && !n.classList.contains('slide-top')) n.classList.add('settled');
    });
  } catch (e) { }
}
function settleView() {
  try {
    const v = document.getElementById('view'); if (!v) return;
    Array.prototype.slice.call(v.children).forEach(n => n.classList.add('settled'));
    Array.prototype.slice.call(v.querySelectorAll('.lrow')).forEach(n => {
      if (!n.classList.contains('new-in') && !n.classList.contains('slide-top')) n.classList.add('settled');
    });
  } catch (e) { }
}
function endRefresh() {
  REFRESHING = false;
  setTimeout(() => {
    if (REFRESHING) return;
    /* freeze FIRST, then drop the state - the other order replays the page
       entrance animation on everything that is already on screen */
    settleView();
    try { document.body.classList.remove('refreshing'); } catch (e) { }
  }, 900);
}
const evKey = ev => String(ev.id || (ev.type + '|' + (ev.created_at || '')));
function attachSlideCleanup(n) {
  const onEnd = ev => {
    if (ev.animationName === 'slideTop') { n.classList.remove('slide-top'); n.classList.add('settled'); n.removeEventListener('animationend', onEnd); }
  };
  n.addEventListener('animationend', onEnd);
}
/* Generic in-place refresh, used by every screen that has not opted into its own
   live refresh. It re-runs the current route but keeps the rows that were
   already on screen (the very same DOM nodes) and slides in only the new ones -
   so no page reload look, anywhere in the app. */
async function refreshInPlace() {
  const sc = document.getElementById('scroller');
  const scroll = sc ? sc.scrollTop : 0;
  const oldList = document.querySelector('#view .card.list');
  const oldNodes = new Map();
  if (oldList) {
    Array.prototype.slice.call(oldList.querySelectorAll('.lrow')).forEach(n => {
      const k = rowKey(n);
      if (k && !oldNodes.has(k)) oldNodes.set(k, n);
    });
  }
  await route();
  try {
    const newList = document.querySelector('#view .card.list');
    if (newList && oldNodes.size) {
      const seen = new Set(), keep = [];
      Array.prototype.slice.call(newList.querySelectorAll('.lrow')).forEach(n => {
        const k = rowKey(n);
        if (!k || seen.has(k)) return;
        seen.add(k);
        const old = oldNodes.get(k);
        if (old) { keep.push(old); oldNodes.delete(k); }
        else { n.classList.add('slide-top'); attachSlideCleanup(n); keep.push(n); }
      });
      /* the fresh list can come back empty while its request is still in
         flight - keep the rows we already had so nothing blanks out */
      if (!keep.length && oldList) {
        Array.prototype.slice.call(oldList.querySelectorAll('.lrow')).forEach(n => keep.push(n));
      }
      if (keep.length) { newList.innerHTML = ''; keep.forEach(n => newList.appendChild(n)); }
    }
  } catch (e) { }
  try { if (sc) sc.scrollTop = scroll; } catch (e) { }
}
/* Register an in-place refresh for a list screen: re-fetch and slide new rows
   in. The page is never re-rendered, so a refresh never looks like a reload. */
function liveList(listSel, fetchItems, keyFn, rowFn, cap, key) {
  LIVE_REFRESH = async () => {
    try {
      const items = await fetchItems();
      if (!Array.isArray(items)) return;
      const list = document.querySelector(listSel);
      if (!list) { route(); return; }
      prependNewRows(list, items, keyFn, rowFn, cap || 0, key);
    } catch (e) { }
  };
}
function seedLive(key, ids) { try { newness(key + ':live', (ids || []).map(String)); } catch (e) { } }
function prependNewRows(list, items, keyFn, rowFn, cap, key) {
  if (!list) return 0;
  const seenKey = key || 'live';
  /* Build the rows we want, then lay the list out in the order they were given.
     Rows that are already on screen keep their own node, so nothing that is
     already there moves or animates - and only the rows that are genuinely new
     slide in.
     (The old version prepended every row it did not recognise, on the
     assumption that they were newer. When a reply came back partial, or from
     the offline copy, those rows were OLDER - so they were pushed in above the
     newest ones, and the cap then trimmed the newest rows off the bottom.) */
  const holder = document.createElement('div');
  holder.innerHTML = (items || []).map(rowFn).join('');
  let want = Array.prototype.slice.call(holder.children);
  if (cap) want = want.slice(0, cap);            /* keep the newest `cap` rows */
  const onScreen = new Map();
  Array.prototype.slice.call(list.querySelectorAll('.lrow')).forEach(n => {
    const k = rowKey(n);
    if (k && !onScreen.has(k)) onScreen.set(k, n);
  });
  const out = [], fresh = [];
  want.forEach(n => {
    const k = rowKey(n);
    const old = k ? onScreen.get(k) : null;
    if (old) { onScreen.delete(k); out.push(old); }
    else { out.push(n); fresh.push(n); }
  });
  const now = Array.prototype.slice.call(list.querySelectorAll('.lrow'));
  const unchanged = now.length === out.length && now.every((n, i) => n === out[i]);
  if (!unchanged) {
    if (fresh.length) {
      /* clip the incoming rows against the card's top edge while they slide */
      list.classList.add('slide-anim');
      clearTimeout(prependNewRows._t);
      prependNewRows._t = setTimeout(() => list.classList.remove('slide-anim'), 700);
      fresh.forEach(n => {
        n.classList.remove('new-in');   /* never let two arrival animations fight over one row */
        n.classList.add('slide-top');
        const onEnd = ev => {
          if (ev.animationName === 'slideTop') { n.classList.remove('slide-top'); n.classList.add('settled'); n.removeEventListener('animationend', onEnd); }
        };
        n.addEventListener('animationend', onEnd);
        setTimeout(() => { try { n.classList.remove('slide-top'); n.classList.add('settled'); } catch (e) { } }, 900);   /* safety net */
      });
    }
    list.innerHTML = '';
    out.forEach(n => {
      if (fresh.indexOf(n) < 0) { n.classList.remove('new-in'); n.classList.add('settled'); }
      list.appendChild(n);
    });
  }
  try { newness(seenKey, out.map(rowKey)); } catch (e) { }
  return fresh.length;
}
function rowKey(row) {
  return row.dataset.id || row.dataset.go || row.dataset.full ||
    (row.dataset.swacc ? 'acc:' + row.dataset.swacc : '') ||
    (row.textContent || '').trim().slice(0, 80);
}
/* adds .new-in to the rows of a freshly painted list that were not there before */
function markNewRows(container, key) {
  try {
    if (!container) return;
    const rows = Array.prototype.slice.call(container.querySelectorAll('.lrow'));
    if (!rows.length) return;
    const ids = rows.map(rowKey);
    const isNew = newness(key, ids);
    rows.forEach((row, i) => {
      if (!isNew(ids[i])) return;
      row.classList.add('new-in');
      /* once its arrival animation is done the row is frozen, so re-inserting
         it later can never replay the animation */
      const done = ev => {
        if (ev.animationName === 'newIn') { row.classList.add('settled'); row.removeEventListener('animationend', done); }
      };
      row.addEventListener('animationend', done);
    });
  } catch (e) { }
}
/* a slim progress pulse across the top instead of a page-blanking spinner */
/* the old top loading bar is gone - refreshing is now shown by the rows
   themselves sliding in */
function refreshPulse() { }
function cached(path) {
  /* A refresh the user asked for must never be answered from the saved copy.
     Screens read this directly to paint instantly, which is right on a normal
     open - but it also meant the pull-to-refresh changed nothing at all. */
  if (FORCE_FRESH) return undefined;
  try { const c = LS.get(cacheKey(path), null); if (c && (c.raw ? typeof c.d === 'string' : c.d !== undefined)) return c.d; } catch (e) { }
  return undefined;
}

/* ================= theme (mode + accent + glow) ================= */
function shadeHex(hex, f) {
  const p = i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) * (1 + f))));
  return '#' + [p(0), p(1), p(2)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function applyTheme() {
  const t = LS.get('theme', 'light');
  document.body.classList.remove('dark', 'pitch');
  if (t === 'dark') document.body.classList.add('dark');
  else if (t === 'pitch') document.body.classList.add('pitch');
  const rt = document.documentElement;
  document.body.classList.toggle('navglow', !!LS.get('navglow', false));
  document.body.classList.toggle('compact', !!LS.get('compact', false));
  const acc = LS.get('accent', 'blue');
  rt.dataset.accent = acc;
  rt.dataset.glow = LS.get('glow', true) ? 'on' : 'off';
  rt.style.removeProperty('--accent');
  rt.style.removeProperty('--accentD');
  rt.style.removeProperty('--glow');
  if (acc === 'dynamic' || acc === 'custom') {
    let hex = '';
    if (acc === 'dynamic') {
      try { if (window.OneGit && window.OneGit.systemAccent) hex = window.OneGit.systemAccent() || ''; } catch (e) {}
    } else {
      hex = (LS.get('customAccent', '') || '').toUpperCase();
    }
    if (/^#[0-9A-F]{6}$/.test(hex)) {
      rt.style.setProperty('--accent', hex.toUpperCase());
      rt.style.setProperty('--accentD', shadeHex(hex.toUpperCase(), -0.25));
      rt.style.setProperty('--glow', hex.toUpperCase() + '6B');
    }
  }
  try {
    if (window.OneGit && window.OneGit.theme) {
      window.OneGit.theme(t === 'light' ? '#F2F2F2' : (t === 'dark' ? '#161719' : '#000000'), t === 'light');
    }
  } catch (e) {}
  let accHex = '';
  try { accHex = getComputedStyle(rt).getPropertyValue('--accent').trim(); } catch (e) {}
  if (/^#[0-9A-Fa-f]{6}$/.test(accHex)) {
    /* keep the home screen widgets in the same colour as the app */
    try { if (window.OneGit && OneGit.widgetAccent) OneGit.widgetAccent(accHex.toUpperCase()); } catch (e) {}
    const ch = v => { const c = parseInt(v, 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * ch(accHex.slice(1, 3)) + 0.7152 * ch(accHex.slice(3, 5)) + 0.0722 * ch(accHex.slice(5, 7));
    rt.style.setProperty('--accentText', L > 0.45 ? '#151515' : '#fff');
  } else {
    rt.style.setProperty('--accentText', '#fff');
  }
}

/* ---------- auto-adjust to the device's aspect ratio ----------
   Fits the layout to the shape of the screen: a tall phone gets more vertical
   breathing room and a taller bar for reach, a short or wide screen gets tighter
   spacing so nothing looks stretched or cramped. */
function applyAutoAdjust() {
  try {
    const b = document.body;
    b.classList.remove('autoadjust', 'ar-tall', 'ar-mid', 'ar-wide', 'ar-land');
    if (!LS.get('autoadjust', true)) return;
    b.classList.add('autoadjust');
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    const ratio = h / w;
    if (h < w) b.classList.add('ar-land');
    else if (ratio >= 2.05) b.classList.add('ar-tall');
    else if (ratio <= 1.6) b.classList.add('ar-wide');
    else b.classList.add('ar-mid');
  } catch (e) { }
}
window.addEventListener('resize', applyAutoAdjust);
window.addEventListener('orientationchange', () => setTimeout(applyAutoAdjust, 250));

/* ================= font (bundled app font everywhere) ================= */
function applyFont() { document.body.style.fontFamily = "'OneGitSans', system-ui, sans-serif"; }

/* ================= pins ================= */
function isPinned(full) { return pins.some(p => p.full_name === full); }
function togglePin(r) {
  const full = r.full_name || ((r.owner ? r.owner.login + '/' : '') + r.name);
  if (isPinned(full)) { pins = pins.filter(p => p.full_name !== full); toast('Unpinned ' + r.name); }
  else {
    pins.push({ full_name: full, name: r.name, description: r.description, html_url: r.html_url, stargazers_count: r.stargazers_count, forks_count: r.forks_count, language: r.language });
    toast('Pinned ' + r.name);
  }
  LS.set('pins', pins); queueSync();
  $$('[data-pinbtn]').forEach(b => {
    if (b.dataset.pinbtn === full) {
      b.classList.toggle('pinned', isPinned(full));
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    }
  });
}

/* ================= sync (private Gist) ================= */
function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncPush(true), 1500); }
async function syncPush(silent) {
  if (!TOKEN) return;
  const payload = { app: 'onegit', version: 1, updated_at: new Date().toISOString(), pins, theme: LS.get('theme', 'light'), accent: LS.get('accent', 'blue'), customAccent: LS.get('customAccent', ''), glow: LS.get('glow', true), navglow: LS.get('navglow', false), autodl: LS.get('autodl', false), autoinstall: LS.get('autoinstall', true), font: LS.get('font', 'system'), notify: LS.get('notify', true), liveNotif: LS.get('liveNotif', true) };
  try {
    /* identical settings need no write: a gist write is always a paid request, so
       compare everything except the timestamp with what was last sent */
    const sig = (() => { const c = Object.assign({}, payload); delete c.updated_at; return JSON.stringify(c); })();
    if (gistId && LS.get('syncSig.' + gistId, '') === sig) { if (!silent) toast('Already synced'); return; }
    const files = { 'onegit-sync.json': { content: JSON.stringify(payload, null, 2) } };
    if (!gistId) {
      const g = await api('/gists', { method: 'POST', body: JSON.stringify({ description: 'Gitly sync file (auto-generated) — do not delete', public: false, files }) });
      gistId = g.id; LS.set('gistId', gistId); saveGistToAccount();
    } else {
      await api('/gists/' + gistId, { method: 'PATCH', body: JSON.stringify({ files }) });
    }
    try { LS.set('syncSig.' + gistId, sig); } catch (e) { }
    if (!silent) toast('Synced to your private Gist');
  } catch (e) { if (!silent) toast('Sync failed: ' + e.message); }
}
async function syncRestore(silent) {
  if (!TOKEN) return false;
  try {
    let g = null;
    if (gistId) { try { g = await api('/gists/' + gistId); } catch (e) {} }
    if (!g) {
      const list = await api('/gists?per_page=100');
      g = list.find(x => x.files && x.files['onegit-sync.json']);
      if (g) { gistId = g.id; LS.set('gistId', gistId); saveGistToAccount(); }
    }
    if (!g || !g.files['onegit-sync.json']) { if (!silent) toast('No sync data found on GitHub'); return false; }
    const d = JSON.parse(g.files['onegit-sync.json'].content);
    if (Array.isArray(d.pins)) { pins = d.pins; LS.set('pins', pins); }
    if (d.theme) { LS.set('theme', d.theme); applyTheme(); }
    if (d.accent) { LS.set('accent', d.accent); applyTheme(); }
    if (d.customAccent) { LS.set('customAccent', d.customAccent); applyTheme(); }
    if (d.font) { LS.set('font', 'default'); applyFont(); }
    if (typeof d.glow === 'boolean') { LS.set('glow', d.glow); applyTheme(); }
    if (typeof d.navglow === 'boolean') { LS.set('navglow', d.navglow); applyTheme(); }
    if (typeof d.notify === 'boolean') LS.set('notify', d.notify);
    if (typeof d.liveNotif === 'boolean') LS.set('liveNotif', d.liveNotif);
    if (typeof d.autodl === 'boolean') LS.set('autodl', d.autodl);
    if (typeof d.autoinstall === 'boolean') LS.set('autoinstall', d.autoinstall);
    if (!silent) toast('Restored from your private Gist');
    return true;
  } catch (e) { if (!silent) toast('Restore failed: ' + e.message); return false; }
}

/* ================= app update (GitHub releases) ================= */
let UPD_CHECKED = false;
function newerVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.'), pb = String(b).replace(/^v/, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || 0, 10), y = parseInt(pb[i] || 0, 10);
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
function showUpdateCard(rel) {
  if (document.getElementById('updCard')) return;
  const label = (rel && (rel.name || rel.tag_name)) || 'new release';
  const asset = ((rel && rel.assets) || []).find(a => /\.apk$/i.test(a.name || ''));
  const el = document.createElement('div');
  el.id = 'updCard';
  el.innerHTML = '<div class="updrow"><div class="lmain"><div class="ltitle">Update available \u00b7 ' + esc(label) + '</div>' +
    '<div class="lsub">a new Gitly release is on GitHub</div></div>' +
    '<button class="btn sm primary" id="updGet">Update</button>' +
    '<button class="iconbtn" id="updX" aria-label="dismiss">\u2715</button></div>';
  document.body.appendChild(el);
  const kill = () => { try { el.remove(); } catch (e) {} };
  setTimeout(kill, 20000);
  $('#updGet').addEventListener('click', () => {
    if (!startUpdate(asset, rel, true)) location.href = 'https://github.com/' + UPD_REPO + '/releases/latest';
    kill();
  });
  $('#updX').addEventListener('click', kill);
}
/* the newest published (non-draft) release on the OneGit repo -
   independent of GitHub's "Latest" marker, so every release you post counts */
async function latestPublishedRelease() {
  const list = await api('/repos/' + UPD_REPO + '/releases?per_page=30', { accept: 'application/vnd.github.html+json' });
  if (!Array.isArray(list)) return null;
  const pub = list.filter(r => r && r.id && !r.draft && r.published_at);
  pub.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return pub.length ? pub[0] : null;
}
/* the release's "Describe this release" text, shown as a sheet */
function showChangelogSheet(rel) {
  const label = (rel && (rel.name || rel.tag_name)) || 'latest release';
  const body = rel && rel.body_html ? fixMd(rel.body_html)
    : (rel && rel.body ? esc(rel.body).replace(/\n/g, '<br>') : '<p class="dim">No description in this release.</p>');
  openSheet('<div class="sheethead"><b>ChangeLog — ' + esc(label) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="card md">' + body + '</div>');
  try { const sc = document.querySelector('#sheet .sheetcard'); if (sc) inlineRepoImages(sc); } catch (e) {}
}
async function checkUpdate() {
  if (UPD_CHECKED || !TOKEN) return;
  UPD_CHECKED = true;
  try {
    const rel = await latestPublishedRelease();
    if (!rel || !rel.id) return;
    const published = Date.parse(rel.published_at || '') || 0;
    const tagv = releaseVersion(rel);
    // update when the release's tag version is newer than this app's version,
    // or when the release was published after this install
    const versionNewer = !!tagv && newerVersion(tagv, APPV);
    const dateNewer = !!(published && INSTALLED_AT && published > INSTALLED_AT);
    if (!versionNewer && !dateNewer) return;
    const key = 'rel' + rel.id;
    const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name || ''));
    if (LS.get('autodl', false) && asset && LS.get('updDl', '') !== key) {
      LS.set('updDl', key);
      startUpdate(asset, rel, false);
    }
    if (LS.get('updShown', '') !== key) {
      LS.set('updShown', key);
      showUpdateCard(rel);
    }
  } catch (e) {}
}

/* Starts an update: download the APK and hand it to the Android installer.
   An automatic update should finish, not stop at "downloaded" - so unless the
   user turned automatic installing off, the installer opens by itself.
   `force` is used when the user taps Update themselves. */
function startUpdate(asset, rel, force) {
  if (!asset || !asset.browser_download_url) return false;
  const install = force || LS.get('autoinstall', true);
  const name = asset.name || 'gitly-update.apk';
  try {
    if (install && window.OneGit && window.OneGit.downloadAndInstall) {
      window.OneGit.downloadAndInstall(asset.browser_download_url, name);
      toast('Downloading update \u2014 the installer will open');
      return true;
    }
    if (window.OneGit && window.OneGit.download) {
      window.OneGit.download(asset.browser_download_url, name);
      toast('Downloading ' + ((rel && (rel.name || rel.tag_name)) || 'update'));
      return true;
    }
  } catch (e) { }
  return false;
}

/* The notification style is a device preference, but the card is built natively
   (it has to survive the app being closed), so the choice is pushed across. */
function pushLiveNotif() {
  try {
    if (window.OneGit && window.OneGit.setLiveNotifications) {
      window.OneGit.setLiveNotifications(LS.get('liveNotif', true));
    }
  } catch (e) { }
}

/* ================= auth ================= */
function doLogout(msg, opts) {
  opts = opts || {};
  /* an expired token keeps its account, so signing in again replaces the token
     instead of losing the account from the list */
  const keepAccount = !!opts.keep;
  let next = null;
  if (USER && USER.login && !keepAccount) {
    const accs = getAccounts().filter(a => a.login !== USER.login);
    saveAccounts(accs);
    next = accs.length ? accs[0] : null;
  }
  if (next) { toast(msg || ('Signed out — switched to ' + next.login)); switchAccount(next.login); return; }
  TOKEN = null; USER = null; LS.del('token');
  dropInflight();
  try { if (window.OneGit && window.OneGit.saveToken) window.OneGit.saveToken(''); } catch (e) {}
  try { _acctPayload = ''; saveTokenNative(); } catch (e) {}
  if (msg) toast(msg); showLogin();
}
/* Also hands the account list to the native side, so a home screen widget can
   be pinned to one of them when it is added (WidgetConfigActivity). */
let _acctPayload = '';
function saveTokenNative() {
  try { if (TOKEN && window.OneGit && window.OneGit.saveToken) window.OneGit.saveToken(TOKEN); } catch (e) {}
  try {
    if (window.OneGit && window.OneGit.saveAccounts) {
      const list = (getAccounts() || []).filter(a => a && a.login && a.token)
        .map(a => ({ login: a.login, token: a.token, avatar: a.avatar || '' }));
      const payload = JSON.stringify({ active: (USER && USER.login) || '', accounts: list });
      if (payload !== _acctPayload) { _acctPayload = payload; window.OneGit.saveAccounts(payload); }
    }
  } catch (e) {}
}
/* The account list is also kept on the device itself. If the page's own storage
   has been cleared - a full phone will do it - the accounts are rebuilt from
   there instead of the user signing every one in again. */
function restoreAccountsFromDevice() {
  try {
    if (getAccounts().filter(a => a && a.login && a.token).length) return;
    if (!window.OneGit || !window.OneGit.accounts) return;
    const raw = window.OneGit.accounts();
    if (!raw) return;
    const p = JSON.parse(raw);
    const list = (p.accounts || []).filter(a => a && a.login && a.token)
      .map(a => ({ login: a.login, token: a.token, avatar: a.avatar || '', gistId: null, pins: null }));
    if (!list.length) return;
    saveAccounts(list);
    if (p.active) { LS.set('cur', String(p.active).toLowerCase()); ACCT = String(p.active).toLowerCase(); }
    /* Bring the SESSION back as well, not just the list. Before this the
       accounts were restored and then the app still showed the sign-in screen,
       because the token had already been read (and found empty) long before -
       which looked exactly like the accounts had not been saved at all. */
    const act = list.find(a => String(a.login).toLowerCase() === ACCT) || list[0];
    if (act && act.token) {
      TOKEN = act.token;
      LS.set('token', TOKEN);
      ACCT = String(act.login).toLowerCase();
      LS.set('cur', ACCT);
      if (!USER) USER = { login: act.login, avatar_url: act.avatar || '' };
    }
  } catch (e) { }
}

function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  const lv = $('#loginVer');
  if (lv) lv.textContent = 'Gitly v' + APPV;
  let cb = document.getElementById('loginCancel');
  if (!cb) {
    cb = document.createElement('button');
    cb.id = 'loginCancel';
    cb.className = 'btn ghost';
    cb.style.cssText = 'display:block;margin:18px auto 0;width:180px';
    cb.textContent = 'Cancel';
    cb.addEventListener('click', () => { $('#login').hidden = true; $('#app').hidden = false; route(); });
    const card = document.querySelector('#login .logincard');
    if (card) card.appendChild(cb);
  }
  /* resume a pending GitHub device sign-in */
  let fb = document.getElementById('oauthFinish');
  const pend = oauthPending();
  if (pend) {
    if (!fb) {
      fb = document.createElement('button');
      fb.id = 'oauthFinish';
      fb.className = 'btn ghost';
      fb.style.cssText = 'display:block;margin:14px auto 0;width:260px';
      fb.addEventListener('click', () => { showDeviceSheet(); oauthPollNow(); });
      const lc = document.querySelector('#login .logincard');
      if (lc && lc.parentNode) lc.parentNode.insertBefore(fb, lc.nextSibling);
    }
    fb.textContent = 'Continue — finish GitHub sign-in';
    fb.hidden = false;
    if (!oauthTimer) scheduleOauthPoll();
  } else if (fb) fb.hidden = true;
  cb.hidden = !TOKEN;
}

/* ================= accounts (multi-account) ================= */
function getAccounts() { return LS.get('accounts', []); }
/* Keeps the account list honest: drops records that can never be switched to
   (no token) and makes sure the account we are actually signed in as is in the
   list and holds the live token. Fixes a list that has drifted out of step with
   the session - which showed as "no account is active" and a switch that signed
   you out. */
function reconcileAccounts() {
  let accs = getAccounts().filter(a => a && a.login);
  let changed = false;
  const cleaned = accs.filter(a => a.token);
  if (cleaned.length !== accs.length) { accs = cleaned; changed = true; }
  /* one record per token - two logins sharing a token is what the old sign-in
     bug produced, and it made the switch button appear to do nothing */
  { const seen = {}, uniq = [];
    accs.forEach(a => { if (seen[a.token]) return; seen[a.token] = 1; uniq.push(a); });
    if (uniq.length !== accs.length) { accs = uniq; changed = true; } }
  if (TOKEN && USER && USER.login) {
    const lg = String(USER.login).toLowerCase();
    if (!accs.some(a => a.token === TOKEN)) {
      const byLogin = accs.find(a => String(a.login).toLowerCase() === lg);
      if (byLogin) { byLogin.token = TOKEN; byLogin.login = USER.login; if (!byLogin.avatar && USER.avatar_url) byLogin.avatar = USER.avatar_url; changed = true; }
      else { accs.push({ login: USER.login, token: TOKEN, avatar: USER.avatar_url || '', gistId: gistId || null, pins: pins || [] }); changed = true; }
    }
  }
  if (changed) saveAccounts(accs);
  return accs;
}
function saveAccounts(a) { LS.set('accounts', a); }
function addAccount(login, token, avatar) {
  const accs = getAccounts();
  const i = accs.findIndex(a => a.login === login);
  const rec = { login, token, avatar: avatar || '', gistId: i >= 0 ? accs[i].gistId : null, pins: i >= 0 ? accs[i].pins : null };
  if (i >= 0) accs[i] = rec; else accs.push(rec);
  saveAccounts(accs);
  return rec;
}
function saveGistToAccount() {
  if (!USER) return;
  const accs = getAccounts();
  const i = accs.findIndex(a => a.login === USER.login);
  if (i >= 0) { accs[i].gistId = gistId; accs[i].pins = pins; if (!accs[i].avatar && USER.avatar_url) accs[i].avatar = USER.avatar_url; saveAccounts(accs); }
}
function accountCachesClear() {
  try {
    Object.keys(localStorage)
      .filter(k => k.indexOf('onegit.c.') === 0)
      /* the saved activity is the app's offline data - it must survive an
         account switch (this sweep used to delete it, which is why the feed
         reloaded from the network every time) */
      .filter(k => k.indexOf('onegit.c.hist') !== 0 && k.indexOf('onegit.c.feed') !== 0)
      .forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
  } catch (e) { }
}
async function switchAccount(login) {
  const accs = getAccounts();
  const want = String(login || '').toLowerCase();
  const acc = accs.find(a => String(a.login || '').toLowerCase() === want);
  if (!acc) return;
  if (acc.token === TOKEN) {
    /* Same token, different login: the saved list has drifted. Follow the
       account the user actually picked instead of silently re-drawing the
       current one - that is what made the switch look broken. */
    if (String(acc.login).toLowerCase() !== String((USER && USER.login) || '').toLowerCase()) {
      USER = { login: acc.login, avatar_url: acc.avatar || '' };
      ACCT = String(acc.login).toLowerCase();
      LS.set('cur', ACCT);
      SKIP_ENTER = true;
      toast('Switched to @' + acc.login);
      route();
      return;
    }
    route();
    return;
  }
  dropInflight();
  if (!acc.token) { toast('@' + login + ' has no saved token - sign in again'); return; }

  /* Commit the switch immediately, from the profile already saved on the device.
     Waiting on the network here is what made a tap look like it did nothing. */
  const out = accs.find(a => a.token === TOKEN);
  if (out) out.pins = pins;
  pins = acc.pins || [];
  saveAccounts(accs);

  TOKEN = acc.token;
  ACCT = String(acc.login).toLowerCase();
  LS.set('token', TOKEN);
  LS.set('cur', ACCT);
  USER = { login: acc.login, avatar_url: acc.avatar || '' };
  gistId = acc.gistId || null; LS.set('gistId', gistId);
  LS.set('pins', pins);
  dropApiMem();                      /* nothing from the old account may leak through */
  budgetLoad();                      /* and the allowance shown is the new account's */
  saveTokenNative();
  acctSwitching = true;
  SKIP_ENTER = true;                 /* same screen, new data - do not replay the page entrance */
  toast('Switched to @' + acc.login);
  location.hash = '#/home';
  route();

  /* Then, quietly: confirm the token and fill in the full profile. */
  try {
    const u = await api('/user', { fresh: true, etag: true });   /* with the saved tag: free when unchanged */
    if (TOKEN === acc.token && u && u.login) {
      USER = u;
      saveGistToAccount();
      saveTokenNative();
      widgetPush();
    }
  } catch (e) {
    if (String((e && e.message) || '').indexOf('401') > -1) {
      toast('@' + acc.login + ' needs signing in again - its token has expired');
    }
  } finally {
    setTimeout(() => { acctSwitching = false; }, 900);
  }
}

/* ================= account switcher (on the profile card) =================
   Shown on the signed-in user's profile card, top left, only when more than one
   account is signed in. It carries the avatar of the NEXT account, so a tap
   switches straight to it; with more than two accounts a long press opens a
   menu to pick any of them. Delegated from document, so it survives re-renders. */
function branchFor(full) { try { return LS.get('branch.' + full, null); } catch (e) { return null; } }
function setBranchFor(full, b) { try { if (b) LS.set('branch.' + full, b); else LS.del('branch.' + full); } catch (e) { } }

function acctList() { return getAccounts().filter(a => a && a.login); }

function acctBtnHTML() {
  const accs = acctList();
  if (accs.length <= 1) return '';
  const cur = ((USER && USER.login) || '').toLowerCase();
  const idx = accs.findIndex(a => a.login.toLowerCase() === cur);
  /* prefer an account that is actually different. The old sign-in bug could
     leave two logins sharing one token, and switching to one of those looked
     like the button did nothing. */
  const ordered = accs.slice(idx + 1).concat(accs.slice(0, idx + 1));
  const next = ordered.find(a => a.token !== TOKEN && a.login.toLowerCase() !== cur) || ordered.find(a => a.login.toLowerCase() !== cur);
  if (!next) return '';
  const inner = next.avatar
    ? '<img src="' + esc(next.avatar) + '" alt="">'
    : '<span>' + esc(String(next.login).slice(0, 1).toUpperCase()) + '</span>';
  const tip = 'Switch to @' + next.login + (accs.length > 2 ? ' - hold to choose an account' : '');
  return '<button id="acctSw" class="pacct" data-next="' + esc(next.login) + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' + inner + '</button>';
}

function acctSheet() {
  const accs = acctList();
  const cur = ((USER && USER.login) || '').toLowerCase();
  let html = '<div class="sheethead"><b>Switch account</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div><div class="list">';
  accs.forEach(a => {
    const active = a.login.toLowerCase() === cur;
    html += '<div class="lrow" data-acct="' + esc(a.login) + '">' +
      (a.avatar ? '<img class="cav" src="' + esc(a.avatar) + '" alt="">' : '<div class="cav"></div>') +
      '<div class="lmain"><div class="ltitle">' + esc(a.login) + '</div>' +
      (active ? '<div class="lsub">Active</div>' : '') + '</div>' +
      (active ? SVG.check : '') + '</div>';
  });
  html += '</div><button class="btn ghost btnblock" id="acctManage" style="margin-top:14px">Manage accounts</button>';
  openSheet(html);
  $$('[data-acct]').forEach(r => r.addEventListener('click', () => {
    const l = r.dataset.acct;
    closeSheet();
    if (l.toLowerCase() !== cur) switchAccount(l);
  }));
  const m = $('#acctManage');
  if (m) m.addEventListener('click', () => { closeSheet(); location.hash = '#/settings'; });
}

/* one delegated listener set - the button is re-created on every render */
let acctHold = null, acctHeld = false, acctSwallow = false;
/* Opens the picker and makes sure the release that follows cannot close it. */
function acctOpenPicker() {
  if (acctList().length <= 2) return;
  acctHeld = true;
  acctSwallow = true;                       /* the menu is under the finger - eat that tap */
  clearTimeout(acctHold);
  setTimeout(() => { acctSwallow = false; }, 800);
  try { if (navigator.vibrate) navigator.vibrate(25); } catch (err) { }
  acctSheet();
}
function wireAcctDelegates() {
  document.addEventListener('pointerdown', e => {
    const b = e.target && e.target.closest && e.target.closest('#acctSw');
    if (!b) return;
    acctHeld = false;
    clearTimeout(acctHold);
    /* the menu is only offered when there is a real choice to make */
    acctHold = setTimeout(acctOpenPicker, 550);
  }, true);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t =>
    document.addEventListener(t, () => clearTimeout(acctHold), true));
  /* Android also raises contextmenu for a long press - a second way in, in case
     the scroller swallows the pointer events first */
  document.addEventListener('contextmenu', e => {
    const b = e.target && e.target.closest && e.target.closest('#acctSw');
    if (!b) return;
    e.preventDefault();
    acctOpenPicker();
  }, true);
  document.addEventListener('click', e => {
    /* A long press opens the picker under the finger; the release then lands on
       the sheet's backdrop, which closed it the instant it appeared. Swallow
       that one tap so the picker actually stays open. */
    if (acctSwallow) {
      acctSwallow = false;
      /* only the release that follows the long press - never a tap on the picker */
      const inCard = e.target && e.target.closest && e.target.closest('.sheetcard');
      if (!inCard) { e.preventDefault(); e.stopPropagation(); return; }
    }
    const b = e.target && e.target.closest && e.target.closest('#acctSw');
    if (!b) return;
    /* keep the tap off the profile card underneath, which is itself tappable */
    e.preventDefault(); e.stopPropagation();
    clearTimeout(acctHold);
    if (acctHeld) { acctHeld = false; return; }
    const n = b.dataset.next;
    if (n) switchAccount(n);
  }, true);
}


/* ================= v3.10: triage, checks, reviews, reactions =================
   Everything here fills gaps that a GitHub client needs every day: labels,
   assignees and milestones on issues, CI checks on commits and PRs, pull
   request reviews and the draft toggle, reactions, and running a workflow
   by hand. */

/* ---------- labels ---------- */
function hexA(hex, a) {
  let h = String(hex || '888888').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function labelChip(l) {
  const col = l.color || '888888';
  return '<span class="lbl" style="background:' + hexA(col, .18) + ';color:#' + esc(col) + '">' + esc(l.name) + '</span>';
}
async function labelsSheet(o, n, num, current) {
  const full = o + '/' + n;
  let all;
  try { all = await api('/repos/' + full + '/labels?per_page=100'); }
  catch (e) { toast('Failed: ' + e.message); return; }
  const on = new Set((current || []).map(l => l.name));
  openSheet('<div class="sheethead"><b>Labels</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">Tap a label to add or remove it.</div>' +
    (all.length
      ? '<div class="lblpick">' + all.map(l => '<button class="lblpickb' + (on.has(l.name) ? ' on' : '') + '" data-lbl="' + esc(l.name) + '" style="--lc:#' + esc(l.color || '888888') + '">' + esc(l.name) + '</button>').join('') + '</div>'
      : '<div class="card empty" style="margin-top:12px">This repository has no labels yet.</div>'));
  $$('[data-lbl]').forEach(b => b.addEventListener('click', async () => {
    const name = b.dataset.lbl;
    b.disabled = true;
    try {
      if (on.has(name)) {
        await api('/repos/' + full + '/issues/' + num + '/labels/' + encodeURIComponent(name), { method: 'DELETE' });
        on.delete(name);
      } else {
        await api('/repos/' + full + '/issues/' + num + '/labels', { method: 'POST', body: JSON.stringify({ labels: [name] }) });
        on.add(name);
      }
      b.classList.toggle('on', on.has(name));
      toast(on.has(name) ? 'Label added' : 'Label removed');
    } catch (e) { toast('Failed: ' + e.message); }
    b.disabled = false;
  }));
}

/* ---------- assignees ---------- */
async function assigneesSheet(o, n, num, current) {
  const full = o + '/' + n;
  let people;
  try { people = await api('/repos/' + full + '/assignees?per_page=100'); }
  catch (e) { toast('Failed: ' + e.message); return; }
  people = people || [];
  const on = new Set((current || []).map(a => a.login));
  openSheet('<div class="sheethead"><b>Assignees</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">Tap a person to assign or unassign them.</div>' +
    (people.length
      ? '<div class="list" style="margin-top:12px">' + people.map(p => '<div class="lrow" data-asg="' + esc(p.login) + '">' +
          '<img class="cav" src="' + esc(p.avatar_url) + '" alt=""><div class="lmain"><div class="ltitle">' + esc(p.login) + '</div></div>' +
          '<span class="ck">' + (on.has(p.login) ? SVG.check : '') + '</span></div>').join('') + '</div>'
      : '<div class="card empty" style="margin-top:12px">Nobody can be assigned here.</div>'));
  $$('[data-asg]').forEach(r => r.addEventListener('click', async () => {
    const login = r.dataset.asg;
    if (on.has(login)) on.delete(login); else on.add(login);
    try {
      await api('/repos/' + full + '/issues/' + num, { method: 'PATCH', body: JSON.stringify({ assignees: Array.from(on) }) });
      const ck = r.querySelector('.ck');
      if (ck) ck.innerHTML = on.has(login) ? SVG.check : '';
      toast(on.has(login) ? 'Assigned to ' + login : 'Unassigned ' + login);
    } catch (e) { toast('Failed: ' + e.message); }
  }));
}

/* ---------- milestone ---------- */
async function milestoneSheet(o, n, num, current) {
  const full = o + '/' + n;
  let ms = [];
  try { ms = await api('/repos/' + full + '/milestones?state=all&per_page=100'); } catch (e) { ms = []; }
  ms = ms || [];
  const cur = current ? current.number : null;
  openSheet('<div class="sheethead"><b>Milestone</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">Track this thread against a milestone.</div>' +
    '<div class="list" style="margin-top:12px">' +
    '<div class="lrow" data-ms="0"><div class="lmain"><div class="ltitle">No milestone</div><div class="lsub">clear it</div></div>' +
    (cur === null ? SVG.check : '') + '</div>' +
    ms.map(m => '<div class="lrow" data-ms="' + m.number + '"><div class="lmain"><div class="ltitle">' + esc(m.title) + '</div>' +
      '<div class="lsub">' + (m.state === 'open' ? 'open' : 'closed') +
      (m.due_on ? ' · due ' + new Date(m.due_on).toLocaleDateString() : '') +
      ' · ' + (m.open_issues || 0) + ' open</div></div>' + (cur === m.number ? SVG.check : '') + '</div>').join('') +
    '</div>');
  $$('[data-ms]').forEach(r => r.addEventListener('click', async () => {
    const v = parseInt(r.dataset.ms, 10) || null;
    try {
      await api('/repos/' + full + '/issues/' + num, { method: 'PATCH', body: JSON.stringify({ milestone: v }) });
      closeSheet();
      toast(v ? 'Milestone set' : 'Milestone cleared');
      renderIssue(o, n, num);
    } catch (e) { toast('Failed: ' + e.message); }
  }));
}

/* ---------- reactions ---------- */
const REACT_EMOJI = { '+1': '\uD83D\uDC4D', '-1': '\uD83D\uDC4E', laugh: '\uD83D\uDE04', hooray: '\uD83C\uDF89', confused: '\uD83D\uDE15', heart: '\u2764\uFE0F', rocket: '\uD83D\uDE80', eyes: '\uD83D\uDC40' };
const REACT_ORDER = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'];
const REACT_STORE = {};
function reactionBar(path, reactions) {
  const list = reactions || [];
  REACT_STORE[path] = list;
  const counts = {}, mine = {};
  list.forEach(r => {
    counts[r.content] = (counts[r.content] || 0) + 1;
    if (USER && r.user && r.user.login === USER.login) mine[r.content] = r.id;
  });
  return '<div class="reacts" data-rbar="' + esc(path) + '">' + REACT_ORDER.map(k =>
    '<button class="react' + (mine[k] ? ' on' : '') + '" data-react="' + k + '" data-rpath="' + esc(path) + '" title="' + esc(k) + '">' +
    REACT_EMOJI[k] + (counts[k] ? '<b>' + counts[k] + '</b>' : '') + '</button>').join('') + '</div>';
}
function wireReactions() {
  document.addEventListener('click', async e => {
    const b = e.target && e.target.closest && e.target.closest('[data-react]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const path = b.dataset.rpath, kind = b.dataset.react;
    const list = REACT_STORE[path] || [];
    const mineRec = list.filter(r => r.content === kind && USER && r.user && r.user.login === USER.login)[0];
    b.disabled = true;
    try {
      if (mineRec) await api(path + '/reactions/' + mineRec.id, { method: 'DELETE' });
      else await api(path + '/reactions', { method: 'POST', body: JSON.stringify({ content: kind }) });
      toast(mineRec ? 'Reaction removed' : 'Reaction added');
      const fresh = await api(path).catch(() => null);
      if (fresh && fresh.reactions) {
        const holder = document.querySelector('[data-rbar="' + path + '"]');
        if (holder) holder.outerHTML = reactionBar(path, fresh.reactions);
      }
    } catch (err) { toast('Failed: ' + err.message); }
    b.disabled = false;
  }, true);
}

/* ---------- CI checks + commit status ---------- */
async function checksHTML(o, n, ref) {
  if (!ref) return '';
  const full = o + '/' + n;
  const [cr, st] = await Promise.all([
    api('/repos/' + full + '/commits/' + ref + '/check-runs?per_page=50').catch(() => null),
    api('/repos/' + full + '/commits/' + ref + '/status').catch(() => null)
  ]);
  const runs = (cr && cr.check_runs) || [];
  const sts = (st && st.statuses) || [];
  if (!runs.length && !sts.length) return '';
  const bad = runs.filter(r => r.conclusion && ['success', 'neutral', 'skipped'].indexOf(r.conclusion) < 0).length +
    sts.filter(s => s.state === 'failure' || s.state === 'error').length;
  const pend = runs.filter(r => !r.conclusion).length + sts.filter(s => s.state === 'pending').length;
  const total = runs.length + sts.length;
  const ok = !bad && !pend;
  const head = ok ? 'All checks passed' : (bad ? bad + ' check' + (bad === 1 ? '' : 's') + ' failed'
    : pend + ' check' + (pend === 1 ? '' : 's') + ' running');
  let h = '<div class="card"><div class="crow"><b>' + esc(head) + '</b>' +
    '<span class="chip ' + (ok ? 'ok' : (bad ? 'del' : '')) + '">' + total + ' total</span></div><div class="list" style="margin-top:10px">';
  const icon = cls => '<div class="runstate ' + cls + '">' + (cls === 'ok' ? SVG.check : (cls === 'bad' ? SVG.x : SVG.dot)) + '</div>';
  runs.forEach(r => {
    const cls = r.conclusion === 'success' ? 'ok'
      : (r.conclusion && ['neutral', 'skipped'].indexOf(r.conclusion) >= 0) ? 'mute'
      : (r.conclusion ? 'bad' : 'run');
    h += '<div class="lrow"' + (r.html_url ? ' data-act="ext" data-url="' + esc(r.html_url) + '"' : '') + '>' + icon(cls) +
      '<div class="lmain"><div class="ltitle">' + esc(r.name || 'check') + '</div>' +
      '<div class="lsub">' + esc(r.conclusion || r.status || '') + (r.app && r.app.name ? ' · ' + esc(r.app.name) : '') + '</div></div></div>';
  });
  sts.forEach(s => {
    const cls = s.state === 'success' ? 'ok' : (s.state === 'pending' ? 'run' : 'bad');
    h += '<div class="lrow">' + icon(cls) +
      '<div class="lmain"><div class="ltitle">' + esc(s.context) + '</div>' +
      '<div class="lsub">' + esc(s.description || s.state) + '</div></div></div>';
  });
  return h + '</div></div>';
}

/* ---------- pull request reviews + draft toggle ---------- */
function reviewSheet(o, n, num) {
  let ev = 'COMMENT';
  openSheet('<div class="sheethead"><b>Review pull request #' + num + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="seg sm" style="margin-top:12px"><button class="segb on" data-ev="COMMENT">Comment</button>' +
    '<button class="segb" data-ev="APPROVE">Approve</button>' +
    '<button class="segb" data-ev="REQUEST_CHANGES">Request changes</button></div>' +
    '<textarea id="revText" placeholder="Leave a review note…" style="margin-top:12px"></textarea>' +
    '<button class="btn primary btnblock" id="revGo" style="margin-top:12px">Submit review</button>');
  $$('[data-ev]').forEach(b => b.addEventListener('click', () => {
    ev = b.dataset.ev;
    $$('[data-ev]').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#revGo').addEventListener('click', async () => {
    const body = $('#revText').value.trim();
    if (ev === 'REQUEST_CHANGES' && !body) { toast('Say what needs changing'); return; }
    $('#revGo').disabled = true;
    try {
      await api('/repos/' + o + '/' + n + '/pulls/' + num + '/reviews', { method: 'POST', body: JSON.stringify({ body, event: ev }) });
      closeSheet();
      toast(ev === 'APPROVE' ? 'Approved' : ev === 'REQUEST_CHANGES' ? 'Changes requested' : 'Review submitted');
      renderIssue(o, n, num);
    } catch (e) { toast('Failed: ' + e.message); $('#revGo').disabled = false; }
  });
}
async function toggleDraft(o, n, num, pr, btn) {
  if (!pr.node_id) { toast('Draft toggle needs a GitHub token — sign in first'); return; }
  const q = pr.draft
    ? 'mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ isDraft } } }'
    : 'mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ isDraft } } }';
  btn.disabled = true;
  try {
    const r = await api('/graphql', { method: 'POST', body: JSON.stringify({ query: q, variables: { id: pr.node_id } }) });
    if (r && r.errors && r.errors.length) throw new Error(r.errors[0].message || 'Could not change the draft state');
    /* the one GraphQL write: drop the tags of what it can change (this repo and the lists) */
    try { staleApiCache('/repos/' + o + '/' + n + '/pulls/' + num); } catch (e) { }
    toast(pr.draft ? 'Marked ready for review' : 'Converted to draft');
    renderIssue(o, n, num);
  } catch (e) { toast('Failed: ' + e.message); btn.disabled = false; }
}

/* ---------- run a workflow by hand ---------- */
async function dispatchSheet(o, n) {
  const full = o + '/' + n;
  let wfs = [];
  try { wfs = ((await api('/repos/' + full + '/actions/workflows')) || {}).workflows || []; }
  catch (e) { toast('Failed: ' + e.message); return; }
  const usable = wfs.filter(w => w.state === 'active');
  const rr = repoCache.get(full);
  const ref = (rr && rr.default_branch) || 'main';
  openSheet('<div class="sheethead"><b>Run a workflow</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">Only workflows that declare a workflow_dispatch trigger can be started by hand.</div>' +
    '<label class="fldlabel" style="margin-top:14px">Branch or tag</label>' +
    '<input class="fld" id="dwRef" value="' + esc(ref) + '">' +
    (usable.length
      ? '<div class="list" style="margin-top:14px">' + usable.map(w => '<div class="lrow">' +
          '<div class="runstate mute">' + SVG.dot + '</div>' +
          '<div class="lmain"><div class="ltitle">' + esc(w.name) + '</div><div class="lsub">' + esc(w.path) + '</div></div>' +
          '<button class="btn ghost" data-runwf="' + w.id + '">Run</button></div>').join('') + '</div>'
      : '<div class="card empty" style="margin-top:12px">No workflows in this repository.</div>'));
  $$('[data-runwf]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.runwf;
    const r2 = ($('#dwRef') && $('#dwRef').value.trim()) || ref;
    b.disabled = true;
    try {
      await api('/repos/' + full + '/actions/workflows/' + id + '/dispatches', { method: 'POST', body: JSON.stringify({ ref: r2 }) });
      closeSheet();
      toast('Workflow started on ' + r2);
      setTimeout(() => renderActions(o, n), 1600);
    } catch (e) { toast('Failed: ' + e.message); b.disabled = false; }
  }));
}


/* ================= v3.11: scroll back to the top of a README =================
   Long READMEs used to leave you stranded at the bottom. Once you are near the
   end of a page that actually has a README on it, a small up arrow appears and
   takes you back to the top. It stays out of the way of the upload button. */
function toTopBtn() {
  let el = document.getElementById('toTop');
  if (!el) {
    el = document.createElement('button');
    el.id = 'toTop';
    el.setAttribute('aria-label', 'Scroll to top');
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    el.addEventListener('click', () => {
      const sc = document.getElementById('scroller');
      if (!sc) return;
      try { sc.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { sc.scrollTop = 0; }
    });
    document.body.appendChild(el);
  }
  return el;
}
/* only when a real README is on screen - the repo skeleton keeps an empty
   #readmeWrap around, and an arrow there would be noise */
function readmeOnPage() {
  const ids = ['readmeWrap', 'preReadme'];
  for (let i = 0; i < ids.length; i++) {
    const el = document.getElementById(ids[i]);
    if (el && el.textContent.replace(/\s+/g, ' ').trim().length > 40) return true;
  }
  const rb = document.querySelector('.readmebody');
  return !!(rb && rb.textContent.replace(/\s+/g, ' ').trim().length > 40);
}
function updateToTop() {
  const el = toTopBtn();
  const sc = document.getElementById('scroller');
  if (!sc) { el.classList.remove('on'); return; }
  const max = sc.scrollHeight - sc.clientHeight;
  const y = sc.scrollTop;
  el.classList.toggle('on', readmeOnPage() && max > 500 && y > max - 520);
  /* never sit on top of the upload progress button */
  const busy = document.getElementById('upProgCard');
  el.style.bottom = busy ? (isWide() ? '104px' : '182px') : '';
}


/* ================= v3.13: authorized apps =================
   GitHub's "Authorized OAuth Apps" and "Installed GitHub Apps" screens,
   inside Gitly. See what you have let into your account, what each one can
   reach, revoke an OAuth app on the spot, and start a fresh authorization
   without leaving the app. GitHub still shows its own approval page - that
   is the only place a token can be issued, so Gitly opens it for you. */

function openExternal(url) {
  if (!url) return;
  try { if (window.OneGit) { window.location.href = url; return; } } catch (e) {}
  try { const w = window.open(url, '_blank', 'noopener'); if (w) return; } catch (e) {}
  try { window.location.href = url; } catch (e) {}
}
function knownApps() { return LS.get('authApps', []) || []; }
function rememberApp(clientId, name) {
  if (!clientId) return;
  const list = knownApps().filter(a => a && a.client_id !== clientId);
  list.unshift({ client_id: clientId, name: name || clientId });
  LS.set('authApps', list.slice(0, 40));
}
const AUTH_SCOPE_CHOICES = [
  ['repo', 'Full control of repositories'],
  ['workflow', 'Update GitHub Actions workflows'],
  ['gist', 'Create and edit gists'],
  ['notifications', 'Read notifications'],
  ['read:user', 'Read profile data'],
  ['user:email', 'Read email addresses'],
  ['read:org', 'Read organisation membership'],
  ['write:discussion', 'Read and write team discussions'],
  ['project', 'Read and write projects'],
  ['delete_repo', 'Delete repositories']
];

function authorizeAppSheet() {
  const known = knownApps();
  let scopes = ['read:user', 'user:email'];
  openSheet('<div class="sheethead"><b>Authorize an app</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub lsubwrap">GitHub always shows its own approval page before an app gets anything. Gitly opens that page for you, and remembers the app so you can authorize it again in one tap.</div>' +
    (known.length ? '<label class="fldlabel" style="margin-top:16px">Apps you have used</label>' +
      '<div class="list">' + known.map(a => '<div class="lrow"><div class="lmain"><div class="ltitle">' + esc(a.name) + '</div>' +
        '<div class="lsub">' + esc(a.client_id) + '</div></div>' +
        '<button class="btn ghost" data-authid="' + esc(a.client_id) + '" data-authname="' + esc(a.name) + '">Authorize</button></div>').join('') + '</div>' : '') +
    '<label class="fldlabel" style="margin-top:16px">Client ID</label>' +
    '<input class="fld" id="authCid" placeholder="Iv1.0123456789abcdef" autocomplete="off" spellcheck="false">' +
    '<label class="fldlabel" style="margin-top:14px">Permissions to ask for</label>' +
    '<div class="lblpick" id="authScopes">' + AUTH_SCOPE_CHOICES.map(s =>
      '<button class="lblpickb' + (scopes.indexOf(s[0]) >= 0 ? ' on' : '') + '" data-scope="' + s[0] + '" title="' + esc(s[1]) + '">' + esc(s[0]) + '</button>').join('') + '</div>' +
    '<button class="btn primary btnblock" id="authGo" style="margin-top:16px">Open GitHub to authorize</button>' +
    '<div class="lsub" style="margin-top:10px">The app has to list this page as its callback, exactly as GitHub requires — Gitly cannot grant anything on its own.</div>');
  $$('[data-scope]').forEach(b => b.addEventListener('click', () => {
    const s = b.dataset.scope;
    if (scopes.indexOf(s) >= 0) scopes = scopes.filter(x => x !== s); else scopes.push(s);
    b.classList.toggle('on', scopes.indexOf(s) >= 0);
  }));
  const launch = (cid, name) => {
    if (!cid) { toast('Enter the app client ID first'); return; }
    rememberApp(cid, name);
    const url = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(cid) +
      (scopes.length ? '&scope=' + encodeURIComponent(scopes.join(' ')) : '') +
      '&state=' + Math.random().toString(36).slice(2);
    /* show what is being asked for first, in GitHub's own layout */
    consentSheet({ name: name || cid, scopes: scopes.slice() }, () => {
      toast('Approve on GitHub — you will come straight back here');
      openExternal(url);
    });
  };
  $$('[data-authid]').forEach(b => b.addEventListener('click', () => launch(b.dataset.authid, b.dataset.authname)));
  $('#authGo').addEventListener('click', () => launch(($('#authCid').value || '').trim(), ($('#authCid').value || '').trim()));
}

function revokeGrantSheet(clientId, name) {
  openSheet('<div class="sheethead"><b>Revoke access — ' + esc(name || 'app') + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 14px">' + esc(name || 'This app') + ' loses access to your GitHub account straight away. Anything built on it — a deploy, a bot, a sync — stops working until you authorize it again.</p>' +
    '<button class="btn danger btnblock" id="rgGo">Revoke access</button>');
  $('#rgGo').addEventListener('click', async () => {
    $('#rgGo').disabled = true;
    try {
      await api('/applications/' + encodeURIComponent(clientId) + '/grant', { method: 'DELETE' });
      closeSheet();
      toast('Access revoked');
      renderAuthorized();
    } catch (e) { toast('Failed: ' + e.message); $('#rgGo').disabled = false; }
  });
}

async function renderAuthorized() {
  const seq = ++RSEQ;
  view().innerHTML = spinner();
  const [grantsRes, instsRes] = await Promise.all([
    api('/applications/grants?per_page=100').then(d => ({ d })).catch(e => ({ e })),
    api('/user/installations?per_page=100').then(d => ({ d })).catch(e => ({ e }))
  ]);
  if (seq !== RSEQ) return;
  const grants = Array.isArray(grantsRes.d) ? grantsRes.d : [];
  const insts = (instsRes.d && instsRes.d.installations) || [];
  /* anything already authorized becomes a one-tap re-authorize next time */
  grants.forEach(g => { if (g && g.app && g.app.client_id) rememberApp(g.app.client_id, g.app.name); });

  let html = '<div class="card"><p style="margin:0;font-size:13.5px;color:var(--text2);line-height:1.6">Everything that signs in with your GitHub account shows up here. Revoking an OAuth app cuts its access immediately. GitHub Apps are installed and removed on GitHub itself.</p></div>';
  html += '<button class="btn primary btnblock" id="authNew" style="margin-top:12px">Authorize a new app</button>';

  html += '<h2 class="sect">Authorized OAuth apps</h2>';
  if (grantsRes.e) {
    html += '<div class="card empty">' + esc(grantsRes.e.message || 'Could not load your authorized apps') +
      '<div class="lsub" style="margin-top:8px">GitHub only lists these for OAuth app tokens — a fine-grained personal access token is not allowed to read them. Sign in with GitHub rather than pasting a token to see this list.</div></div>';
  } else if (!grants.length) {
    html += '<div class="card empty">No apps are authorized on your account yet.<div class="lsub" style="margin-top:8px">When an app asks to sign you in with GitHub and you approve it, it appears here.</div></div>';
  } else {
    html += '<div class="card list">' + grants.map(g => {
      const nm = (g.app && g.app.name) || 'Application';
      const scopes = (g.scopes || []).filter(Boolean);
      return '<div class="lrow" style="flex-wrap:wrap">' +
        '<div class="lmain" style="flex:1;min-width:0"><div class="ltitle">' + esc(nm) + '</div>' +
        '<div class="lsub lsubwrap">' + (scopes.length ? esc(scopes.join(' · ')) : 'no scopes recorded') + '</div>' +
        '<div class="lsub">authorized ' + tAgo(g.created_at) + '</div></div>' +
        '<button class="btn ghost" data-revoke="' + esc((g.app && g.app.client_id) || '') + '" data-rname="' + esc(nm) + '">Revoke</button>' +
        '</div>';
    }).join('') + '</div>';
  }

  html += '<h2 class="sect">Installed GitHub Apps</h2>';
  if (instsRes.e) {
    html += '<div class="card empty">' + esc(instsRes.e.message || 'Could not load your installed apps') + '</div>';
  } else if (!insts.length) {
    html += '<div class="card empty">No GitHub Apps are installed on your account.</div>';
  } else {
    html += '<div class="card list">' + insts.map(it => {
      const app = it.app || {};
      const perms = Object.keys(it.permissions || {});
      const sel = it.repository_selection === 'all' ? 'all repositories' : 'selected repositories';
      return '<div class="lrow" style="flex-wrap:wrap">' +
        '<div class="lmain" style="flex:1;min-width:0"><div class="ltitle">' + esc(app.name || it.app_slug || 'GitHub App') + '</div>' +
        '<div class="lsub lsubwrap">' + (perms.length ? esc(perms.join(' · ')) : 'no permissions listed') + '</div>' +
        '<div class="lsub">' + esc(sel) + (it.account && it.account.login ? ' · on @' + esc(it.account.login) : '') + '</div></div>' +
        (it.html_url ? '<button class="btn ghost" data-act="ext" data-url="' + esc(it.html_url) + '">Manage</button>' : '') +
        '</div>';
    }).join('') + '</div>';
  }
  html += '<button class="btn ghost btnblock" style="margin-top:12px" data-act="ext" data-url="https://github.com/settings/installations">Manage GitHub Apps on GitHub</button>';
  html += '<button class="btn ghost btnblock" style="margin-top:10px" id="authReload">Refresh this list</button>';

  view().innerHTML = html;
  const an = $('#authNew');
  if (an) an.addEventListener('click', () => authorizeAppSheet());
  const ar = $('#authReload');
  if (ar) ar.addEventListener('click', () => renderAuthorized());
  $$('[data-revoke]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.revoke;
    if (!id) { toast('This app did not report a client id'); return; }
    revokeGrantSheet(id, b.dataset.rname);
  }));
}


/* ================= v3.14: the GitHub consent screen, and SSH keys =================
   The approval page in GitHub's own words and layout, so you can see exactly
   what an app is asking for before you hand it anything. GitHub still performs
   the grant - this screen is the review step, not a substitute for it. */

const SCOPE_META = {
  'repo': ['Repositories', 'Full control of private repositories', 'read-write'],
  'public_repo': ['Repositories', 'Access public repositories', 'read-write'],
  'repo:status': ['Repositories', 'Access commit status', 'read-write'],
  'delete_repo': ['Repositories', 'Delete repositories', 'admin'],
  'admin:repo_hook': ['Repositories', 'Admin access to repository hooks', 'admin'],
  'write:repo_hook': ['Repositories', 'Read and write repository hooks', 'read-write'],
  'read:repo_hook': ['Repositories', 'Read repository hooks', 'read-only'],
  'workflow': ['Workflows', 'Update GitHub Action workflows', 'read-write'],
  'gist': ['Gists', 'Create gists', 'read-write'],
  'notifications': ['Notifications', 'Access notifications', 'read-write'],
  'user': ['Personal user data', 'Read and write all user profile data', 'read-write'],
  'read:user': ['Personal user data', 'Read all user profile data', 'read-only'],
  'user:email': ['Personal user data', 'Access user email addresses', 'read-only'],
  'user:follow': ['Personal user data', 'Follow and unfollow users', 'read-write'],
  'read:org': ['Organization access', 'Read org and team membership, read org projects', 'read-only'],
  'write:org': ['Organization access', 'Read and write org and team membership', 'read-write'],
  'admin:org': ['Organization access', 'Full control of orgs and teams', 'admin'],
  'project': ['Projects', 'Read and write projects', 'read-write'],
  'write:discussion': ['Discussions', 'Read and write team discussions', 'read-write'],
  'admin:public_key': ['SSH keys', 'Full control of public SSH keys', 'admin'],
  'write:public_key': ['SSH keys', 'Create, update and delete public SSH keys', 'read-write'],
  'read:public_key': ['SSH keys', 'List public SSH keys', 'read-only'],
  'admin:ssh_signing_key': ['SSH signing keys', 'Full control of SSH signing keys', 'admin'],
  'write:ssh_signing_key': ['SSH signing keys', 'Create, update and delete SSH signing keys', 'read-write'],
  'read:ssh_signing_key': ['SSH signing keys', 'List SSH signing keys', 'read-only'],
  'read:packages': ['Packages', 'Download packages', 'read-only'],
  'write:packages': ['Packages', 'Upload packages', 'read-write'],
  'delete:packages': ['Packages', 'Delete packages', 'admin'],
  'read:audit_log': ['Audit log', 'Read the audit log', 'read-only'],
  'read:gpg_key': ['GPG keys', 'List GPG keys', 'read-only'],
  'write:gpg_key': ['GPG keys', 'Create, update and delete GPG keys', 'read-write'],
  'codespace': ['Codespaces', 'Create and manage codespaces', 'read-write']
};
const SCOPE_GROUP_ORDER = ['Personal user data', 'Repositories', 'Workflows', 'Gists', 'Notifications', 'Organization access', 'Projects', 'Discussions', 'SSH keys', 'SSH signing keys', 'GPG keys', 'Packages', 'Codespaces', 'Audit log', 'Other permissions'];

function scopeInfo(sc) {
  const m = SCOPE_META[sc];
  return m ? { scope: sc, group: m[0], label: m[1], access: m[2] } : { scope: sc, group: 'Other permissions', label: sc, access: '' };
}
function consentSheet(app, onAuthorize) {
  const scopes = (app && app.scopes) || [];
  const infos = scopes.map(scopeInfo);
  const groups = {};
  infos.forEach(i => { (groups[i.group] = groups[i.group] || []).push(i); });
  const order = SCOPE_GROUP_ORDER.filter(g => groups[g]).concat(Object.keys(groups).filter(g => SCOPE_GROUP_ORDER.indexOf(g) < 0));
  const login = (USER && USER.login) || 'your GitHub';
  const appName = (app && app.name) || 'the application';
  let html = '<div class="consent">' +
    '<div class="cmark">' + esc(String(appName).slice(0, 1).toUpperCase()) + '</div>' +
    '<h2 class="ctitle">Authorize ' + esc(appName) + '</h2>' +
    '<div class="cby">' + esc(appName) + (app && app.owner ? ' by ' + esc(app.owner) : '') + '</div>' +
    '<p class="cwants">wants to access your <b>' + esc(login) + '</b> account</p>';
  if (!infos.length) {
    html += '<div class="clist"><div class="cgroup"><div class="cglabel">Personal user data</div>' +
      '<div class="crow3"><span>No permissions requested</span></div></div></div>';
  } else {
    html += '<div class="clist">' + order.map(g => '<div class="cgroup"><div class="cglabel">' + esc(g) + '</div>' +
      groups[g].map(i => '<div class="crow3"><span>' + esc(i.label) + '</span>' + (i.access ? '<b>' + esc(i.access) + '</b>' : '') + '</div>').join('') +
      '</div>').join('') + '</div>';
  }
  if (app && app.redirect) html += '<div class="credirect">Authorizing will redirect to<br><span>' + esc(app.redirect) + '</span></div>';
  html += '<p class="cnote">GitHub shows its own approval page next. That page is the only place the permission is actually granted — this is the review step.</p>' +
    '<div class="cbtns"><button class="btn ghost" id="cCancel">Cancel</button>' +
    '<button class="btn primary" id="cGo">Authorize ' + esc(String(appName).split(' ')[0].toLowerCase()) + '</button></div></div>';
  openSheet(html);
  const cc = $('#cCancel');
  if (cc) cc.addEventListener('click', () => closeSheet());
  const cg = $('#cGo');
  if (cg) cg.addEventListener('click', () => { closeSheet(); onAuthorize(); });
}

/* ---------- SSH keys ---------- */
function b64uToBytes(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function sshStr(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  out[0] = (bytes.length >>> 24) & 255; out[1] = (bytes.length >>> 16) & 255;
  out[2] = (bytes.length >>> 8) & 255; out[3] = bytes.length & 255;
  out.set(bytes, 4);
  return out;
}
function sshMpint(bytes) {
  let b = bytes;
  while (b.length > 1 && b[0] === 0) b = b.slice(1);
  if (b[0] & 0x80) { const t = new Uint8Array(b.length + 1); t.set(b, 1); b = t; }
  return sshStr(b);
}
function concatBytes(list) {
  let n = 0; list.forEach(a => { n += a.length; });
  const out = new Uint8Array(n); let o = 0;
  list.forEach(a => { out.set(a, o); o += a.length; });
  return out;
}
function pemWrap(buf, label) {
  const b64 = bytesToB64(new Uint8Array(buf));
  return '-----BEGIN ' + label + '-----\n' + (b64.match(/.{1,64}/g) || []).join('\n') + '\n-----END ' + label + '-----';
}
function canGenerateKeys() {
  try { return !!(window.crypto && crypto.subtle && crypto.subtle.generateKey && crypto.subtle.exportKey); } catch (e) { return false; }
}
/* an RSA pair, built with the device's own crypto; the public half is written
   in OpenSSH wire format (string "ssh-rsa", mpint e, mpint n) */
async function generateSshKeyPair(bits) {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits || 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const blob = concatBytes([
    sshStr(new TextEncoder().encode('ssh-rsa')),
    sshMpint(b64uToBytes(jwk.e)),
    sshMpint(b64uToBytes(jwk.n))
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  return { pubLine: 'ssh-rsa ' + bytesToB64(blob), privPem: pemWrap(pkcs8, 'PRIVATE KEY') };
}
async function renderSshKeys() {
  const seq = ++RSEQ;
  view().innerHTML = spinner();
  let keys;
  try { keys = await api('/user/keys?per_page=100'); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  let html = '<div class="card"><p style="margin:0;font-size:13.5px;color:var(--text2);line-height:1.6">SSH keys on your GitHub account. A pair generated here is made on this device — the private half never leaves it, and only the public half is sent to GitHub.</p></div>';
  html += '<button class="btn primary btnblock" id="sshGen" style="margin-top:12px">Generate a new SSH key</button>';
  html += '<button class="btn ghost btnblock" id="sshAdd" style="margin-top:10px">Add an existing public key</button>';
  html += '<h2 class="sect">Your SSH keys</h2>';
  html += (keys && keys.length)
    ? '<div class="card list">' + keys.map(k => '<div class="lrow" style="flex-wrap:wrap">' +
        '<div class="lmain" style="flex:1;min-width:0"><div class="ltitle">' + esc(k.title || 'key') + '</div>' +
        '<div class="lsub lsubwrap">' + esc(k.key || '') + '</div>' +
        '<div class="lsub">' + (k.read_only ? 'read-only' : 'read-write') + ' · added ' + tAgo(k.created_at) + '</div></div>' +
        '<button class="btn ghost" data-delkey="' + k.id + '" data-kname="' + esc(k.title || '') + '">Remove</button></div>').join('') + '</div>'
    : '<div class="card empty">No SSH keys on your account yet.</div>';
  view().innerHTML = html;
  const g = $('#sshGen');
  if (g) g.addEventListener('click', () => sshGenerateSheet());
  const a = $('#sshAdd');
  if (a) a.addEventListener('click', () => sshAddSheet());
  $$('[data-delkey]').forEach(b => b.addEventListener('click', () => sshDeleteSheet(b.dataset.delkey, b.dataset.kname)));
}
function sshGenerateSheet() {
  let bits = 4096;
  openSheet('<div class="sheethead"><b>Generate a new SSH key</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub lsubwrap">The pair is created on this device. Only the public half goes to GitHub — the private half is shown once and never stored, so save it somewhere safe.</div>' +
    '<label class="fldlabel" style="margin-top:16px">Title</label>' +
    '<input class="fld" id="sgTitle" value="Gitly on this device" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:14px">Key size</label>' +
    '<div class="seg"><button class="segb on" data-bits="4096">RSA 4096</button><button class="segb" data-bits="2048">RSA 2048</button></div>' +
    '<button class="btn primary btnblock" id="sgGo" style="margin-top:16px">Generate and add to GitHub</button>' +
    (canGenerateKeys() ? '' : '<div class="lsub" style="margin-top:10px">This device will not let the app create keys — use "Add an existing public key" instead.</div>'));
  $$('[data-bits]').forEach(b => b.addEventListener('click', () => { bits = parseInt(b.dataset.bits, 10); $$('[data-bits]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#sgGo').addEventListener('click', async () => {
    if (!canGenerateKeys()) { toast('This device cannot generate keys — add an existing one instead'); return; }
    const title = ($('#sgTitle').value || '').trim() || 'Gitly key';
    const btn = $('#sgGo');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const kp = await generateSshKeyPair(bits);
      btn.textContent = 'Adding to GitHub…';
      await api('/user/keys', { method: 'POST', body: JSON.stringify({ title, key: kp.pubLine }) });
      closeSheet();
      toast('Public key added to GitHub');
      renderSshKeys();
      sshPrivateSheet(title, kp.privPem);
    } catch (e) {
      toast('Failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Generate and add to GitHub';
    }
  });
}
function sshPrivateSheet(title, pem) {
  openSheet('<div class="sheethead"><b>Your private key</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 12px">The public half of “' + esc(title) + '” is on GitHub. This private half is the only copy — it is not saved anywhere, and it cannot be shown again. Copy it into a file now.</p>' +
    '<textarea class="keybox" id="sgPem" readonly spellcheck="false">' + esc(pem) + '</textarea>' +
    '<button class="btn primary btnblock" id="sgCopy" style="margin-top:12px">Copy private key</button>' +
    '<div class="lsub" style="margin-top:10px">On a computer, save it as a file (for example <b>gitly_key</b>) and run <b>chmod 600 gitly_key</b> before using it with ssh.</div>');
  const c = $('#sgCopy');
  if (c) c.addEventListener('click', () => {
    const t = ($('#sgPem') || {}).value || pem;
    try { if (window.OneGit && window.OneGit.copy) { window.OneGit.copy(t); toast('Private key copied'); return; } } catch (e) {}
    try { navigator.clipboard.writeText(t); toast('Private key copied'); } catch (e) { toast('Select the text and copy it manually'); }
  });
}
function sshAddSheet() {
  openSheet('<div class="sheethead"><b>Add an existing public key</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel" style="margin-top:12px">Title</label>' +
    '<input class="fld" id="saTitle" placeholder="My laptop" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:14px">Key</label>' +
    '<textarea class="replyta" id="saKey" placeholder="ssh-ed25519 AAAA… or ssh-rsa AAAA…" spellcheck="false"></textarea>' +
    '<button class="btn primary btnblock" id="saGo" style="margin-top:14px">Add key to GitHub</button>');
  $('#saGo').addEventListener('click', async () => {
    const title = ($('#saTitle').value || '').trim() || 'Key';
    const key = ($('#saKey').value || '').trim();
    if (!key) { toast('Paste the public key first'); return; }
    $('#saGo').disabled = true;
    try {
      await api('/user/keys', { method: 'POST', body: JSON.stringify({ title, key }) });
      closeSheet();
      toast('Key added to GitHub');
      renderSshKeys();
    } catch (e) { toast('Failed: ' + e.message); $('#saGo').disabled = false; }
  });
}
function sshDeleteSheet(id, title) {
  openSheet('<div class="sheethead"><b>Remove SSH key — ' + esc(title || 'key') + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 14px">GitHub will refuse this key from now on. Anything already using it stops being able to push or pull.</p>' +
    '<button class="btn danger btnblock" id="skGo">Remove key</button>');
  $('#skGo').addEventListener('click', async () => {
    $('#skGo').disabled = true;
    try {
      await api('/user/keys/' + id, { method: 'DELETE' });
      closeSheet();
      toast('Key removed');
      renderSshKeys();
    } catch (e) { toast('Failed: ' + e.message); $('#skGo').disabled = false; }
  });
}


/* ================= v3.15: personal access tokens =================
   GitHub does not let any app mint a token for you - a personal access token
   can only be created on GitHub's own site. What Gitly can do is fill the form
   in for you: pick the type, name it, choose exactly which permissions it gets,
   open the page with all of that already set, then take the token back and sign
   you in with it. */
let TK = null;
function tkDefault() {
  return { type: 'app', name: 'Gitly', desc: '', exp: 30, perms: { metadata: 'read', contents: 'read' }, scopes: ['repo', 'read:user', 'notifications', 'gist'] };
}
/* shown the moment Gitly has a token of its own to hand over */
/* ---------- tokens Gitly created (kept on this device, never auto-applied) ---------- */
function madeTokens() { return LS.get('madeTokens', []) || []; }
function saveMadeToken(tok, scopes) {
  if (!tok) return;
  const list = madeTokens().filter(t => t && t.token !== tok);
  list.unshift({ token: tok, at: Date.now(), scopes: scopes || OAUTH_SCOPES });
  LS.set('madeTokens', list.slice(0, 20));
}
function maskTok(t) { const v = String(t || ''); return v.slice(0, 12) + '•'.repeat(14); }
function useMadeToken(tok) {
  try { completeLogin(tok).catch(e => toast('Sign-in failed: ' + e.message)); }
  catch (e) { toast('Sign-in failed: ' + e.message); }
}
function dropMadeToken(tok) {
  LS.set('madeTokens', madeTokens().filter(t => t && t.token !== tok));
  toast('Removed from this device');
  renderTokens();
}
function tokenCreatedSheet(tok) {
  openSheet('<div class="sheethead"><b>Token created</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 12px">Gitly created this token and saved it on this device. Copy it for anything else — it is kept on the Personal access tokens screen. Your current sign-in is not changed.</p>' +
    '<textarea class="keybox" id="tcTok" readonly spellcheck="false">' + esc(tok) + '</textarea>' +
    '<button class="btn primary btnblock" id="tcCopy" style="margin-top:12px">Copy token</button>' +
    '<button class="btn ghost btnblock" id="tcUse" style="margin-top:8px">Use this token to sign in instead</button>');
  const c = $('#tcCopy');
  if (c) c.addEventListener('click', () => {
    const t = ($('#tcTok') || {}).value || tok;
    try { if (window.OneGit && window.OneGit.copy) { window.OneGit.copy(t); toast('Token copied'); return; } } catch (e) {}
    try { navigator.clipboard.writeText(t); toast('Token copied'); } catch (e) { toast('Select the text and copy it manually'); }
  });
  const u = $('#tcUse');
  if (u) u.addEventListener('click', () => { closeSheet(); useMadeToken(tok); });
}
/* permission, plain-English meaning, and the levels GitHub actually accepts */
const FG_PERMS = [
  ['contents', 'Files, commits and branches', ['read', 'write']],
  ['issues', 'Issues', ['read', 'write']],
  ['pull_requests', 'Pull requests', ['read', 'write']],
  ['actions', 'GitHub Actions runs', ['read', 'write']],
  ['workflows', 'Workflow files', ['write']],
  ['administration', 'Repository administration', ['write']],
  ['secrets', 'Actions secrets', ['write']],
  ['variables', 'Actions variables', ['write']],
  ['deployments', 'Deployments', ['read', 'write']],
  ['environments', 'Environments', ['write']],
  ['pages', 'GitHub Pages', ['write']],
  ['statuses', 'Commit statuses', ['read', 'write']],
  ['notifications', 'Notifications', ['read', 'write']],
  ['gists', 'Gists', ['write']],
  ['starring', 'Starring', ['read', 'write']],
  ['watching', 'Watching', ['read', 'write']],
  ['followers', 'Followers', ['read', 'write']],
  ['emails', 'Email addresses', ['read']],
  ['profile', 'Profile', ['read', 'write']],
  ['members', 'Organisation members', ['read']],
  ['webhooks', 'Webhooks', ['write']],
  ['labels', 'Labels', ['write']],
  ['milestones', 'Milestones', ['write']],
  ['discussions', 'Discussions', ['read', 'write']],
  ['dependabot_alerts', 'Dependabot alerts', ['read', 'write']],
  ['code_scanning_alerts', 'Code scanning alerts', ['read', 'write']]
];
/* Whatever the user picked (classic scopes, or fine-grained permissions) is
   turned into the OAuth scopes Gitly asks GitHub for. Gitly creates the token
   itself - GitHub never shows a token form. */
function tkScopesForOauth() {
  if (TK.type === 'fine') {
    const p = TK.perms || {};
    const has = k => p[k] && p[k] !== 'none';
    const out = ['read:user'];
    if (has('contents') || has('issues') || has('pull_requests') || has('actions') ||
        has('commit_statuses') || has('deployments') || has('discussions') ||
        has('packages') || has('security_events')) out.push('repo');
    if (has('actions') || has('workflows')) out.push('workflow');
    if (has('gists')) out.push('gist');
    if (has('notifications')) out.push('notifications');
    return out;
  }
  const sc = (TK.scopes || []).filter(Boolean);
  return sc.length ? sc : ['repo', 'read:user', 'notifications', 'gist'];
}
function tkPermList() {
  const out = ['metadata=read'];
  Object.keys(TK.perms).forEach(k => {
    const lv = TK.perms[k];
    if (k !== 'metadata' && lv && lv !== 'none') out.push(k + '=' + lv);
  });
  return out;
}
function tokenUrl() {
  if (TK.type === 'classic') {
    const sc = (TK.scopes || []).filter(Boolean);
    return 'https://github.com/settings/tokens/new?description=' + encodeURIComponent(TK.desc || 'Gitly') +
      (sc.length ? '&scopes=' + sc.join(',') : '');
  }
  const q = ['name=' + encodeURIComponent(TK.name || 'Gitly')];
  if (TK.desc) q.push('description=' + encodeURIComponent(TK.desc));
  q.push('expires_in=' + (TK.exp === 'none' ? 'none' : String(TK.exp)));
  q.push('permissions=' + tkPermList().join(','));
  return 'https://github.com/settings/personal-access-tokens/new?' + q.join('&');
}
function tkPermRow(p) {
  const cur = TK.perms[p[0]] || 'none';
  return '<div class="permrow"><div class="lmain"><div class="ltitle">' + esc(p[0]) + '</div>' +
    '<div class="lsub">' + esc(p[1]) + '</div></div>' +
    '<div class="seg xs" data-permrow="' + esc(p[0]) + '">' +
    p[2].map(lv => '<button class="segb' + (cur === lv ? ' on' : '') + '" data-perm="' + esc(p[0]) + '" data-lvl="' + lv + '">' + lv + '</button>').join('') +
    '</div></div>';
}
function tkScopesHTML() {
  return '<div class="lblpick" id="tkScopes">' + AUTH_SCOPE_CHOICES.map(s =>
    '<button class="lblpickb' + ((TK.scopes || []).indexOf(s[0]) >= 0 ? ' on' : '') + '" data-tkscope="' + esc(s[0]) + '" title="' + esc(s[1]) + '">' + esc(s[0]) + '</button>').join('') + '</div>';
}
function renderTokens() {
  if (!TK) TK = tkDefault();
  const seq = ++RSEQ;
  let html = '<div class="card"><p style="margin:0;font-size:13.5px;color:var(--text2);line-height:1.6">' +
    'Gitly creates the token itself, with its own GitHub app, and hands it straight back to you. No token form, no copy-paste — GitHub only shows a one-tap approve prompt, because GitHub itself requires the account owner to approve any token.' +
    '</p></div>';
  html += '<h2 class="sect">New token</h2>';
  html += '<div class="card">' +
    '<div class="seg"><button class="segb' + (TK.type === 'app' ? ' on' : '') + '" data-tktype="app">In Gitly</button>' +
    '<button class="segb' + (TK.type === 'fine' ? ' on' : '') + '" data-tktype="fine">Fine-grained</button>' +
    '<button class="segb' + (TK.type === 'classic' ? ' on' : '') + '" data-tktype="classic">Classic</button></div>' +
    (TK.type === 'app'
      ? '<div class="lsub" style="margin-top:14px">Pick the scopes the token should carry. Gitly asks GitHub for them on your behalf.</div>'
      : '') +
    (TK.type === 'fine'
      ? '<label class="fldlabel" style="margin-top:16px">Name</label><input class="fld" id="tkName" value="' + esc(TK.name) + '" maxlength="40" autocomplete="off">'
      : '') +
    '<label class="fldlabel" style="margin-top:14px">Description</label>' +
    '<input class="fld" id="tkDesc" value="' + esc(TK.desc) + '" placeholder="What is this token for?" autocomplete="off">' +
    (TK.type === 'fine'
      ? '<label class="fldlabel" style="margin-top:14px">Expires in</label>' +
        '<div class="seg">' + [['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['none', 'No expiry']].map(e =>
          '<button class="segb' + (String(TK.exp) === e[0] ? ' on' : '') + '" data-tkexp="' + e[0] + '">' + e[1] + '</button>').join('') + '</div>'
      : '') +
    '</div>';
  html += '<h2 class="sect">' + (TK.type === 'fine' ? 'Permissions' : 'Scopes') + '</h2>';
  html += '<div class="card">' + (TK.type === 'fine'
    ? '<div class="lsub" style="margin-bottom:4px">Tap a level to switch it on; tap it again to switch it off. GitHub always includes read access to metadata.</div>' +
      FG_PERMS.map(tkPermRow).join('')
    : (TK.type === 'classic' ? '<div class="lsub" style="margin-bottom:8px">Classic scopes are broader than fine-grained permissions.</div>' : '') + tkScopesHTML()) + '</div>';
  html += '<button class="btn primary btnblock" id="tkMake" style="margin-top:14px">Create the token in Gitly</button>';
  if (TK.type !== 'app') {
    html += '<div class="lsub" style="margin-top:10px">Gitly asks GitHub for this token with the access you picked — nothing is typed on GitHub.</div>';
    html += '<button class="btn ghost btnblock" id="tkOpen" style="margin-top:8px">I specifically need a personal access token — make one on GitHub</button>';
    html += '<div class="tkprev" id="tkPrev">' + esc(tokenUrl()) + '</div>';
  }
  html += '<h2 class="sect">Gitly\'s current token</h2>';
  html += '<div class="card"><div class="lsub" style="margin-bottom:10px">The token this device is using. Gitly stores it locally, so it can show it back to you whenever you need it.</div>' +
    '<div class="tkprev" id="tkCur">' + (TOKEN ? esc(String(TOKEN).slice(0, 12) + '•'.repeat(14)) : 'not signed in') + '</div>' +
    '<div class="actionrow" style="margin-top:10px">' +
    '<button class="btn ghost" id="tkReveal" style="flex:1">' + (TOKEN ? 'Reveal' : 'Sign in first') + '</button>' +
    '<button class="btn ghost" id="tkCopyCur" style="flex:1">Copy token</button></div></div>';
  const made = madeTokens();
  if (made.length) {
    html += '<h2 class="sect">Tokens Gitly created</h2>';
    html += '<div class="card"><div class="lsub" style="margin-bottom:6px">Kept on this device. Creating a token never changes which account Gitly is signed in with.</div>' +
      made.map((t, i) => '<div class="lrow" style="padding:10px 0' + (i ? ';border-top:1px solid var(--divider)' : '') + '"><div class="lmain"><div class="ltitle" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px">' + esc(maskTok(t.token)) + '</div><div class="lsub">' + esc(String(t.scopes || '').split(/\s+/).filter(Boolean).join(', ')) + ' \u00b7 ' + esc(new Date(t.at || Date.now()).toLocaleDateString()) + '</div></div>' +
        '<div class="actionrow" style="flex:0 0 auto">' +
        '<button class="btn sm ghost" data-madecopy="' + esc(t.token) + '">Copy</button>' +
        '<button class="btn sm ghost" data-madeuse="' + esc(t.token) + '">Use</button>' +
        '<button class="btn sm ghost" data-madedel="' + esc(t.token) + '">Remove</button></div></div>').join('') + '</div>';
  }
  html += '<h2 class="sect">Use another token</h2>';
  html += '<div class="card"><div class="lsub" style="margin-bottom:10px">Made one on GitHub, or got one from somewhere else? Paste it here and Gitly will check it and sign you in with it — it is stored on this device only.</div>' +
    '<input class="fld" id="tkTok" placeholder="ghp_… or github_pat_…" autocomplete="off" spellcheck="false">' +
    '<button class="btn ghost btnblock" id="tkUse" style="margin-top:12px">Sign in with this token</button></div>';
  html += '<button class="btn ghost btnblock" style="margin-top:12px" data-act="ext" data-url="https://github.com/settings/tokens">See and revoke your tokens on GitHub</button>';
  view().innerHTML = html;

  const refresh = () => { const p = $('#tkPrev'); if (p) p.textContent = tokenUrl(); };
  $$('[data-tktype]').forEach(b => b.addEventListener('click', () => {
    TK.type = b.dataset.tktype;
    if (TK.type === 'classic' && !(TK.scopes || []).length) TK.scopes = ['read:user', 'user:email'];
    if (TK.type === 'app' && !(TK.scopes || []).length) TK.scopes = ['repo', 'read:user'];
    renderTokens();
  }));
  $$('[data-tkexp]').forEach(b => b.addEventListener('click', () => {
    TK.exp = b.dataset.tkexp === 'none' ? 'none' : parseInt(b.dataset.tkexp, 10);
    $$('[data-tkexp]').forEach(x => x.classList.toggle('on', x === b));
    refresh();
  }));
  $$('[data-perm]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.perm, lv = b.dataset.lvl;
    if (TK.perms[k] === lv) delete TK.perms[k]; else TK.perms[k] = lv;
    const row = b.closest('[data-permrow]');
    if (row) Array.from(row.querySelectorAll('[data-perm]')).forEach(x => x.classList.toggle('on', TK.perms[k] === x.dataset.lvl));
    refresh();
  }));
  $$('[data-tkscope]').forEach(b => b.addEventListener('click', () => {
    const s = b.dataset.tkscope;
    if ((TK.scopes || []).indexOf(s) >= 0) TK.scopes = TK.scopes.filter(x => x !== s);
    else TK.scopes = (TK.scopes || []).concat([s]);
    b.classList.toggle('on', TK.scopes.indexOf(s) >= 0);
    refresh();
  }));
  const nm = $('#tkName');
  if (nm) nm.addEventListener('input', () => { TK.name = nm.value; refresh(); });
  const de = $('#tkDesc');
  if (de) de.addEventListener('input', () => { TK.desc = de.value; refresh(); });
  const op = $('#tkOpen');
  if (op) op.addEventListener('click', () => {
    if (TK.type === 'fine' && !(TK.name || '').trim()) { toast('Give the token a name first'); return; }
    openExternal(tokenUrl());
  });
  const use = $('#tkUse');
  if (use) use.addEventListener('click', async () => {
    const t = ($('#tkTok').value || '').trim();
    if (!t) { toast('Paste the token first'); return; }
    use.disabled = true;
    try { await completeLogin(t); }
    catch (e) { toast('That token did not work: ' + e.message); use.disabled = false; }
  });
  const mk = $('#tkMake');
  if (mk) mk.addEventListener('click', () => {
    startOauthWithScopes(tkScopesForOauth(), true);
  });
  const rev = $('#tkReveal');
  if (rev) rev.addEventListener('click', () => {
    if (!TOKEN) { toast('Sign in first'); return; }
    const el = $('#tkCur');
    if (!el) return;
    const shown = el.dataset.shown === '1';
    el.dataset.shown = shown ? '0' : '1';
    el.textContent = shown ? String(TOKEN).slice(0, 12) + '•'.repeat(14) : TOKEN;
    rev.textContent = shown ? 'Reveal' : 'Hide';
  });
  const cc = $('#tkCopyCur');
  if (cc) cc.addEventListener('click', () => {
    if (!TOKEN) { toast('Sign in first'); return; }
    try { if (window.OneGit && window.OneGit.copy) { window.OneGit.copy(TOKEN); toast('Token copied'); return; } } catch (e) {}
    try { navigator.clipboard.writeText(TOKEN); toast('Token copied'); } catch (e) { toast('Copy not available here'); }
  });
  const tk = $('#tkTok');
  if (tk) tk.addEventListener('keydown', e => { if (e.key === 'Enter') $('#tkUse').click(); });
  $$('[data-madecopy]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.madecopy;
    try { if (window.OneGit && window.OneGit.copy) { window.OneGit.copy(t); toast('Token copied'); return; } } catch (e) {}
    try { navigator.clipboard.writeText(t); toast('Token copied'); } catch (e) { toast('Copy not available here'); }
  }));
  $$('[data-madeuse]').forEach(b => b.addEventListener('click', () => useMadeToken(b.dataset.madeuse)));
  $$('[data-madedel]').forEach(b => b.addEventListener('click', () => dropMadeToken(b.dataset.madedel)));
}

/* ---------- repository productivity ----------
   GitHub's own stats for a repo: weekly commit activity over the last year
   plus a contributor leaderboard. The stats endpoints answer 202 while GitHub
   is still computing them, so an empty reply is handled politely. */
async function renderRepoStats(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const res = await Promise.allSettled([
    api('/repos/' + full),
    api('/repos/' + full + '/stats/commit_activity'),
    api('/repos/' + full + '/stats/contributors')
  ]);
  if (seq !== RSEQ) return;
  const repo = res[0].status === 'fulfilled' ? res[0].value : null;
  const act = res[1].status === 'fulfilled' ? res[1].value : null;
  const contrib = res[2].status === 'fulfilled' ? res[2].value : null;
  if (!repo && !Array.isArray(act) && !Array.isArray(contrib)) {
    view().innerHTML = errCard(res[0].reason || res[1].reason || res[2].reason);
    return;
  }
  let html = '<div class="card"><div class="ltitle">' + esc(full) + '</div>' +
    (repo && repo.description ? '<div class="lsub" style="white-space:normal">' + esc(repo.description) + '</div>' : '') +
    (repo ? '<div class="lsub" style="margin-top:6px">' + nf(repo.stargazers_count || 0) + ' stars · ' +
      nf(repo.forks_count || 0) + ' forks · ' + nf(repo.open_issues_count || 0) + ' open issues</div>' : '') + '</div>';

  if (!Array.isArray(act) || !act.length) {
    html += '<div class="card empty">GitHub has not worked out this repository\'s activity yet.' +
      '<br><span class="dim">It computes these numbers lazily, so open this again in a moment.</span></div>';
  } else {
    const weeks = act.slice(-52);
    const total = weeks.reduce((sum, w) => sum + (w.total || 0), 0);
    let peak = weeks[0];
    weeks.forEach(w => { if ((w.total || 0) > (peak.total || 0)) peak = w; });
    const max = Math.max(1, weeks.reduce((m, w) => Math.max(m, w.total || 0), 0));
    const bars = weeks.map(w => {
      const h = Math.round(100 * (w.total || 0) / max);
      const d = new Date((w.week || 0) * 1000);
      return '<span class="wkbar" style="height:' + Math.max(3, h) + '%" title="' +
        esc(d.toDateString()) + ' · ' + (w.total || 0) + ' commits"></span>';
    }).join('');
    html += '<h2 class="sect">Commits · last 12 months</h2><div class="card">' +
      '<div class="weekbars">' + bars + '</div>' +
      '<div class="bigstats" style="margin-top:16px">' +
      '<div class="bstat"><b>' + nf(total) + '</b><span>commits this year</span></div>' +
      '<div class="bstat"><b>' + nf(peak ? peak.total : 0) + '</b><span>busiest week</span></div>' +
      '<div class="bstat"><b>' + (peak ? tAgo(new Date((peak.week || 0) * 1000).toISOString()) : '—') + '</b><span>that week</span></div>' +
      '</div></div>';
  }

  if (Array.isArray(contrib) && contrib.length) {
    const top = contrib.slice().sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 6);
    const maxc = Math.max(1, top.reduce((m, c) => Math.max(m, c.total || 0), 0));
    html += '<h2 class="sect">Contributors</h2><div class="card list">' + top.map((c, i) =>
      '<div class="lrow" style="padding:10px 0' + (i ? ';border-top:1px solid var(--divider)' : '') + '">' +
      '<img class="cav" src="' + esc((c.author && c.author.avatar_url) || '') + '" alt="" style="width:32px;height:32px;border-radius:50%;flex-shrink:0">' +
      '<div class="lmain"><div class="ltitle">' + esc((c.author && c.author.login) || 'Unknown') + '</div>' +
      '<div class="bar" style="margin-top:6px"><span style="width:' + Math.round(100 * (c.total || 0) / maxc) + '%"></span></div></div>' +
      '<span class="chip">' + nf(c.total || 0) + '</span></div>').join('') + '</div>';
  } else {
    html += '<h2 class="sect">Contributors</h2><div class="card empty">No contributor stats yet.</div>';
  }

  html += '<button class="btn ghost btnblock" style="margin-top:12px" data-go="#/repo/' + full + '">Back to the repository</button>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
}

/* ---------- repository traffic ----------
   Clones, views, referrers and most-viewed pages for ONE repository, from
   GitHub's traffic API. That data is private to whoever can push to the repo,
   so a 403 is explained rather than shown as an error. */
/* ---------- repository traffic ----------
   Clones, views, referrers and most-viewed pages for ONE repository.
   GitHub only ever hands back the last 14 days, so the app also REMEMBERS each
   day it has seen; that is what makes the weekly and monthly ranges fill in as
   time goes on. The line chart is interactive - tap a point for its value. */
let TR = { metric: 'clones', range: 'daily', full: '', clones: null, views: null, refs: null, paths: null };

function trafficHistory(full, kind, series) {
  if (!Array.isArray(series)) return;
  try {
    const key = 'tr.' + full + '.' + kind;
    const hist = LS.get(key, {}) || {};
    series.forEach(d => { hist[String(d.timestamp).slice(0, 10)] = d.count || 0; });
    const keys = Object.keys(hist).sort();
    while (keys.length > 500) delete hist[keys.shift()];
    LS.set(key, hist);
  } catch (e) { }
}
function trafficSeries(full, kind, series, range) {
  const days = {};
  try { const hist = LS.get('tr.' + full + '.' + kind, {}) || {}; Object.keys(hist).forEach(d => { days[d] = hist[d]; }); } catch (e) { }
  (series || []).forEach(d => { days[String(d.timestamp).slice(0, 10)] = d.count || 0; });
  const dates = Object.keys(days).sort();
  if (!dates.length) return [];
  if (range === 'daily') {
    return dates.slice(-14).map(d => ({ label: d.slice(5).replace('-', '/'), full: d, value: days[d] }));
  }
  const buckets = {};
  dates.forEach(d => {
    let k;
    if (range === 'weekly') {
      const t = new Date(d + 'T00:00:00Z');
      t.setUTCDate(t.getUTCDate() - t.getUTCDay());
      k = t.toISOString().slice(0, 10);
    } else { k = d.slice(0, 7); }
    buckets[k] = (buckets[k] || 0) + days[d];
  });
  const ks = Object.keys(buckets).sort();
  const keep = ks.slice(range === 'monthly' ? -6 : -12);
  return keep.map(k => ({ label: range === 'monthly' ? k : k.slice(5).replace('-', '/'), full: k, value: buckets[k] }));
}
/* an interactive line chart: gradient area, line, tappable points */
function trafficLine(series, unit) {
  const n = series.length;
  if (n < 2) {
    return '<div class="card empty">Not enough history for this range yet.<br><span class="dim">GitHub only returns the last 14 days. Gitly remembers each day it sees, so weekly and monthly fill in over time.</span></div>';
  }
  const W = 320, H = 150, padX = 14, padT = 14, padB = 22;
  const max = Math.max(1, series.reduce((m, p) => Math.max(m, p.value), 0));
  const x = i => padX + i * (W - padX * 2) / (n - 1);
  const y = v => H - padB - (v / max) * (H - padB - padT);
  const pts = series.map((p, i) => x(i).toFixed(1) + ',' + y(p.value).toFixed(1)).join(' ');
  const area = padX + ',' + (H - padB) + ' ' + pts + ' ' + (W - padX) + ',' + (H - padB);
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="tlchart">';
  svg += '<defs><linearGradient id="tlg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="var(--accent)" stop-opacity=".35"/>' +
    '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>';
  svg += '<polygon points="' + area + '" fill="url(#tlg)"/>';
  svg += '<polyline points="' + pts + '" class="tlline"/>';
  series.forEach((p, i) => {
    svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="3.2" class="tldot" data-ti="' + i + '"/>';
    svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="13" class="tlhit" data-ti="' + i + '" data-x="' +
      (100 * x(i) / W).toFixed(2) + '" data-y="' + (100 * y(p.value) / H).toFixed(2) + '" data-lbl="' + esc(p.full || p.label) + '" data-val="' + p.value + '"/>';
  });
  svg += '</svg>';
  const labels = series.map((p, i) => (i === 0 || i === n - 1 || (n <= 8) || i % Math.ceil(n / 5) === 0) ? '<span>' + esc(p.label) + '</span>' : '<span></span>').join('');
  return '<div class="tlwrap">' + svg + '<div class="tl-tip" hidden></div>' +
    '<div class="tl-x">' + labels + '</div>' +
    '<div class="tl-hint">Tap a point for its ' + esc(unit) + '</div></div>';
}

/* ---------- switching branch ---------- */
async function branchSheet(o, n) {
  const full = o + '/' + n;
  openSheet('<div class="sheethead"><b>' + esc(i18n('switchBranch')) + '</b>' +
    '<button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + spinner());
  let list = [], repo = null;
  try {
    const r = await Promise.all([
      api('/repos/' + full + '/branches?per_page=100').catch(() => []),
      api('/repos/' + full).catch(() => null)
    ]);
    list = Array.isArray(r[0]) ? r[0] : [];
    repo = r[1];
  } catch (e) { }
  const cur = branchFor(full) || ((repo && repo.default_branch) || '');
  const def = (repo && repo.default_branch) || '';
  let html = '<div class="sheethead"><b>' + esc(i18n('switchBranch')) + '</b>' +
    '<button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>';
  if (!list.length) html += '<div class="card empty">' + esc(i18n('noBranches')) + '</div>';
  else {
    html += '<div class="card list">' + list.map(b =>
      '<div class="lrow" data-br="' + esc(b.name) + '">' + SVG.branch +
      '<div class="lmain"><div class="ltitle">' + esc(b.name) + '</div>' +
      (b.name === def ? '<div class="lsub">' + esc(i18n('defaultBranch')) + '</div>' : '') + '</div>' +
      (b.name === cur ? SVG.check : '') + '</div>').join('') + '</div>';
    if (cur && cur !== def) html += '<button class="btn ghost btnblock" id="brReset" style="margin-top:12px">' + esc(i18n('backToDefault')) + ' \u00b7 ' + esc(def) + '</button>';
  }
  openSheet(html);
  $$('[data-br]').forEach(row => row.addEventListener('click', () => {
    const b = row.dataset.br;
    setBranchFor(full, b === def ? null : b);
    closeSheet(); toast(i18n('onBranch') + ' ' + b); route();
  }));
  const rs = $('#brReset');
  if (rs) rs.addEventListener('click', () => { setBranchFor(full, null); closeSheet(); toast(i18n('onBranch') + ' ' + def); route(); });
}

/* ---------- repository invitations ----------
   Someone adding you as a collaborator creates an invitation that you have to
   accept. Until now the app could send one but never accept one, so an invite
   could only be taken on github.com. Both sides are here. */
async function loadInvites() {
  const wrap = document.getElementById('inviteWrap');
  if (!wrap) return;
  let list = [];
  try { list = await api('/user/repository_invitations'); } catch (e) { return; }
  if (!Array.isArray(list) || !list.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<h2 class="sect">' + esc(i18n('invitesTitle')) + '</h2><div class="card list">' +
    list.map(iv => {
      const rp = (iv.repository && iv.repository.full_name) || '';
      const who = (iv.inviter && iv.inviter.login) || '';
      return '<div class="lrow" style="padding:14px 16px;align-items:flex-start">' +
        '<img class="cav" src="' + esc((iv.inviter && iv.inviter.avatar_url) || '') + '" alt="" style="width:34px;height:34px;border-radius:50%;flex-shrink:0">' +
        '<div class="lmain"><div class="ltitle">' + esc(rp) + '</div>' +
        '<div class="lsub">' + (who ? '@' + esc(who) + ' ' + esc(i18n('invitedYou')) : esc(i18n('invitedYou'))) + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button class="btn sm primary" data-inv="accept" data-id="' + esc(String(iv.id)) + '">' + esc(i18n('accept')) + '</button>' +
        '<button class="btn sm ghost" data-inv="decline" data-id="' + esc(String(iv.id)) + '">' + esc(i18n('decline')) + '</button>' +
        '</div></div></div>';
    }).join('') + '</div>';
  wrap.querySelectorAll('[data-inv]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id, yes = b.dataset.inv === 'accept';
    b.disabled = true;
    try {
      await api('/user/repository_invitations/' + encodeURIComponent(id),
        yes ? { method: 'PATCH' } : { method: 'DELETE' });
      toast(yes ? i18n('inviteAccepted') : i18n('inviteDeclined'));
      b.closest('.lrow').remove();
      if (!wrap.querySelector('.lrow')) wrap.innerHTML = '';
      if (yes) { dropApiMem(); }
    } catch (e) {
      toast(String((e && e.message) || 'Failed'));
      b.disabled = false;
    }
  }));
}

/* ---------- renaming a file or folder ----------
   GitHub has no folder object, so a rename goes through the Git data API: one
   tree that adds the new paths and removes the old ones, one commit, one ref
   update. A folder with fifty files still costs three requests. */
function fileMenuSheet(o, n, path, isDir) {
  const full = o + '/' + n;
  const name = path.split('/').pop();
  openSheet('<div class="sheethead"><b>' + esc(name) + '</b>' +
    '<button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="card list">' +
    '<div class="lrow" data-m="rename">' + SVG.file +
    '<div class="lmain"><div class="ltitle">' + esc(i18n('rename')) + '</div>' +
    '<div class="lsub">' + esc(i18n('renameNote')) + '</div></div></div>' +
    (!isDir ? '<div class="lrow" data-m="delete">' + SVG.trash +
      '<div class="lmain"><div class="ltitle" style="color:var(--danger,#ff5d5d)">' + esc(i18n('delete')) + '</div></div></div>' : '') +
    '</div>');
  $$('[data-m]').forEach(r => r.addEventListener('click', () => {
    const m = r.dataset.m; closeSheet();
    if (m === 'rename') renameSheet(full, path, isDir);
    else confirmDeleteFile(full, path);
  }));
}
function renameSheet(full, path, isDir) {
  const oldName = path.split('/').pop();
  const dir = path.split('/').slice(0, -1).join('/');
  const dot = isDir ? -1 : oldName.lastIndexOf('.');
  const ext = dot > 0 ? oldName.slice(dot) : '';
  const base = ext ? oldName.slice(0, -ext.length) : oldName;
  openSheet('<div class="sheethead"><b>' + esc(i18n('rename')) + '</b>' +
    '<button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub" style="margin:0 4px 10px">' + esc(isDir ? i18n('renameFolderNote') : i18n('renameFileNote')) + '</div>' +
    '<div class="fldrow"><input class="fld" id="rnBase" value="' + esc(base) + '" autocomplete="off" autocapitalize="none" spellcheck="false">' +
    (ext ? '<span class="fldext">' + esc(ext) + '</span>' : '') + '</div>' +
    '<div style="margin-top:16px">' + commitComposer('rn', 'Rename ' + oldName + ' to ' + (base + ext).trim()) + '</div>' +
    '<button class="btn primary btnblock" id="rnGo" style="margin-top:16px">' + esc(i18n('rename')) + '</button>');
  const inp = $('#rnBase');
  if (inp) { inp.focus(); try { inp.setSelectionRange(base.length, base.length); } catch (e) { } }
  const go = $('#rnGo');
  if (go) go.addEventListener('click', async () => {
    const nb = ($('#rnBase').value || '').trim();
    if (!nb) { toast(i18n('rename')); return; }
    const newName = nb + ext;
    if (newName === oldName) { toast(i18n('noChangesRename')); return; }
    go.disabled = true; go.textContent = i18n('renaming');
    try {
      await renamePath(full, path, dir ? dir + '/' + newName : newName, isDir, commitMsg('rn', 'Rename ' + oldName + ' to ' + newName));
      closeSheet(); toast(i18n('renamedTo') + ' ' + newName);
      const parts = full.split('/');
      renderFiles(parts[0], parts[1], dir);
    } catch (e) {
      toast(String((e && e.message) || 'Failed'));
      go.disabled = false; go.textContent = i18n('rename');
    }
  });
}
async function renamePath(full, oldPath, newPath, isDir, message) {
  let branch = branchFor(full);
  if (!branch) { const rp = await api('/repos/' + full); branch = (rp && rp.default_branch) || 'main'; }
  const ref = await api('/repos/' + full + '/git/ref/heads/' + encodeURIComponent(branch));
  const headSha = ref && ref.object && ref.object.sha;
  if (!headSha) throw new Error('Could not read the branch');
  const commit = await api('/repos/' + full + '/git/commits/' + headSha);
  const baseTree = commit && commit.tree && commit.tree.sha;
  if (!baseTree) throw new Error('Could not read the commit');
  const tree = [];
  if (!isDir) {
    const f = await api('/repos/' + full + '/contents/' + encodeURIComponent(oldPath).replace(/%2F/g, '/') + '?ref=' + encodeURIComponent(branch));
    if (!f || !f.sha) throw new Error('Could not read the file');
    tree.push({ path: newPath, mode: '100644', type: 'blob', sha: f.sha });
    tree.push({ path: oldPath, mode: '100644', type: 'blob', sha: null });
  } else {
    const t = await api('/repos/' + full + '/git/trees/' + baseTree + '?recursive=1');
    const prefix = oldPath.replace(/\/+$/, '') + '/';
    const inside = ((t && t.tree) || []).filter(x => x.type === 'blob' && x.path.indexOf(prefix) === 0);
    if (!inside.length) throw new Error(i18n('renameEmpty'));
    inside.forEach(x => {
      tree.push({ path: newPath + '/' + x.path.slice(prefix.length), mode: x.mode || '100644', type: 'blob', sha: x.sha });
      tree.push({ path: x.path, mode: x.mode || '100644', type: 'blob', sha: null });
    });
  }
  const made = await api('/repos/' + full + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) });
  const nc = await api('/repos/' + full + '/git/commits', { method: 'POST', body: JSON.stringify({ message: message || ('Rename ' + oldPath.split('/').pop() + ' to ' + newPath.split('/').pop()), tree: made.sha, parents: [headSha] }) });
  await api('/repos/' + full + '/git/refs/heads/' + encodeURIComponent(branch), { method: 'PATCH', body: JSON.stringify({ sha: nc.sha }) });
  dropApiMem();
  return nc.sha;
}

/* ---------- top repositories ---------- */
async function loadTopRepos() {
  const wrap = document.getElementById('topReposWrap');
  if (!wrap) return;
  let list = [];
  try { list = await api('/user/repos?sort=pushed&per_page=8&affiliation=owner,collaborator,organization_member'); } catch (e) { return; }
  if (!Array.isArray(list) || !list.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<h2 class="sect">' + esc(i18n('topRepos')) + '</h2><div class="card list">' +
    list.map((r, i) => {
      const owner = (r.owner && r.owner.login) || '';
      const av = (r.owner && r.owner.avatar_url) || '';
      return '<div class="lrow' + (i ? ' sep' : '') + '" data-go="#/repo/' + esc(r.full_name) + '">' +
        (av ? '<img class="cav" src="' + esc(av) + '" alt="">' : '<div class="cav"></div>') +
        '<div class="lmain"><div class="ltitle">' + esc(r.name) + '</div>' +
        '<div class="lsub">' + esc(owner) + (r.private ? ' \u00b7 ' + esc(i18n('repoPrivate')) : '') + '</div></div>' +
        (r.language ? '<span class="dot" style="background:' + langColor(r.language) + '"></span>' : '') +
        '</div>';
    }).join('') + '</div>';
}

/* ---------- adding people to a repository ----------
   GitHub calls these collaborators, not contributors: a contributor is simply
   whoever has committed, which nobody can be added to. Inviting someone gives
   them access to the repository, and only a repository admin may do it. The
   invite is GitHub's own, so the person still has to accept it. */
/* takes the repository, because only its own permissions say whether this
   account may invite anyone - a module-level guess at "r" is not in scope */
function canInvite(rr) {
  try { return !!(rr && rr.permissions && rr.permissions.admin); }
  catch (e) { return false; }
}
const COLLAB_PERMS = [['pull', 'push', 'triage', 'maintain', 'admin']];
function collabSheet(full) {
  const order = ['pull', 'triage', 'push', 'maintain', 'admin'];
  const rows = order.map(p =>
    '<button class="setrow collabperm' + (p === 'push' ? ' on' : '') + '" data-perm="' + p + '">' +
    '<span class="lmain"><span class="ltitle">' + esc(i18n('perm_' + p)) + '</span>' +
    '<span class="lsub">' + esc(i18n('perm_' + p + '_sub')) + '</span></span>' +
    (p === 'push' ? '<span class="chip ok">' + esc(i18n('done')) + '</span>' : '') + '</button>').join('');
  openSheet('<div class="sheethead"><b>' + esc(i18n('addCollab')) + '</b>' +
    '<button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub" style="margin:0 4px 12px;line-height:1.5">' + esc(i18n('addCollabNote')) + '</div>' +
    '<div class="searchbar" style="margin:0 0 12px">' + SVG.user +
    '<input id="collabUser" placeholder="' + esc(i18n('githubUsername')) + '" autocomplete="off" autocapitalize="none" spellcheck="false"></div>' +
    '<div class="card setlist" style="margin-bottom:12px">' + rows + '</div>' +
    '<button class="btn primary btnblock" id="collabInvite">' + esc(i18n('sendInvite')) + '</button>');
  let perm = 'push';
  $$('[data-perm]').forEach(b => b.addEventListener('click', () => {
    perm = b.dataset.perm;
    $$('[data-perm]').forEach(x => {
      x.classList.toggle('on', x === b);
      const c = x.querySelector('.chip.ok'); if (c) c.remove();
    });
    const add = document.createElement('span'); add.className = 'chip ok'; add.textContent = i18n('done'); b.appendChild(add);
  }));
  const go = $('#collabInvite');
  if (go) go.addEventListener('click', async () => {
    const u = ($('#collabUser').value || '').trim().replace(/^@/, '');
    if (!u) { toast(i18n('githubUsername')); return; }
    go.disabled = true; go.textContent = i18n('sending');
    try {
      await api('/repos/' + full + '/collaborators/' + encodeURIComponent(u), {
        method: 'PUT', body: JSON.stringify({ permission: perm })
      });
      closeSheet();
      toast('@' + u + ' ' + i18n('inviteSent'));
      /* the invitation is real; the list of people with access changes on GitHub's side */
      try { staleApiCache('/repos/' + full + '/collaborators'); } catch (e) { }
    } catch (e) {
      const raw = String((e && e.message) || '');
      /* GitHub puts the real reason in its errors[] array, and the request layer
         already merges it into the message. Replacing the whole thing with a
         guess is what made this say only "Validation Failed". */
      const detail = raw
        .replace(/^HTTP \d{3}\s*[\u2014-]?\s*/, '')
        .replace(/^Validation Failed\s*[\u2014-]?\s*/i, '')
        .trim();
      let said;
      if (/404/.test(raw)) said = i18n('noSuchUser');
      else if (/already|existing|duplicate/i.test(raw)) said = i18n('alreadyCollab');
      else if (/not allowed for this repository|permission is not allowed/i.test(detail)) said = i18n('permNotAllowed');
      else if (/403/.test(raw)) said = i18n('cannotInvite');
      else said = detail || raw;
      toast(said);
      go.disabled = false; go.textContent = i18n('sendInvite');
    }
  });
}

async function renderRepoTraffic(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  const first = TR.full !== full;
  TR.full = full;
  if (first) { TR.metric = 'clones'; TR.range = 'daily'; }
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  const res = await Promise.allSettled([
    api('/repos/' + full + '/traffic/clones'),
    api('/repos/' + full + '/traffic/views'),
    api('/repos/' + full + '/traffic/popular/referrers'),
    api('/repos/' + full + '/traffic/popular/paths')
  ]);
  if (seq !== RSEQ) return;
  TR.clones = res[0].status === 'fulfilled' ? res[0].value : null;
  TR.views = res[1].status === 'fulfilled' ? res[1].value : null;
  TR.refs = res[2].status === 'fulfilled' ? res[2].value : null;
  TR.paths = res[3].status === 'fulfilled' ? res[3].value : null;
  if (TR.clones) trafficHistory(full, 'clones', TR.clones.clones);
  if (TR.views) trafficHistory(full, 'views', TR.views.views);

  if (!TR.clones && !TR.views) {
    view().innerHTML = '<div class="card empty">Traffic is private to the repository owner.' +
      '<br><span class="dim">GitHub only shows clones and views to someone who can push to this repository.</span>' +
      '<br><button class="btn ghost btnblock" style="margin-top:14px" data-go="#/repo/' + full + '">Back to the repository</button></div>';
    return;
  }
  paintTraffic(full, o, n);
}

/* paints from the data already in TR, so switching metric or range is instant */
function paintTraffic(full, o, n) {
  const clones = TR.clones, views = TR.views;
  const metric = TR.metric, range = TR.range;
  const raw = metric === 'clones' ? (clones && clones.clones) : (views && views.views);
  const series = trafficSeries(full, metric, raw, range);
  const unit = metric === 'clones' ? 'clones' : 'views';

  const dayBars = (arr, key) => {
    const a = Array.isArray(arr) ? arr : [];
    if (!a.length) return '<div class="lsub">No daily breakdown yet.</div>';
    const max = Math.max(1, a.reduce((m, d) => Math.max(m, d[key] || 0), 0));
    return '<div class="trendwrap">' + a.map(d => {
      const h = Math.round(100 * (d[key] || 0) / max);
      const dt = new Date(d.timestamp);
      return '<div class="trendcol"><span class="trendbar" style="height:' + Math.max(4, h) + '%" data-lbl="' +
        esc(dt.toDateString()) + '" data-val="' + (d[key] || 0) + '"></span><i>' + dt.getDate() + '</i></div>';
    }).join('') + '</div>';
  };
  const rank = (items, nameOf, countOf) => {
    const arr = (items || []).slice(0, 8);
    if (!arr.length) return '<div class="card empty">Nothing recorded yet.</div>';
    const max = Math.max(1, arr.reduce((m, x) => Math.max(m, countOf(x)), 0));
    return '<div class="card">' + arr.map(x =>
      '<div class="hbar"><div class="hbar-top"><span class="hbar-lbl">' + esc(nameOf(x)) + '</span>' +
      '<span class="hbar-val">' + nf(countOf(x)) + '</span></div>' +
      '<div class="hbar-track"><span style="width:' + Math.max(2, Math.round(100 * countOf(x) / max)) + '%"></span></div>' +
      '<div class="hbar-sub">' + nf(x.uniques || 0) + ' unique</div></div>').join('') + '</div>';
  };

  let html = '<div class="card dlhero"><div class="ltitle">' + esc(full) + '</div>' +
    '<div class="lsub">Traffic from GitHub \u00b7 clones and views</div></div>';

  html += '<div class="card"><div class="bigstats">' +
    '<div class="bstat"><b>' + nf(clones ? clones.count : 0) + '</b><span>clones</span></div>' +
    '<div class="bstat"><b>' + nf(clones ? clones.uniques : 0) + '</b><span>unique cloners</span></div>' +
    '<div class="bstat"><b>' + nf(views ? views.count : 0) + '</b><span>page views</span></div>' +
    '<div class="bstat"><b>' + nf(views ? views.uniques : 0) + '</b><span>unique visitors</span></div>' +
    '</div></div>';

  html += '<h2 class="sect">Trend</h2>';
  html += '<div class="card"><div class="seg" style="margin-bottom:12px">' +
    '<button class="segb' + (metric === 'clones' ? ' on' : '') + '" data-trm="clones">Clones</button>' +
    '<button class="segb' + (metric === 'views' ? ' on' : '') + '" data-trm="views">Views</button></div>' +
    '<div class="seg sm" style="margin-bottom:14px">' +
    '<button class="segb' + (range === 'daily' ? ' on' : '') + '" data-trr="daily">Daily</button>' +
    '<button class="segb' + (range === 'weekly' ? ' on' : '') + '" data-trr="weekly">Weekly</button>' +
    '<button class="segb' + (range === 'monthly' ? ' on' : '') + '" data-trr="monthly">Monthly</button></div>' +
    trafficLine(series, unit) + '</div>';

  html += '<h2 class="sect">Clones per day</h2><div class="card">' + dayBars(clones && clones.clones, 'count') + '</div>';
  html += '<h2 class="sect">Views per day</h2><div class="card">' + dayBars(views && views.views, 'count') + '</div>';
  html += '<h2 class="sect">Where visitors came from</h2>' + rank(TR.refs, x => x.referrer, x => x.count || 0);
  html += '<h2 class="sect">Most viewed pages</h2>' + rank(TR.paths, x => x.path || x.title, x => x.count || 0);
  html += '<button class="btn ghost btnblock" style="margin-top:12px" data-go="#/repo/' + full + '">Back to the repository</button>';

  const v = view();
  v.innerHTML = html;

  $$('[data-trm]').forEach(b => b.addEventListener('click', () => { TR.metric = b.dataset.trm; paintTraffic(full, o, n); }));
  $$('[data-trr]').forEach(b => b.addEventListener('click', () => { TR.range = b.dataset.trr; paintTraffic(full, o, n); }));
  const tip = $('.tl-tip');
  $$('.tlhit').forEach(dot => dot.addEventListener('click', () => {
    if (!tip) return;
    $$('.tldot').forEach(d => d.classList.remove('on'));
    const i = Number(dot.dataset.ti);
    const d = $('.tldot[data-ti="' + i + '"]');
    if (d) d.classList.add('on');
    tip.hidden = false;
    tip.style.left = dot.dataset.x + '%';
    tip.style.top = dot.dataset.y + '%';
    tip.textContent = dot.dataset.lbl + ' \u00b7 ' + nf(Number(dot.dataset.val)) + ' ' + unit;
  }));
  $$('.trendbar').forEach(bar => bar.addEventListener('click', () => {
    if (!tip) return;
    tip.hidden = false;
    const r = bar.getBoundingClientRect(), w = bar.closest('.card').getBoundingClientRect();
    tip.style.left = ((r.left + r.width / 2 - w.left) / w.width * 100).toFixed(1) + '%';
    tip.style.top = '14%';
    tip.textContent = bar.dataset.lbl + ' \u00b7 ' + nf(Number(bar.dataset.val));
  }));
}

/* ================= router ================= */
const view = () => $('#view');
const ROUTES = [
  { re: /^#\/home$/, tab: 0, detail: false, title: () => i18n('hi') + (USER ? USER.login : 'there'), sub: () => '', render: renderHome },
  { re: /^#\/productivity$/, tab: -1, detail: true, title: () => i18n('productivity'), sub: () => i18n('subProductivity'), render: () => renderProductivity() },
  { re: /^#\/productivity\/([^\/]+)$/, tab: -1, detail: true, title: () => i18n('productivity'), sub: m => '@' + m[1] + ' · public activity', render: m => renderProductivity(m[1]) },
  { re: /^#\/repostats\/([^\/]+)\/([^\/]+)$/, tab: -1, detail: true, title: () => i18n('productivity'), sub: m => m[1] + '/' + m[2] + ' · ' + i18n('repoActivity'), render: m => renderRepoStats(m[1], m[2]) },
  { re: /^#\/activity$/, tab: -1, detail: true, title: () => i18n('activityTitle'), sub: () => i18n('subActivity'), render: renderActivity },
  { re: /^#\/repos$/, tab: 1, detail: false, title: () => i18n('repositories'), sub: () => i18n('subRepos'), render: renderRepos },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/files(\/.*)?$/, tab: 1, detail: true, title: m => m[2], sub: m => m[1] + ' / ' + m[2] + ' — files', render: m => renderFiles(m[1], m[2], (m[3] || '').replace(/^\//, '')) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/commits$/, tab: 1, detail: true, title: () => i18n('commits'), sub: m => m[1] + ' / ' + m[2], render: m => renderCommits(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/releases$/, tab: 1, detail: true, title: () => i18n('releases'), sub: m => m[1] + ' / ' + m[2], render: m => renderReleases(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/issues$/, tab: 1, detail: true, title: () => i18n('issues'), sub: m => m[1] + ' / ' + m[2], render: m => renderRepoIssues(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/pulls$/, tab: 1, detail: true, title: () => i18n('pullRequests'), sub: m => m[1] + ' / ' + m[2], render: m => renderPulls(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/actions$/, tab: 1, detail: true, title: () => i18n('actions'), sub: m => m[1] + ' / ' + m[2], render: m => renderActions(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/security$/, tab: 1, detail: true, title: () => i18n('security'), sub: m => m[1] + ' / ' + m[2], render: m => renderSecurity(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/insights$/, tab: 1, detail: true, title: () => i18n('insights'), sub: m => m[1] + ' / ' + m[2], render: m => renderInsights(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/traffic$/, tab: 1, detail: true, title: () => i18n('traffic'), sub: m => m[1] + ' / ' + m[2] + ' \u00b7 ' + i18n('clonesViews'), render: m => renderRepoTraffic(m[1], m[2]) },
  { re: /^#\/actionrun\/([^\/]+)\/([^\/]+)\/(\d+)$/, tab: 1, detail: true, title: () => i18n('workflowRun'), sub: m => m[1] + ' / ' + m[2], render: m => renderRun(m[1], m[2], +m[3]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/settings$/, tab: 1, detail: true, title: () => i18n('settings'), sub: m => m[1] + ' / ' + m[2], render: m => renderRepoSettings(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)\/hooks$/, tab: 1, detail: true, title: () => i18n('webhooks'), sub: m => m[1] + ' / ' + m[2], render: m => renderRepoHooks(m[1], m[2]) },
  { re: /^#\/repo\/([^\/]+)\/([^\/]+)$/, tab: 1, detail: true, title: m => m[2], sub: m => m[1] + ' / ' + m[2], render: m => renderRepo(m[1], m[2]) },
  { re: /^#\/commit\/([^\/]+)\/([^\/]+)\/([0-9a-fA-F]{6,40})$/, tab: -1, detail: true, title: () => i18n('commit'), sub: m => m[1] + ' / ' + m[2], render: m => renderCommit(m[1], m[2], m[3]) },
  { re: /^#\/commitfile\/([^\/]+)\/([^\/]+)\/([0-9a-fA-F]{6,40})\/(.+)$/, tab: -1, detail: true, title: m => decodeURIComponent(m[4]).split('/').pop(), sub: m => m[1] + ' / ' + m[2] + ' \u00b7 ' + m[3].slice(0, 7), render: m => renderCommitFile(m[1], m[2], m[3], decodeURIComponent(m[4])) },
  { re: /^#\/issue\/([^\/]+)\/([^\/]+)\/(\d+)$/, tab: -1, detail: true, title: m => (m[4] === 'pr' ? 'PR #' : 'Issue #') + m[3], sub: m => m[1] + ' / ' + m[2], render: m => renderIssue(m[1], m[2], +m[3]) },
  { re: /^#\/user\/([^\/]+)$/, tab: -1, detail: true, title: m => '@' + m[1], sub: () => i18n('githubProfile'), render: m => renderUser(m[1]) },
  { re: /^#\/profile\/([^\/]+)$/, tab: -1, detail: true, title: () => i18n('profileReadme'), big: m => '@' + m[1], sub: () => '', render: m => renderProfileReadme(m[1]) },
  { re: /^#\/commits$/, tab: 2, detail: false, title: () => i18n('commits'), sub: () => i18n('commitsSub'), render: renderCommitsHome },
  { re: /^#\/issues$/, tab: -1, detail: false, title: () => i18n('issues'), sub: () => i18n('subIssues'), render: renderIssues },
  { re: /^#\/users\/([^\/]+)\/repos$/, tab: -1, detail: true, title: () => i18n('repositories'), sub: m => '@' + m[1], render: m => renderUserRepos(m[1]) },
  { re: /^#\/users\/([^\/]+)\/(followers|following)$/, tab: -1, detail: true, title: m => m[2][0].toUpperCase() + m[2].slice(1), sub: m => '@' + m[1], render: m => renderUserList(m[1], m[2]) },
  { re: /^#\/user\/([^\/]+)\/gists$/, tab: -1, detail: true, title: () => i18n('gists'), sub: m => '@' + m[1], render: m => renderGists(m[1]) },
  { re: /^#\/gist\/([0-9a-f]+)$/, tab: -1, detail: true, title: () => i18n('gist'), sub: () => i18n('subGist'), render: m => renderGist(m[1]) },
  { re: /^#\/gists$/, tab: -1, detail: true, title: () => i18n('yourGists'), sub: () => i18n('subGists'), render: () => renderGists() },
  { re: /^#\/authorized$/, tab: -1, detail: true, title: () => i18n('authorizedApps'), sub: () => i18n('subAuthorized'), render: renderAuthorized },
  { re: /^#\/tokens$/, tab: -1, detail: true, title: () => i18n('personalTokens'), sub: () => i18n('subTokens'), render: renderTokens },
  { re: /^#\/settings\/([a-z]+)$/, tab: -1, detail: true, title: m => { const k = m[1] === 'github' ? 'githubAccount' : m[1]; const v = i18n(k); return v !== k ? v : (SET_TITLE[m[1]] || (m[1] === 'credits' ? 'About' : 'Settings')); }, sub: () => i18n('settings'), render: m => { SET_SEC = m[1]; STAB = (m[1] === 'credits') ? 'credits' : 'general'; renderSettings(); } },
  { re: /^#\/settings$/, tab: -1, detail: false, title: () => i18n('settings'), sub: () => i18n('settingsSub'), render: () => { SET_SEC = ''; STAB = 'general'; renderSettings(); } }
];

/* scales the big header title down so long names fit on one line
   (34px down to a 22px floor); anything longer wraps at word
   boundaries instead of breaking mid-word */
function fitBigTitle() {
  const el = $('#bigTitle');
  if (!el) return;
  el.style.fontSize = '';
  const text = el.textContent || '';
  if (!text) return;
  const w = el.clientWidth;
  if (!w) return;
  try {
    const c = fitBigTitle._m || (fitBigTitle._m = document.createElement('canvas').getContext('2d'));
    c.font = '700 34px OneGitSans, system-ui, sans-serif';
    const full = c.measureText(text).width;
    if (full <= w) return;
    el.style.fontSize = Math.max(22, Math.floor(34 * w / full)) + 'px';
  } catch (e) { }
}

/* When the hour's requests are gone the app keeps working from what it has -
   and says so, quietly, instead of leaving anyone guessing why nothing is new. */
function updateLimitBar() {
  try {
    let el = document.getElementById('limitBar');
    const on = rlActive();
    if (!on) { if (el) el.remove(); document.body.classList.remove('limited'); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'limitBar';
      el.addEventListener('click', () => { try { el.remove(); } catch (e) { } });
      document.body.appendChild(el);
    }
    const mins = Math.max(1, Math.round((RL_UNTIL - Date.now()) / 60000));
    el.innerHTML = '<b>' + (ROUTE_NOTE ? 'Switched to another stream' : 'Running on saved data') + '</b><span>Your account\u2019s hourly requests are used up \u00b7 back in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '</span>';
    try {
      el.innerHTML += '<span style="display:block;margin-top:4px;opacity:.8">Streams: ' + streamsLine() + (ROUTE_NOTE ? ' \u00b7 now via ' + ROUTE_NOTE : '') + '</span>';
    } catch (e) { }
    try {
      const top = usageTop(5);
      if (top.length) el.innerHTML += '<span style="display:block;margin-top:4px;opacity:.8">This hour: ' + top.map(t => esc(t[0]) + ' \u00d7' + t[1]).join(' \u00b7 ') + '</span>';
    } catch (e) { }
    document.body.classList.add('limited');
  } catch (e) { }
}

async function route() {
  applyTheme();
  applyA11y();
  try { applyLang(); } catch (e) { }
  try { updateLimitBar(); } catch (e) { }
  if (!TOKEN) { showLogin(); return; }
  LIVE_REFRESH = null;
  $('#login').hidden = true; $('#app').hidden = false;
  if (!USER) {
    const cu = LS.get('c.user', null);
    if (cu) {
      USER = cu;
      api('/user').then(u => {
        /* case-insensitive: GitHub logins differ only in casing, and treating
           that as a change redrew the screen we were already looking at */
        const changed = !u || String((cu && cu.login) || '').toLowerCase() !== String(u.login || '').toLowerCase();
        USER = u; LS.set('c.user', u);
        /* redraw ONLY when the account actually changed - redrawing otherwise is
           what showed up as a page refresh right after the screen appeared */
        if (changed) route();
      }).catch(() => {});
    } else {
      try { USER = await api('/user'); LS.set('c.user', USER); } catch (e) { if (!TOKEN) return; }
    }
  }
  try { if (USER) saveTokenNative(); } catch (e) {}
  const h = location.hash || '#/home';
  let matched = null, m = null;
  for (const r of ROUTES) { m = h.match(r.re); if (m) { matched = r; break; } }
  if (!matched) { location.hash = '#/home'; return; }
  $$('#navbar .navbtn').forEach(b => b.classList.toggle('active', b.dataset.tab == matched.tab));
  const title = matched.title(m);
  $('#bigTitle').textContent = matched.big ? matched.big(m) : title;
  $('#appbarTitle').textContent = title;
  fitBigTitle();
  const sub = matched.sub ? matched.sub(m) : '';
  $('#bigSub').textContent = sub; $('#bigSub').style.display = sub ? '' : 'none';
  $('#backBig').hidden = !matched.detail;
  $('#backApp').hidden = !matched.detail;
  $('#refreshBig').hidden = matched.detail;
  $('#refreshApp').hidden = matched.detail;
  $('#settingsBig').hidden = false;
  $('#settingsApp').hidden = false;
  $('#appbar').classList.remove('on');
  $('#scroller').scrollTop = 0;
  closeSheet();
  navShow();
  if (!REFRESHING && !SKIP_ENTER) enterView();
  SKIP_ENTER = false;
  view().innerHTML = spinner();
  try { await matched.render(m); } catch (e) { view().innerHTML = errCard(e); }
  /* the README arrives after the shell does - look again once it settles */
  setTimeout(updateToTop, 500);
  setTimeout(updateToTop, 1600);
}

/* ================= components ================= */
/* an avatar that cannot load is replaced by the owner's initial */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || !img.classList || !img.classList.contains('rcavimg')) return;
  const host = img.parentElement; if (!host) return;
  const initial = img.dataset.initial || '?';
  img.remove();
  if (!host.querySelector('.rcletter')) {
    const b = document.createElement('b'); b.className = 'rcletter'; b.textContent = initial; host.appendChild(b);
  }
}, true);

function repoRow(r) {
  const full = r.full_name || ((r.owner ? r.owner.login : '') + '/' + r.name);
  const owner = (r.owner && r.owner.login) || String(full).split('/')[0] || '';
  const avatar = (r.owner && r.owner.avatar_url) || '';
  const initial = esc((owner || r.name || '?').charAt(0).toUpperCase());
  return '<div class="card" data-go="#/repo/' + full + '">' +
    '<div class="rcrow">' +
    '<span class="rcavatar">' + (avatar
      ? '<img class="rcavimg" src="' + esc(avatar) + '" alt="" loading="lazy" data-initial="' + initial + '">'
      : '<b class="rcletter">' + initial + '</b>') + '</span>' +
    '<div class="rchead"><div class="rcname">' + esc(r.name) + '</div>' +
    (owner ? '<div class="rcowner">' + esc(owner) + '</div>' : '') + '</div>' +
    '<button class="pinbtn ' + (isPinned(full) ? 'pinned' : '') + '" data-pinbtn="' + esc(full) + '" aria-label="pin">' + SVG.star + '</button></div>' +
    '<p class="rcdesc">' + esc(r.description || 'No description') + '</p>' +
    '<div class="rcmeta">' + SVG.star + ' ' + nf(r.stargazers_count) + ' · ' + SVG.fork + ' ' + nf(r.forks_count) +
    (r.language ? ' · <span class="dot" style="background:' + langColor(r.language) + '"></span>' + esc(r.language) : '') +
    (r.private ? ' · <span class="chip">private</span>' : '') + '</div></div>';
}
function issueRow(i) {
  const full = i.repository_url ? i.repository_url.replace('https://api.github.com/repos/', '') : '';
  const closed = i.state !== 'open';
  const isPR = !!i.pull_request;
  return '<div class="lrow"' + (full ? ' data-go="#/issue/' + full + '/' + i.number + '"' : '') + '>' +
    '<div class="istate' + (closed ? ' closed' : '') + '">' + (closed ? SVG.check : SVG.dot) + '</div>' +
    '<div class="lmain"><div class="ltitle">' + esc(i.title) + '</div>' +
    '<div class="lsub">' + (full ? esc(full) + ' · ' : '') + '#' + i.number + ' · ' + tAgo(i.updated_at) + ' · ' + (i.comments || 0) + ' comments' +
    (isPR ? ' · <span class="chip pr">PR</span>' : '') + '</div></div></div>';
}
function commitRow(c, repoFull) {
  const full = repoFull || (c.repository_url ? c.repository_url.replace('https://api.github.com/repos/', '') : '');
  const msg = (c.commit && c.commit.message ? c.commit.message : '').split('\n')[0];
  const who = c.author ? c.author.login : (c.commit && c.commit.author ? c.commit.author.name : 'unknown');
  const av = c.author ? c.author.avatar_url : '';
  const sha = c.sha ? c.sha.slice(0, 7) : '';
  return '<div class="lrow" data-go="' + (full ? '#/commit/' + full + '/' + c.sha : '#/repos') + '"' + (full ? ' data-repo="' + esc(full) + '" data-sha="' + esc(c.sha) + '"' : '') + '>' +
    (av ? '<img class="cav" src="' + esc(av) + '" alt="">' : SVG.commit) +
    '<div class="lmain"><div class="ltitle">' + esc(msg) + '</div>' +
    '<div class="lsub">' + esc(who) + ' · ' + tAgo(c.commit && c.commit.author ? c.commit.author.date : '') + ' · <span class="chip">' + sha + '</span></div></div></div>';
}
function eventRow(ev) {
  const p = ev.payload || {};
  const repo = ev.repo ? ev.repo.name : '';
  let icon = SVG.user, cls = 'user', text = esc(ev.type || 'activity'), body = '';
  switch (ev.type) {
    case 'AtomEvent': {
      const a = p.atom || {};
      icon = SVG.dot; cls = 'atom';
      text = esc(a.title || 'activity');
      if (a.link) body = '';
      break;
    }
    case 'PushEvent':
      icon = SVG.commit; cls = 'push';
      { const n = p.size || 1;
        text = '<b>' + esc(ev.actor.login) + '</b> ' + i18n(n > 1 ? 'evPushedN' : 'evPushed1').replace('{n}', n); }
      if (p.commits && p.commits.length) {
        const msgs = p.commits.map(c => (c.message || '').split('\n')[0].trim()).filter(Boolean).slice(0, 4);
        if (msgs.length) body = msgs.map(m => esc(m)).join('<br>');
        if ((p.size || 0) > msgs.length) body += (body ? '<br>' : '') + '+' + ((p.size || 0) - msgs.length) + ' more commit' + ((p.size || 0) - msgs.length > 1 ? 's' : '');
      }
      break;
    case 'WatchEvent': icon = SVG.star; cls = 'star'; text = '<b>' + esc(ev.actor.login) + '</b> ' + i18n('evStarred'); break;
    case 'ForkEvent': icon = SVG.fork; cls = 'fork'; text = '<b>' + esc(ev.actor.login) + '</b> ' + i18n('evForked') + (p.forkee ? ' → ' + esc(p.forkee.full_name) : ''); break;
    case 'CreateEvent': icon = SVG.plus; cls = 'create'; text = '<b>' + esc(ev.actor.login) + '</b> created ' + (p.ref_type || 'repository') + (p.ref ? ' <b>' + esc(p.ref) + '</b>' : ''); break;
    case 'IssuesEvent':
      icon = SVG.dot; cls = 'issue';
      text = '<b>' + esc(ev.actor.login) + '</b> ' + (p.action || 'updated') + ' an issue';
      if (p.issue) body = esc(p.issue.title);
      break;
    case 'PullRequestEvent':
      icon = SVG.pr; cls = 'pr';
      text = '<b>' + esc(ev.actor.login) + '</b> ' + (p.action || 'updated') + ' a pull request';
      if (p.pull_request) body = esc(p.pull_request.title);
      break;
    case 'IssueCommentEvent':
      icon = SVG.comment; cls = 'comment';
      text = '<b>' + esc(ev.actor.login) + '</b> commented';
      if (p.issue) body = esc(p.issue.title);
      break;
    case 'ReleaseEvent': icon = SVG.tag; cls = 'tag'; text = '<b>' + esc(ev.actor.login) + '</b> released ' + (p.release ? '<b>' + esc(p.release.tag_name) + '</b>' : ''); break;
    case 'DeleteEvent': icon = SVG.x; cls = 'comment'; text = '<b>' + esc(ev.actor.login) + '</b> deleted ' + (p.ref_type || '') + ' ' + esc(p.ref || ''); break;
    case 'FollowEvent': icon = SVG.user; cls = 'user'; text = '<b>' + esc(ev.actor.login) + '</b> followed <b>@' + esc((p.target && p.target.login) || 'someone') + '</b>'; break;
    case 'PublicEvent': icon = SVG.plus; cls = 'create'; text = '<b>' + esc(ev.actor.login) + '</b> open-sourced this repo'; break;
    case 'GollumEvent': icon = SVG.file; cls = 'comment'; text = '<b>' + esc(ev.actor.login) + '</b> updated the wiki'; break;
    case 'MemberEvent': icon = SVG.user; cls = 'user'; text = '<b>' + esc(ev.actor.login) + '</b> added ' + (p.member ? '<b>@' + esc(p.member.login) + '</b>' : 'a collaborator'); break;
    case 'CommitCommentEvent': icon = SVG.comment; cls = 'comment'; text = '<b>' + esc(ev.actor.login) + '</b> commented on a commit'; if (p.comment) body = esc((p.comment.body || '').split('\n')[0]); break;
    default: text = '<b>' + esc(ev.actor.login) + '</b> · ' + esc(ev.type || '');
  }
  return '<div class="lrow"' + (repo ? ' data-go="#/repo/' + repo + '"' : '') + '>' +
    '<div class="eicon ' + cls + '">' + icon + '</div>' +
    '<div class="lmain"><div class="ltitle" style="font-weight:500">' + text + '</div>' +
    (body ? '<div class="lbody">' + body + '</div>' : '') +
    '<div class="lsub">' + esc(repo) + ' · ' + tAgo(ev.created_at) + '</div></div></div>';
}
function fixMd(html, repo) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe').forEach(x => x.remove());
    /* GitHub's rendered HTML keeps repo-relative image paths (./assets/x.png),
       which only resolve inside the repo - point them at the repo's raw files. */
    const imgBase = repo ? 'https://raw.githubusercontent.com/' + repo + '/HEAD/'
      : 'https://github.com/';
    const aBase = repo ? 'https://github.com/' + repo + '/blob/HEAD/'
      : 'https://github.com/';
    doc.querySelectorAll('img').forEach(x => {
      try { const s = x.getAttribute('src') || ''; if (s) x.src = new URL(s, imgBase).href; } catch (e) {}
    });
    doc.querySelectorAll('a').forEach(x => {
      try {
        const h = x.getAttribute('href') || '';
        if (h && h.charAt(0) !== '#') x.href = new URL(h, aBase).href;
        /* target="_blank" links are silently dropped by the WebView - remove
           the target so taps actually go somewhere */
        x.removeAttribute('target');
        /* in-repo file links (pdf, zip, docx, code files…) become tap-to-download rows */
        if (!repo) return;
        const m = (x.getAttribute('href') || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/HEAD\/(.+)$/);
        if (!m) return;
        const p = m[3].replace(/^\.?\//, '');
        const dot = p.lastIndexOf('.');
        const ext = dot > -1 ? p.slice(dot + 1).toLowerCase() : '';
        if (ext && MD_DL_EXTS.indexOf(' ' + ext + ' ') > -1) {
          x.setAttribute('data-act', 'apidl');
          x.setAttribute('data-owner', m[1]);
          x.setAttribute('data-repo', m[2]);
          x.setAttribute('data-path', p);
          x.setAttribute('data-name', p.split('/').pop());
        }
      } catch (e) {}
    });
    return doc.body.innerHTML;
  } catch (e) { return esc(html); }
}
/* attachments GitHub serves as downloadable links rather than rendered pages */
const MD_DL_EXTS = ' pdf txt log csv tsv json yaml yml rtf doc docx xls xlsx ppt pptx zip gz tar 7z rar c h cpp cs java js ts py php sql xml ipynb sh bat ';
/* raw.githubusercontent.com is unreachable on some networks (ISP blocks),
   which left README images broken on those devices even though the app itself
   works - so repo images are re-fetched through api.github.com, which every
   Gitly feature already depends on, and swapped in as data: URIs.
   Files over 1 MB are refused by the contents endpoint, so those go through
   the git blobs API, which serves base64 up to GitHub's 100 MB limit. */
const RAWIMG_CACHE = {};
const MD_MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', bmp:'image/bmp', ico:'image/x-icon', mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm' };
const RAWIMG_PROM = {};
/* label a data: URI correctly - trust the server unless it sends something generic */
function imgMime(ct, path) {
  const ext = ((path || '').split('?')[0].split('.').pop() || '').toLowerCase();
  const byExt = MD_MIME[ext];
  const c = (ct || '').split(';')[0].trim().toLowerCase();
  if (!c || c === 'application/octet-stream' || c === 'text/plain' || c === 'binary/octet-stream') return byExt || 'application/octet-stream';
  if (c === 'image/svg' || c === 'text/xml' || c === 'application/xml') return 'image/svg+xml';
  return c;
}
/* small images are remembered in localStorage, so re-opening a README never
   re-downloads them and animated art (the contribution snake, gifs) is not restarted */
function lsImgGet(key) { try { return LS.get('img:' + key, null); } catch (e) { return null; } }
const IMG_BUDGET = 2200000;   /* keep saved README art under ~2 MB in total */
function lsImgSet(key, data) {
  try {
    if (!data || data.length > 800000) return;      /* one huge image is not worth the space */
    let idx = LS.get('imgIdx', []) || [];
    if (idx.indexOf(key) === -1) idx.push(key);
    /* evict oldest first until the whole set fits the budget */
    let total = data.length;
    const keep = [];
    for (let i = idx.length - 1; i >= 0; i--) {
      const k = idx[i];
      if (k === key) continue;
      const v = LS.get('img:' + k, null);
      const len = (typeof v === 'string') ? v.length : 0;
      if (total + len > IMG_BUDGET || keep.length >= 40) { try { LS.del('img:' + k); } catch (e) {} continue; }
      total += len; keep.push(k);
    }
    keep.reverse();
    keep.push(key);
    LS.set('img:' + key, data); LS.set('imgIdx', keep);
  } catch (e) {}
}
async function ghRawToData(o, n, path, ref) {
  ref = ref || 'HEAD';
  path = String(path).split('#')[0].split('?')[0];
  const key = o + '/' + n + '/' + ref + '/' + path;
  if (RAWIMG_CACHE[key]) return RAWIMG_CACHE[key];
  if (RAWIMG_PROM[key]) return RAWIMG_PROM[key]; /* one fetch per image, ever */
  const saved = lsImgGet(key);
  if (saved) { RAWIMG_CACHE[key] = saved; return saved; }
  const url = 'https://api.github.com/repos/' + o + '/' + n + '/contents/' + path + '?ref=' + encodeURIComponent(ref);
  /* One attempt at the API. `auth` false is used as a second try: a public
     file must not be hidden by an expired or under-scoped token. */
  const tryApi = async (auth) => {
    const headers = { 'Accept': 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { data: 'data:' + imgMime(ct, path) + ';base64,' + btoa(bin), size: buf.length };
  };
  /* the free host first: raw.githubusercontent.com has no API budget. A private
     repository answers 404 there, and only then is the API (and its budget) used. */
  const tryRaw = async () => {
    const ru = 'https://raw.githubusercontent.com/' + o + '/' + n + '/' + encodeURIComponent(ref).replace(/%2F/g, '/') + '/' +
      path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(ru, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { data: 'data:' + imgMime(ct, path) + ';base64,' + btoa(bin), size: buf.length };
  };
  const job = (async () => {
    let got = null;
    try { got = await tryRaw(); } catch (e0) { }
    if (!got) try { got = await tryApi(true); }
    catch (e) {
      /* the token is not the reason a public file should fail */
      try { got = await tryApi(false); } catch (e2) { }
    }
    if (!got) {
      /* a slow link drops requests - one more go before giving up */
      await new Promise(r => setTimeout(r, 1600));
      try { got = await tryApi(true); } catch (e3) { }
    }
    if (got) {
      if (got.size < 8 * 1024 * 1024) { RAWIMG_CACHE[key] = got.data; lsImgSet(key, got.data); }
      return got.data;
    }
    {
      /* still nothing, or too big for the contents endpoint - the blob API's
         base64 is the last resort */
      const h2 = { 'X-GitHub-Api-Version': '2022-11-28' };
      if (TOKEN) h2.Authorization = 'Bearer ' + TOKEN;
      const meta = await fetch(url, { headers: h2, cache: 'no-store' });
      if (!meta.ok) throw new Error('HTTP ' + meta.status);
      const j = await meta.json();
      if (!j || !j.sha) throw new Error('no sha');
      const bl = await fetch('https://api.github.com/repos/' + o + '/' + n + '/git/blobs/' + j.sha, { headers: h2, cache: 'no-store' });
      if (!bl.ok) throw new Error('HTTP ' + bl.status);
      const b = await bl.json();
      if (!b || b.encoding !== 'base64' || !b.content) throw new Error('no blob content');
      const data2 = 'data:' + imgMime('', path) + ';base64,' + b.content.replace(/\s/g, '');
      if ((b.size || 0) < 8 * 1024 * 1024) { RAWIMG_CACHE[key] = data2; lsImgSet(key, data2); }
      return data2;
    }
  })();
  RAWIMG_PROM[key] = job;
  job.then(() => { delete RAWIMG_PROM[key]; }, () => { delete RAWIMG_PROM[key]; });
  return job;
}
const RAWTXT_CACHE = {};
/* The same fetch as ghRawToData, but the file's text. Used for SVGs, which have
   to be put into the page itself to keep animating. */
async function ghRawText(o, n, path, ref) {
  ref = ref || 'HEAD';
  path = String(path).split('#')[0].split('?')[0];
  const key = o + '/' + n + '/' + ref + '/' + path;
  if (RAWTXT_CACHE[key]) return RAWTXT_CACHE[key];
  const url = 'https://api.github.com/repos/' + o + '/' + n + '/contents/' + path + '?ref=' + encodeURIComponent(ref);
  const attempt = async (auth) => {
    const headers = { 'Accept': 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  };
  let text = null;
  try { text = await attempt(true); }
  catch (e) { try { text = await attempt(false); } catch (e2) { } }
  if (text === null) { await new Promise(r => setTimeout(r, 1500)); try { text = await attempt(true); } catch (e3) { } }
  if (text === null) throw new Error('svg fetch failed');
  RAWTXT_CACHE[key] = text;
  return text;
}

/* An SVG kept in an <img> is animated by the image decoder, and a compositor
   layer can skip that entirely - which is why the contribution snake sat still
   until something forced a repaint. An SVG that lives in the page is animated
   by the page itself, so it keeps moving. Anything executable is stripped
   first: a README can contain anything. */
function svgSanitize(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (!doc || !doc.documentElement || doc.querySelector('parsererror')) return null;
    if (doc.documentElement.nodeName.toLowerCase() !== 'svg') return null;
    doc.querySelectorAll('script, foreignObject, iframe, embed, object').forEach(x => x.remove());
    doc.querySelectorAll('*').forEach(el => {
      Array.prototype.slice.call(el.attributes).forEach(a => {
        const nm = a.name.toLowerCase();
        if (nm.indexOf('on') === 0) { el.removeAttribute(a.name); return; }
        if ((nm === 'href' || nm.slice(-5) === ':href') && /^\s*javascript:/i.test(a.value || '')) el.removeAttribute(a.name);
      });
    });
    return doc.documentElement.outerHTML;
  } catch (e) { return null; }
}

/* Put a repository SVG into the page in place of the <img> that referenced it. */
async function inlineSvgArt(img, owner, repo, path, ref) {
  const text = await ghRawText(owner, repo, path, ref);
  if (!text || text.length > 1200000) return false;
  const safe = svgSanitize(text);
  if (!safe) return false;
  const wrap = document.createElement('div');
  wrap.className = 'svgart';
  wrap.innerHTML = safe;
  const svg = wrap.firstElementChild;
  if (!svg) return false;
  /* let the README's own sizing and the app's CSS decide the size */
  svg.removeAttribute('height');
  svg.setAttribute('width', '100%');
  svg.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  const alt = img.getAttribute('alt');
  if (alt) svg.setAttribute('aria-label', alt);
  /* a <picture>/<source> around it would still prefer the blocked URL */
  const host = img.closest('picture') || img;
  if (host.parentNode) host.parentNode.replaceChild(wrap, host);
  return true;
}

/* turn any GitHub file URL - raw.githubusercontent.com, github.com/.../blob/...
   github.com/.../raw/... - into owner/repo/ref/path for the contents API.
   Query strings such as ?raw=true are dropped: the API rejects them, which is
   what left the contribution snake and other README art broken before. */
function ghFileFromUrl(u) {
  try {
    const url = new URL(String(u));
    let m;
    if (url.hostname === 'raw.githubusercontent.com') {
      m = url.pathname.match(/^\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
      if (m) return { owner: m[1], repo: m[2], ref: m[3], path: decodeURIComponent(m[4]) };
    } else if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      m = url.pathname.match(/^\/([^\/]+)\/([^\/]+)\/(?:blob|raw)\/([^\/]+)\/(.+)$/);
      if (m) return { owner: m[1], repo: m[2], ref: m[3], path: decodeURIComponent(m[4]) };
    }
  } catch (e) {}
  return null;
}
/* GitHub rewrites every external README image to a camo.githubusercontent.com
   proxy URL, and that host is unreachable on some networks. The hex segment of
   a camo URL is the real image URL, so unmask it and load that directly.
   Non-ASCII bytes (emoji in badge URLs!) must stay percent-encoded. */
function camoDecode(u) {
  const m = String(u).match(/^https:\/\/camo\.githubusercontent\.com\/[0-9a-f]+\/([0-9a-f]{16,})/i);
  if (!m) return '';
  const hex = m[1];
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16);
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '%' + hex.substr(i, 2).toUpperCase();
  }
  return s;
}
/* native media fallback: when the WebView cannot load an image, the app
   fetches it natively and hands back a data: URI */
const MEDIA_WAITERS = {};
window.__mediaFetched = (url, ok, dataUri) => {
  const w = MEDIA_WAITERS[url];
  if (!w) return;
  delete MEDIA_WAITERS[url];
  w.forEach(fn => fn(ok && dataUri ? dataUri : null));
};
function nativeMedia(url) {
  return new Promise((res, rej) => {
    if (!window.OneGit || !OneGit.fetchMedia) return rej(new Error('no bridge'));
    (MEDIA_WAITERS[url] = MEDIA_WAITERS[url] || []).push(d => d ? res(d) : rej(new Error('fetch failed')));
    try { OneGit.fetchMedia(url); } catch (e) { rej(e); }
  });
}
function setImgData(img, p) { p.then(data => { img.src = data; }).catch(() => {}); }
function mdImgFallback(img) {
  img.onerror = () => {
    img.onerror = null;
    const s = img.getAttribute('src') || '';
    if (!s || s.indexOf('data:') === 0) return;
    nativeMedia(s).then(d => { img.src = d; }).catch(() => {});
  };
}
/* after README/issue HTML lands in the DOM, inline every raw.githubusercontent
   image and unmask every camo one; if the fetch fails the original URL stays */
/* load an <img> from the first source that works; if they all fail the broken
   icon is replaced by a tappable link, so nothing is ever left unreadable */
function imgFallbackChain(img, sources) {
  const list = sources.filter(Boolean);
  const run = (mayRetry) => {
  let i = 0;
  const step = () => {
    if (i >= list.length) {
      /* On a slow connection a request can just be dropped. Try the whole chain
         once more before replacing the image with a link. */
      if (mayRetry) { setTimeout(() => { try { run(false); } catch (e) { } }, 2500); return; }
      markImgBroken(img, list[0]); return;
    }
    let s = list[i++];
    if (typeof s === 'function') { try { s = s(); } catch (e) { return step(); } }
    const use = d => { img.onerror = () => { img.onerror = null; step(); }; img.src = d; };
    if (s && typeof s.then === 'function') s.then(use).catch(step);
    else use(s);
  };
  step();
  };
  run(true);
}
function markImgBroken(img, url) {
  try {
    img.onerror = null;
    const alt = img.getAttribute('alt') || 'image';
    const a = document.createElement('a');
    a.className = 'imgfallback';
    a.setAttribute('data-act', 'ext');
    a.setAttribute('data-url', url || '');
    a.textContent = alt + ' — tap to open';
    if (img.parentNode) img.parentNode.replaceChild(a, img);
  } catch (e) {}
}
/* after README/issue HTML lands in the DOM, inline every repository image and
   unmask every camo one; each image is fetched once, and any that cannot be
   loaded at all becomes a link instead of a broken icon */
/* GitHub serves modern README art - the contribution snake above all - inside
   a <picture> with <source srcset> dark/light variants, and the browser picks
   the image from the SOURCE, not from <img src>. Inlining only the img left the
   browser fetching the blocked raw URL, so the snake never appeared. Every
   source is resolved too, and any that cannot be fetched is dropped so the
   <img> fallback takes over. */
function inlinePictureSources(el) {
  el.querySelectorAll('picture').forEach(pic => {
    pic.querySelectorAll('source').forEach(s => {
      if (s.dataset.gi) return;
      s.dataset.gi = '1';
      const first = (s.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
      if (!first || first.indexOf('data:') === 0) return;
      const f = ghFileFromUrl(first);
      if (!f) return;
      ghRawToData(f.owner, f.repo, f.path, f.ref)
        .then(d => { try { s.setAttribute('srcset', d); } catch (e) {} })
        .catch(() => { try { s.remove(); } catch (e) {} });
    });
  });
}
/* after README/issue HTML lands in the DOM, inline every repository image and
   unmask every camo one; each image is fetched once, and any that cannot be
   loaded at all becomes a link instead of a broken icon */
function inlineRepoImages(el) {
  if (!el || !el.querySelectorAll) return;
  inlinePictureSources(el);
  el.querySelectorAll('img').forEach(img => {
    if (img.dataset.gi) return; /* already handled - never fetch the same image twice */
    const src = img.getAttribute('src') || '';
    if (!src || src.indexOf('data:') === 0) { img.dataset.gi = '1'; return; }
    img.dataset.gi = '1';
    /* an img srcset wins over src in the browser - inline it too, or drop it
       so the src we control is what actually gets loaded */
    if (img.hasAttribute('srcset')) {
      const first = (img.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
      const fs = first ? ghFileFromUrl(first) : null;
      if (fs) ghRawToData(fs.owner, fs.repo, fs.path, fs.ref).then(d => { try { img.setAttribute('srcset', d); } catch (e) {} }).catch(() => { try { img.removeAttribute('srcset'); } catch (e) {} });
      else { try { img.removeAttribute('srcset'); } catch (e) {} }
    }
    let real = src;
    if (/^https:\/\/camo\.githubusercontent\.com\//.test(src)) {
      const dec = camoDecode(src);
      if (dec) real = dec;
    }
    const f = ghFileFromUrl(real);
    if (f) {
      /* An animated SVG (the contribution snake) must be part of the page or it
         will not keep moving - so it is inlined rather than pointed at. */
      if (/\.svg$/i.test(f.path)) {
        /* honour a dark-mode variant when the README offers one */
        let usePath = f.path, useRef = f.ref;
        try {
          const pic = img.closest('picture');
          const dark = pic && pic.querySelector('source[media*="dark"]');
          if (dark && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            const durl = (dark.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0];
            const df = durl ? ghFileFromUrl(durl) : null;
            if (df) { usePath = df.path; useRef = df.ref; }
          }
        } catch (e) { }
        inlineSvgArt(img, f.owner, f.repo, usePath, useRef)
          .then(ok => {
            if (ok) return;
            imgFallbackChain(img, [ghRawToData(f.owner, f.repo, f.path, f.ref), real, () => nativeMedia(real)]);
          })
          .catch(() => {
            imgFallbackChain(img, [ghRawToData(f.owner, f.repo, f.path, f.ref), real, () => nativeMedia(real)]);
          });
        return;
      }
      /* other repository files: the API route first (raw.githubusercontent is
         blocked on many networks), then the direct URL, then the native bridge */
      imgFallbackChain(img, [
        ghRawToData(f.owner, f.repo, f.path, f.ref),
        real,
        () => nativeMedia(real)
      ]);
      return;
    }
    if (/^https:/.test(real)) {
      imgFallbackChain(img, [real, src, () => nativeMedia(real)]);
      return;
    }
    /* repo-relative or unknown scheme: try to resolve it against the repo */
    const rel = real.replace(/^\.\//, '');
    if (el.dataset && el.dataset.repo) {
      const parts = el.dataset.repo.split('/');
      imgFallbackChain(img, [ghRawToData(parts[0], parts[1], rel, 'HEAD'), () => nativeMedia(src)]);
    }
  });
  /* embedded videos: if the WebView cannot stream one, fetch it natively */
  el.querySelectorAll('video, video source').forEach(v => {
    const s = v.getAttribute('src') || '';
    if (!s || s.indexOf('data:') === 0) return;
    v.addEventListener('error', () => {
      nativeMedia(s).then(d => { v.src = d; v.load && v.load(); }).catch(() => {});
    }, true);
  });
}
/* github.com archive URLs -> the API's zipball/tarball, which accepts a token */
function ghApiDownload(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
    let m = u.pathname.match(/^\/([^\/]+)\/([^\/]+)\/archive\/refs\/tags\/(.+)\.(zip|tar\.gz)$/);
    if (m) {
      return { url: 'https://api.github.com/repos/' + m[1] + '/' + m[2] +
        (m[4] === 'zip' ? '/zipball/' : '/tarball/') + m[3], accept: '' };
    }
    m = u.pathname.match(/^\/([^\/]+)\/([^\/]+)\/archive\/[^\/]+\.(zip|tar\.gz)$/);
    if (m) {
      return { url: 'https://api.github.com/repos/' + m[1] + '/' + m[2] +
        (m[3] === 'zip' ? '/zipball' : '/tarball'), accept: '' };
    }
  } catch (e) { }
  return null;
}

function openSheet(inner) { const s = $('#sheet'); s.innerHTML = '<div class="sheetcard">' + inner + '</div>'; s.hidden = false; document.body.classList.add('sheetopen'); }
function closeSheet() { const s = $('#sheet'); if (s) { s.hidden = true; s.innerHTML = ''; } document.body.classList.remove('sheetopen'); }

/* ================= views: home ================= */
/* ================= views: productivity ================= */
function heatLevel(c) { return c === 0 ? 0 : c < 3 ? 1 : c < 7 ? 2 : c < 12 ? 3 : 4; }
function prodHtml(cc) {
  const cal = cc.contributionCalendar;
  const days = [];
  cal.weeks.forEach(w => w.contributionDays.forEach(d => days.push(d)));
  const byDate = {};
  days.forEach(d => byDate[d.date] = d.contributionCount);
  const dStr = off => { const t = new Date(); t.setDate(t.getDate() - off); return t.toISOString().slice(0, 10); };
  const sumLast = n => { let s = 0; for (let i = 0; i < n; i++) s += (byDate[dStr(i)] || 0); return s; };
  const week = sumLast(7), month = sumLast(30);
  let i = days.length - 1;
  while (i >= 0 && days[i].contributionCount === 0) i--;
  let cur = 0;
  while (i >= 0 && days[i].contributionCount > 0) { cur++; i--; }
  let best = 0, run = 0, bd = null;
  days.forEach(d => {
    if (d.contributionCount > 0) { run++; if (run > best) best = run; } else run = 0;
    if (!bd || d.contributionCount > bd.contributionCount) bd = d;
  });
  const avg = days.length ? cal.totalContributions / days.length : 0;
  let graph = '<div class="heatwrap">';
  cal.weeks.forEach(w => {
    graph += '<div class="heatcol">' + w.contributionDays.map(d =>
      '<span class="heatcell l' + heatLevel(d.contributionCount) + '" title="' + d.date + ' · ' + d.contributionCount + ' contributions"></span>').join('') + '</div>';
  });
  graph += '</div>';
  const legend = '<div class="lgdrow" style="margin-top:12px;align-items:center">Less ' +
    [0, 1, 2, 3, 4].map(l => '<span class="heatcell l' + l + '" style="display:inline-block"></span>').join('') + ' More</div>';
  const repos = (cc.commitContributionsByRepository || []).slice()
    .sort((a, b) => b.contributions.totalCount - a.contributions.totalCount).slice(0, 5);
  let html = '<div class="card"><div class="ltitle" style="margin-bottom:10px">Contribution graph · last 12 months</div>' + graph + legend + '</div>';
  html += activityRadar(cc);
  html += '<h2 class="sect">Right now</h2><div class="card"><div class="bigstats">' +
    '<div class="bstat"><b>' + nf(week) + '</b><span>this week</span></div>' +
    '<div class="bstat"><b>' + nf(month) + '</b><span>this month</span></div>' +
    '<div class="bstat"><b>' + cur + 'd</b><span>current streak</span></div>' +
    '<div class="bstat"><b>' + best + 'd</b><span>longest streak</span></div>' +
    '<div class="bstat"><b>' + avg.toFixed(1) + '</b><span>daily average</span></div>' +
    '<div class="bstat"><b>' + nf(bd ? bd.contributionCount : 0) + '</b><span>busiest day</span></div></div></div>';
  html += '<h2 class="sect">This year on GitHub</h2><div class="card"><div class="bigstats">' +
    '<div class="bstat"><b>' + nf(cc.totalCommitContributions) + '</b><span>commits made</span></div>' +
    '<div class="bstat"><b>' + nf(cc.totalPullRequestContributions) + '</b><span>pull requests</span></div>' +
    '<div class="bstat"><b>' + nf(cc.totalIssueContributions) + '</b><span>' + esc(i18n('issuesLabel')) + '</span></div>' +
    '<div class="bstat"><b>' + nf(cc.totalPullRequestReviewContributions) + '</b><span>reviews</span></div>' +
    '<div class="bstat"><b>' + nf(cc.totalRepositoryContributions) + '</b><span>new repos</span></div>' +
    '<div class="bstat"><b>' + nf(cal.totalContributions) + '</b><span>contributions</span></div></div></div>';
  html += '<h2 class="sect">Most active repositories</h2>';
  html += repos.length ? '<div class="card list">' + repos.map(r =>
    '<div class="lrow" data-go="#/repo/' + esc(r.repository.nameWithOwner) + '">' + SVG.code +
    '<div class="lmain"><div class="ltitle">' + esc(r.repository.nameWithOwner) + '</div>' +
    '<div class="lsub">' + nf(r.contributions.totalCount) + ' commits this year</div></div></div>').join('') + '</div>' :
    '<div class="card empty">No repository activity yet.</div>';
  return html;
}
/* GitHub's "Activity overview" - a four-axis chart of what your contributions
   were actually made of: commits, pull requests, code review and issues, each
   plotted as its share of the total. Same numbers as the "This year on GitHub"
   card below it, drawn the way github.com draws them. */
function activityRadar(cc) {
  const cats = [
    { v: cc.totalCommitContributions, label: 'Commits', color: '#12B76A' },
    { v: cc.totalPullRequestContributions, label: 'Pull requests', color: '#8B5CF6' },
    { v: cc.totalPullRequestReviewContributions, label: 'Code review', color: '#F59E0B' },
    { v: cc.totalIssueContributions, label: 'Issues', color: '#1B6EF3' }
  ];
  const vals = cats.map(c => Math.max(0, Number(c.v) || 0));
  const total = vals.reduce((a, b) => a + b, 0);
  const pct = vals.map(v => total ? Math.round(100 * v / total) : 0);
  const W = 320, H = 232, cx = W / 2, cy = H / 2 + 4, R = 72;
  /* commits to the left, issues right, code review up, pull requests down */
  const px = [
    [cx - R * pct[0] / 100, cy],
    [cx + R * pct[3] / 100, cy],
    [cx, cy - R * pct[2] / 100],
    [cx, cy + R * pct[1] / 100]
  ];
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="radar" role="img" aria-label="Activity overview">';
  svg += '<line x1="' + cx + '" y1="' + (cy - R) + '" x2="' + cx + '" y2="' + (cy + R) + '" class="radaraxis"/>';
  svg += '<line x1="' + (cx - R) + '" y1="' + cy + '" x2="' + (cx + R) + '" y2="' + cy + '" class="radaraxis"/>';
  svg += '<polygon points="' + px.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '" class="radararea"/>';
  px.forEach((p, i) => {
    svg += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.4" fill="' + cats[i].color + '"/>';
  });
  svg += '<text x="' + (cx - R - 10) + '" y="' + (cy + 4) + '" class="radarlabel end">Commits ' + pct[0] + '%</text>';
  svg += '<text x="' + (cx + R + 10) + '" y="' + (cy + 4) + '" class="radarlabel">Issues ' + pct[3] + '%</text>';
  svg += '<text x="' + cx + '" y="' + (cy - R - 10) + '" class="radarlabel mid">Code review ' + pct[2] + '%</text>';
  svg += '<text x="' + cx + '" y="' + (cy + R + 20) + '" class="radarlabel mid">Pull requests ' + pct[1] + '%</text>';
  svg += '</svg>';
  const legend = cats.map((c, i) =>
    '<div class="lgdrow" style="align-items:center;justify-content:space-between;padding:7px 0">' +
    '<div class="lgdrow" style="align-items:center"><span class="dot" style="background:' + c.color + '"></span>' +
    '<span style="margin-left:8px;font-size:13px">' + c.label + '</span></div>' +
    '<div class="lsub">' + pct[i] + '% · ' + nf(vals[i]) + '</div></div>').join('');
  return '<h2 class="sect">Activity overview</h2><div class="card">' +
    (total ? svg + '<div style="margin-top:4px">' + legend + '</div>'
           : '<div class="empty" style="padding:10px 0">No contributions in the last year yet.</div>') + '</div>';
}
/* Productivity for you, or for any other user when a login is passed in.
   GitHub exposes the same contributions collection on the User type, so the
   only difference is the query: viewer{} for yourself, user(login:) for someone
   else. Their numbers are public contributions only. */
/* GraphQL POSTs can never be a free 304 check, so every one is paid. These screens
   therefore show what is saved and ask again only when it is older than a few
   minutes (a hand refresh waits at least a minute). The stamp is per account. */
const GQL_AUTO_MS = 5 * 60000, GQL_MANUAL_MS = 60000;
function gqlFreshKey(k) { return k + '.at'; }
/* Drop what the screens saved and their "fetched at" stamps, so everything is
   read again from GitHub. The activity history (onegit.c.hist) and the offline
   copy are deliberately kept - they are the safety net, not a cache. */
function clearFetchedForAccount() {
  try {
    const kill = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf('onegit.') !== 0) continue;
      const short = k.slice(7);
      if (short.indexOf('c:' + (ACCT || '') + ':') === 0) { kill.push(k); continue; }
      if (short.slice(-3) === '.at') { kill.push(k); continue; }
    }
    kill.forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
    dropApiMem();
    try { for (const k in API_INFLIGHT) delete API_INFLIGHT[k]; } catch (e) { }
  } catch (e) { }
}
function gqlRecent(k, hasSaved) {
  /* A refresh the user asked for always goes to the network - the old window
     meant tapping refresh within a minute did nothing at all. */
  if (FORCE_FRESH) return false;
  if (!hasSaved) return false;
  const m = LS.get(gqlFreshKey(k), null);
  if (!m || m.a !== (ACCT || '')) return false;
  return Date.now() - (m.t || 0) < (FORCE_FRESH ? GQL_MANUAL_MS : GQL_AUTO_MS);
}
function gqlStamp(k) { LS.set(gqlFreshKey(k), { t: Date.now(), a: ACCT || '' }); }
const DAY_MEM = {};
async function renderProductivity(login) {
  const seq = ++RSEQ;
  const who = login || '';
  const isMe = !who || (USER && who.toLowerCase() === USER.login.toLowerCase());
  PROD_USER = isMe ? '' : who;
  const key = isMe ? 'c.prod' : ('c.prod.' + who.toLowerCase());
  if (!PDATE) PDATE = todayStr();
  const cached = LS.get(key, null);
  const paint = cc => {
    let html = '';
    if (!isMe) html += '<div class="lsub" style="margin:0 4px 10px">@' + esc(who) + ' · public activity only</div>';
    html += '<div class="seg" style="margin-bottom:16px"><button class="segb' + (PTAB === 'overview' ? ' on' : '') + '" data-pt="overview">Overview</button><button class="segb' + (PTAB === 'today' ? ' on' : '') + '" data-pt="today">Today</button></div>';
    html += PTAB === 'today' ? todayHtml(cc) : (cc ? prodHtml(cc) : spinner());
    if (seq !== RSEQ) return;
    view().innerHTML = html;
    $$('[data-pt]').forEach(b => b.addEventListener('click', () => { PTAB = b.dataset.pt; renderProductivity(login); }));
    wireDayPicker();
  };
  paint(cached);
  if (gqlRecent(key, !!(cached && cached.contributionCalendar))) { if (PTAB === 'today') loadDay(); return; }
  const fields = 'contributionsCollection{totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions totalRepositoryContributions commitContributionsByRepository(maxRepositories:10){contributions{totalCount} repository{nameWithOwner stargazerCount}} contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}';
  const query = isMe
    ? ('query{viewer{login ' + fields + '}}')
    : ('query($login:String!){user(login:$login){login ' + fields + '}}');
  try {
    const r = await api('/graphql', { method: 'POST', body: JSON.stringify(isMe ? { query } : { query, variables: { login: who } }) });
    if (r && r.errors && r.errors.length) throw new Error(r.errors[0].message || 'Could not load activity');
    const node = r && r.data && (isMe ? r.data.viewer : r.data.user);
    const cc = node && node.contributionsCollection;
    if (!cc) throw new Error(isMe ? 'No stats returned' : ('No public activity for @' + who));
    LS.set(key, cc);
    gqlStamp(key);
    paint(cc);
    if (isMe) widgetPush(true);
  } catch (e) {
    if (seq !== RSEQ) return;
    if (!cached) {
      const msg = String((e && e.message) || '');
      if (!isMe && /could not resolve to a user|not found|does not exist/i.test(msg)) {
        /* a name that isn't a GitHub user - say so plainly instead of the raw API error */
        view().innerHTML = '<div class="card empty">No GitHub user called <b>@' + esc(who) + '</b>.' +
          '<br><span class="dim">Check the spelling, or look at your own activity instead.</span>' +
          '<br><button class="btn primary btnblock" style="margin-top:14px" data-go="#/productivity">Show my productivity</button></div>';
      } else {
        view().innerHTML = errCard(e);
      }
    }
  }
  if (PTAB === 'today') loadDay();
}

/* ---- Today tab: stats for a particular day ---- */
let PTAB = 'overview', PDATE = '', PROD_USER = '';
function todayStr() { return new Date().toISOString().slice(0, 10); }
function todayHtml(cc) {
  const isToday = PDATE === todayStr();
  let cnt = 0, last7 = [];
  if (cc && cc.contributionCalendar) {
    const byDate = {};
    cc.contributionCalendar.weeks.forEach(w => w.contributionDays.forEach(x => byDate[x.date] = x.contributionCount));
    cnt = byDate[PDATE] || 0;
    for (let i = 6; i >= 0; i--) {
      const t = new Date(); t.setDate(t.getDate() - i);
      const ds = t.toISOString().slice(0, 10);
      last7.push({ ds, c: byDate[ds] || 0, wd: 'SMTWTFS'.charAt(t.getDay()) });
    }
  }
  const max = Math.max.apply(null, last7.map(x => x.c).concat([1]));
  const d = new Date(PDATE + 'T00:00:00');
  return '<div class="card" style="text-align:center;padding:24px 20px">' +
    '<div class="lsub">' + (isToday ? 'Today · ' : '') + d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '</div>' +
    '<div style="font-size:52px;font-weight:800;letter-spacing:-1px;margin:6px 0 2px">' + nf(cnt) + '</div>' +
    '<div class="lsub">contributions</div></div>' +
    '<div class="card"><div class="ltitle" style="margin-bottom:6px">Last 7 days — tap a bar</div>' +
    '<div class="daybars">' + last7.map(x =>
      '<div class="daybar' + (x.ds === PDATE ? ' cur' : '') + '" data-day="' + x.ds + '"><span style="height:' + Math.max(6, Math.round(x.c / max * 76)) + 'px"></span><i>' + x.wd + '</i></div>').join('') + '</div></div>' +
    '<div class="card"><div class="ltitle" style="margin-bottom:8px">Pick a day</div>' +
    '<div style="display:flex;gap:8px"><input type="date" class="fld" id="dayPick" value="' + PDATE + '" style="flex:1">' +
    '<button class="btn ghost" id="todayBtn">Today</button></div></div>' +
    '<h2 class="sect">That day</h2><div class="card" id="dayDetail">' + spinner(true) + '</div>';
}
function wireDayPicker() {
  const again = () => renderProductivity(PROD_USER || undefined);
  const dp = $('#dayPick');
  if (dp) dp.addEventListener('change', () => { PDATE = dp.value || todayStr(); again(); });
  const tb = $('#todayBtn');
  if (tb) tb.addEventListener('click', () => { PDATE = todayStr(); again(); });
  $$('[data-day]').forEach(b => b.addEventListener('click', () => { PDATE = b.dataset.day; again(); }));
}
async function loadDay() {
  const seq = ++RSEQ;
  const el = $('#dayDetail'); if (!el) return;
  const dayFields = 'contributionsCollection(from:$from,to:$to){totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions commitContributionsByRepository(maxRepositories:10){contributions{totalCount} repository{nameWithOwner}}}';
  const q = PROD_USER
    ? ('query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){' + dayFields + '}}')
    : ('query($from:DateTime!,$to:DateTime!){viewer{' + dayFields + '}}');
  const vars = { from: PDATE + 'T00:00:00Z', to: PDATE + 'T23:59:59Z' };
  if (PROD_USER) vars.login = PROD_USER;
  try {
    /* a day already looked at is not asked for again: today's numbers for 5 minutes,
       a finished day for an hour */
    const dkey = (ACCT || '') + '|' + (PROD_USER || '') + '|' + PDATE;
    const dm = DAY_MEM[dkey];
    let cc;
    if (dm && Date.now() - dm.t < (PDATE === todayStr() ? GQL_AUTO_MS : 3600000)) cc = dm.cc;
    else {
      const r = await api('/graphql', { method: 'POST', body: JSON.stringify({ query: q, variables: vars }) });
      const node = r && r.data && (PROD_USER ? r.data.user : r.data.viewer);
      cc = node && node.contributionsCollection;
      if (cc) DAY_MEM[dkey] = { t: Date.now(), cc };
    }
    if (!cc) throw new Error('No data');
    const repos = (cc.commitContributionsByRepository || []).filter(x => x.contributions.totalCount > 0);
    if (seq !== RSEQ) return;
    el.innerHTML = '<div class="bigstats">' +
      '<div class="bstat"><b>' + nf(cc.totalCommitContributions) + '</b><span>commits</span></div>' +
      '<div class="bstat"><b>' + nf(cc.totalPullRequestContributions) + '</b><span>pull requests</span></div>' +
      '<div class="bstat"><b>' + nf(cc.totalIssueContributions) + '</b><span>' + esc(i18n('issuesLabel')) + '</span></div>' +
      '<div class="bstat"><b>' + nf(cc.totalPullRequestReviewContributions) + '</b><span>reviews</span></div></div>' +
      (repos.length ? '<div class="ltitle" style="margin:16px 0 4px">Worked on</div><div class="list">' + repos.map(x =>
        '<div class="lrow" data-go="#/repo/' + esc(x.repository.nameWithOwner) + '">' + SVG.code +
        '<div class="lmain"><div class="ltitle">' + esc(x.repository.nameWithOwner) + '</div>' +
        '<div class="lsub">' + x.contributions.totalCount + ' commit' + (x.contributions.totalCount > 1 ? 's' : '') + '</div></div></div>').join('') + '</div>' :
        '<div class="lsub dim" style="margin-top:10px">No repository commits that day.</div>');
  } catch (e) { if (seq !== RSEQ) return; el.innerHTML = '<div class="lsub dim">Could not load the details for this day.</div>'; }
}

/* ================= activity history (persistent, never cleared) ================= */
/* ---------- saved (offline) data: how long it counts as current ----------
   Every reply the app receives is saved on the device. While that saved data
   is still recent it is shown exactly as it is: opening the app, or switching
   back to a tab, must NOT start another sync of the same thing. That repeated
   syncing is what made the app look like it was reloading itself. */
/* Whether the user has asked for fresh data right now. */
let FORCE_FRESH = false;
/* Throws away the saved replies (not the saved activity) - used after a write,
   because a write changes what the saved replies say. */
/* One silent request that only updates what is saved on the device. Nothing on
   screen moves when it lands, so the screen you are looking at stays put. */
const BG_BUSY = {};
const BG_LAST = {};
function bgRefresh(path, opts) {
  const key = path + (opts.status ? '|st' : '');
  if (BG_BUSY[key]) return;
  /* the same reply is not chased twice inside a minute: a screen that redraws
     must not become a stream of requests, which is how an hour's budget goes */
  const nowMs = Date.now();
  if (BG_LAST[key] && nowMs - BG_LAST[key] < 300000) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  BG_LAST[key] = nowMs;
  BG_BUSY[key] = 1;
  const o = { _bg: 1 };
  for (const k in opts) o[k] = opts[k];
  apiOnce(path, o).catch(() => { }).then(() => { delete BG_BUSY[key]; });
}
/* A write changes things, but the reply already saved is still the best thing
   to show. Dropping its tag means the next ask gets fresh data (and a 304 costs
   nothing); dropping the reply itself would leave the screen with nothing. */
function staleApiCache(writePath) {
  try {
    const match = staleMatcher(writePath);
    Object.keys(localStorage).filter(k => k.indexOf('onegit.c:') === 0).forEach(k => {
      try {
        if (!match(k)) return;
        const v = JSON.parse(localStorage.getItem(k));
        if (v && typeof v === 'object' && 'etag' in v) { v.etag = ''; v.stale = 1; const str = JSON.stringify(v); localStorage.setItem(k, str); t2Put(k, str); }
      } catch (e) { }
    });
    /* replies that only live in the second tier need the same mark */
    Object.keys(T2.mem).forEach(k => {
      try {
        if (!match(k)) return;
        const v = JSON.parse(T2.mem[k]);
        if (v && typeof v === 'object' && 'etag' in v) { v.etag = ''; v.stale = 1; const str = JSON.stringify(v); T2.mem[k] = str; t2Put(k, str); }
      } catch (e) { }
    });
  } catch (e) { }
}
/* Which saved replies can a write change? Only those get their tag dropped (and so
   a paid refetch next time); every other saved reply keeps its tag and stays a
   free 304 check. A write to a path this does not recognise drops them all, as
   before, so nothing is ever left showing old data because of a missed rule. */
function staleMatcher(writePath) {
  const all = () => true;
  if (!writePath) return all;
  const wp = String(writePath).split('?')[0].toLowerCase();
  const pathOf = k => { const i = k.indexOf('/'); return i < 0 ? '' : k.slice(i).split('\u0000')[0].split('?')[0].toLowerCase(); };
  const under = (p, base) => p === base || p.indexOf(base + '/') === 0;
  /* lists that show data from many repositories or people */
  const lists = p => under(p, '/user/repos') || under(p, '/user/starred') || under(p, '/user/subscriptions') ||
    under(p, '/notifications') || under(p, '/search') || under(p, '/issues') || under(p, '/user/issues') ||
    /^\/users\/[^\/]+\/(repos|events|received_events|starred|subscriptions)(\/|$)/.test(p);
  const rm = wp.match(/^\/repos\/([^\/]+\/[^\/]+)/);
  if (rm) {
    const base = '/repos/' + rm[1];
    return k => { const p = pathOf(k); return under(p, base) || lists(p); };
  }
  if (under(wp, '/notifications')) return k => under(pathOf(k), '/notifications');
  if (under(wp, '/user/starred')) {
    const sm = wp.match(/^\/user\/starred\/([^\/]+\/[^\/]+)/);
    const base = sm ? '/repos/' + sm[1] : null;
    return k => { const p = pathOf(k); return under(p, '/user/starred') || lists(p) || (base && under(p, base)); };
  }
  if (under(wp, '/user/following')) return k => { const p = pathOf(k); return under(p, '/user/following') || p === '/user' || p.indexOf('/users/') === 0; };
  if (wp === '/user') return k => { const p = pathOf(k); return p === '/user' || p.indexOf('/users/') === 0; };
  if (under(wp, '/user/keys')) return k => under(pathOf(k), '/user/keys');
  if (under(wp, '/gists')) return k => under(pathOf(k), '/gists') || under(pathOf(k), '/users');
  if (wp === '/user/repos') return k => { const p = pathOf(k); return lists(p) || p === '/user'; };
  return all;
}
function dropApiCache() {
  try {
    Object.keys(localStorage).filter(k => k.indexOf('onegit.c:') === 0)
      .forEach(k => { try { localStorage.removeItem(k); } catch (e) { } });
    Object.keys(T2.mem).forEach(k => delete T2.mem[k]);
    try { if (T2.db) T2.db.transaction('c', 'readwrite').objectStore('c').clear(); T2.q = {}; } catch (e) { }
  } catch (e) { }
}
/* The saved activity, from the most durable copy first. */
function savedHistory() {
  try {
    const a = LS.get('c.hist', null);      if (Array.isArray(a) && a.length) return a;
    const b = LS.get('offline.feed', null); if (Array.isArray(b) && b.length) return b;
    const c = LS.get('c.feed', null);       if (Array.isArray(c) && c.length) return c;
  } catch (e) { }
  return [];
}
function mergeHist(evs) {
  const old = savedHistory();
  const map = new Map();
  old.forEach(e => { if (e && e.id) map.set(e.id, e); });
  (evs || []).forEach(e => { if (e && e.id) map.set(e.id, e); });
  const merged = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  LS.set('c.hist', merged.slice(0, 300));
  /* A second copy under a key no cache-clearing path touches ('offline.' is
     neither 'c:' nor 'c.'), so the saved activity survives even a wipe of the
     cache - the feed can always be painted from the device. */
  LS.set('offline.feed', merged.slice(0, 60));
  return merged.slice(0, 300);
}
/* A feed entry, turned into the same shape the activity rows already use, so
   the feed renders through the existing code. */
function atomToEvent(e, login) {
  return {
    id: 'atom:' + (e.link || e.title || e.updated),
    type: 'AtomEvent',
    created_at: e.updated,
    repo: { name: '' },
    actor: { login: e.author || login },
    payload: { atom: { title: e.title || '', link: e.link || '', summary: e.summary || '' } }
  };
}

async function refreshActivity(login) {
  /* fresh: the feed is the one thing that updates live - it must not be served
     from what is saved, or new activity would only appear on a later visit */
  const own = await api('/users/' + login + '/events?per_page=100', { fresh: true, etag: true }).catch(() => null);
  const rec = await api('/users/' + login + '/received_events?per_page=50', { fresh: true, etag: true }).catch(() => null);
  if (own !== null || rec !== null) {
    return mergeHist((Array.isArray(own) ? own : []).concat(Array.isArray(rec) ? rec : []));
  }
  /* The API is out of budget or we are offline. GitHub's own activity feed is
     served by github.com rather than api.github.com, so it costs nothing - the
     feed keeps showing live activity instead of going blank. */
  try {
    const items = await atomFeed(feedForUser(login));
    if (items.length) {
      FEED_FALLBACK = true;
      return mergeHist(items.map(e => atomToEvent(e, login)));
    }
  } catch (e) { }
  /* nothing live at all: keep what is already saved rather than showing nothing */
  return mergeHist([]);
}

async function renderHome() {
  const seq = ++RSEQ;
  checkUpdate();
  const u = USER || await api('/user');
  let html = '<div class="card profile" data-go="' + specialRepoGo(u.login) + '">' + acctBtnHTML() + '<button class="pavalert iss" data-go="#/issues" aria-label="Issues"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></button><img class="pav" src="' + esc(u.avatar_url) + '" alt="">' +
    '<div class="pname">' + esc(u.name || u.login) + '</div>' +
    '<div class="plogin" data-go="#/user/' + esc(u.login) + '">@' + esc(u.login) + '</div>' +
    (u.bio ? '<p class="pbio">' + esc(u.bio) + '</p>' : '') +
    '<div class="pstats">' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/repos"><b>' + nf(u.public_repos) + '</b><span>' + esc(i18n('reposLabel')) + '</span></div>' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/followers"><b>' + nf(u.followers) + '</b><span>' + esc(i18n('followersLabel')) + '</span></div>' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/following"><b>' + nf(u.following) + '</b><span>' + esc(i18n('followingLabel')) + '</span></div></div></div>';
  html += '<div class="card quicklinks"><button class="btn ghost" data-go="#/productivity">' + esc(i18n('productivity')) + '</button><button class="btn ghost" data-act="discover">' + esc(i18n('discover')) + '</button><button class="btn ghost" data-go="#/user/' + esc(u.login) + '">' + esc(i18n('myProfile')) + '</button></div>';
  html += '<div id="inviteWrap"></div>';
  html += '<div id="topReposWrap"></div>';
  /* the Pinned repositories section is gone from the home screen - starring
     still pins and pins still sync, they just are not shown here */
  const feedHtml = evs => (evs.length ? '<div class="card list">' + evs.slice(0, 3).map(eventRow).join('') + '</div>' : '<div class="card empty">' + esc(i18n('nothingYet')) + '</div>') +
    '<button class="btn ghost btnblock" style="margin-top:12px" id="allActBtn">' + esc(i18n('viewAllActivity')) + '</button>';
  const cHist = savedHistory();
  html += '<h2 class="sect">' + esc(i18n('recentActivity')) + '</h2>';
  if (FEED_FALLBACK) html += feedNoteHTML();
  html += '<div id="feedWrap">' + (cHist.length ? feedHtml(cHist) : spinner()) + '</div>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  /* repository invitations: filled in after the screen is up, so the home page
     never waits on it */
  loadInvites();
  loadTopRepos();
  LIVE_REFRESH = () => refreshFeedInsert();
  checkSpecialRepo(u.login);
  const wireAct = () => { const nb = $('#allActBtn'); if (nb) nb.addEventListener('click', () => location.hash = '#/activity'); };
  wireAct();
  try {
    {
      const merged = await refreshActivity(u.login);
      const fw = $('#feedWrap');
      if (fw && seq === RSEQ) {
        const list = fw.querySelector('.card.list');
        if (list && list.querySelector('.lrow')) {
          if (prependNewRows(list, merged, evKey, eventRow, 6)) refreshPulse();
        } else {
          fw.innerHTML = (FEED_FALLBACK ? feedNoteHTML() : '') + feedHtml(merged);
          settleRows(fw); markNewRows(fw, 'feed'); seedLive('feed', merged.map(evKey));
        }
      }
    }
    wireAct();
  } catch (e) { if (seq !== RSEQ) return; if (!cHist.length) { const fw = $('#feedWrap'); if (fw) fw.innerHTML = errCard(e); } }
}

async function renderActivity() {
  const seq = ++RSEQ;
  const u = USER || await api('/user');
  const cHist = savedHistory();
  if (seq !== RSEQ) return;
  view().innerHTML = cHist.length ? '<div class="card list">' + cHist.map(eventRow).join('') + '</div>' : spinner();
  markNewRows(view(), 'activity');
  seedLive('activity', cHist.map(evKey));
  LIVE_REFRESH = () => refreshActivityInsert();
  try {
    {
    const merged = await refreshActivity(u.login);
    if (seq !== RSEQ) return;
    const list = document.querySelector('#view .card.list');
    if (list && list.querySelector('.lrow')) {
      if (prependNewRows(list, merged, evKey, eventRow, 0, 'activity')) refreshPulse();
    } else {
      view().innerHTML = merged.length ? '<div class="card list">' + merged.map(eventRow).join('') + '</div>' : '<div class="card empty">No activity yet.</div>';
      settleView();
      seedLive('activity', merged.map(evKey));
    }
    }
  } catch (e) { if (seq !== RSEQ) return; if (!cHist.length) view().innerHTML = errCard(e); }
}

/* ================= views: repos (mine / starred / discover + search) ================= */
let RS = { mode: 'mine', q: '', page: 1, items: [] };
async function renderRepos() {
  const seq = ++RSEQ;
  RS = { mode: RS.mode || 'mine', q: '', page: 1, items: [] };
  if (seq !== RSEQ) return;
  view().innerHTML = '<button class="btn ghost btnblock" id="newRepoBtn" style="margin-bottom:12px">' + esc(i18n('newRepository')) + '</button>' +
    '<div class="searchbar" id="searchWrap">' + SVG.search + '<input id="repoSearch" placeholder="' + (RS.mode === 'discover' ? 'Search all of GitHub…' : 'Search repos and people…') + '" autocomplete="off"></div>' +
    '<div class="seg" id="repoSeg">' +
    '<button class="segb' + (RS.mode === 'mine' ? ' on' : '') + '" data-mode="mine">' + esc(i18n('mine')) + '</button>' +
    '<button class="segb' + (RS.mode === 'starred' ? ' on' : '') + '" data-mode="starred">' + esc(i18n('starred')) + '</button>' +
    '<button class="segb' + (RS.mode === 'discover' ? ' on' : '') + '" data-mode="discover">' + esc(i18n('discover')) + '</button></div>' +
    sortRowHTML('repos') +
    '<div id="repoList">' + spinner() + '</div>' +
    '<button id="repoMore" class="morebtn" hidden>' + esc(i18n('loadMore')) + '</button>';
  $('#newRepoBtn').addEventListener('click', newRepoSheet);
  let t;
  $('#repoSearch').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { RS.q = e.target.value.trim(); if (RS.q.length && RS.q.length < 3) return; loadRepos(true); }, 800); });
  $('#repoSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); RS.q = e.target.value.trim(); loadRepos(true); } });
  $$('#repoSeg .segb').forEach(b => b.addEventListener('click', () => { RS.mode = b.dataset.mode; renderRepos(); }));
  $('#repoMore').addEventListener('click', () => { RS.page++; loadRepos(false); });
  wireSortRow('repos', () => paintRepoList(RS.people));
  loadRepos(true);
}
function paintRepoList(people) {
  const list = $('#repoList'); if (!list) return;
  let html = '';
  if (people && people.total_count > 0) {
    html += '<div class="card" style="padding:0 0 4px"><div class="lsub" style="padding:14px 20px 0">People</div><div class="peoplebar">' +
      people.items.map(u => '<button class="person" data-go="#/user/' + esc(u.login) + '"><img src="' + esc(u.avatar_url) + '" alt=""><span>' + esc(u.login) + '</span></button>').join('') +
      '</div></div>';
  }
  const sorted = sortItems(RS.items, 'repos');
  /* the wrapper has no background of its own - it only lets the cards lay out
     two-up on a laptop, and it keeps the list wrapper-free on phones */
  if (sorted.length) html += '<div class="repogrid">' + sorted.map(repoRow).join('') + '</div>';
  else html += '<div class="card empty">' + (RS.q ? 'No results for "' + esc(RS.q) + '"' : (RS.mode === 'discover' ? 'Nothing trending right now.' : 'Nothing here yet.')) + '</div>';
  list.innerHTML = html;
  markNewRows(list, 'repos');
}
/* server-side sort for repo SEARCHES, mapped from the selected sort */
function searchSortParams() {
  const s = normSort('repos', LS.get('sort.repos', 'best'));
  if (s === 'stars') return '&sort=stars&order=desc';
  if (s === 'sasc') return '&sort=stars&order=asc';
  if (s === 'forks') return '&sort=forks&order=desc';
  if (s === 'fasc') return '&sort=forks&order=asc';
  if (s === 'uasc') return '&sort=updated&order=asc';
  if (s === 'best') return '';
  return '&sort=updated&order=desc';
}
/* ================= deep + fuzzy repository search =================
   Three things make a repo "unfindable" with a plain query:
   1. the request was sent with &sort=updated, which buries a small repo
      behind thousands of recently pushed ones even for an exact name;
   2. GitHub's search index lags - a brand new public repo can take a while
      to appear at all;
   3. a plain query is matched loosely, so an exact name can rank below
      unrelated popular repos.
   So a search now resolves owner/name directly, asks for the exact name,
   asks broadly, adds the owner's repos when the term looks like a user,
   and finally ranks everything locally by how well it really matches. */
function fuzzyScore(r, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return 0;
  const name = String(r.name || '').toLowerCase();
  const full = String(r.full_name || '').toLowerCase();
  const owner = full.split('/')[0] || '';
  let s = 0;
  if (full === t) s += 160;
  else if (name === t) s += 120;
  else if (name.startsWith(t)) s += 80;
  else if (name.includes(t)) s += 50;
  if (owner === t) s += 70;
  else if (owner.includes(t)) s += 18;
  if (full.includes(t) && name !== t && !name.startsWith(t)) s += 22;
  if (String(r.description || '').toLowerCase().includes(t)) s += 10;
  if ((r.topics || []).some(x => String(x).toLowerCase().includes(t))) s += 8;
  s += Math.min(18, Math.log10((r.stargazers_count || 0) + 1) * 4);
  return s;
}
function rankFuzzy(list, term) {
  return list.map((r, i) => [r, i]).sort((a, b) => {
    const d = fuzzyScore(b[0], term) - fuzzyScore(a[0], term);
    return d !== 0 ? d : a[1] - b[1];
  }).map(x => x[0]);
}
async function deepRepoSearch(term, page, sortParams, wantPeople) {
  const enc = encodeURIComponent(term);
  const looksLikePath = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(term);
  const looksLikeUser = /^[A-Za-z0-9._-]+$/.test(term);
  /* the owner/name probe and the user's repo list are extra REST requests on top of
     the search: only on the first page (later pages would repeat them), and the
     user's list only when the name search alone did not fill a screen */
  const [direct, byName, broad, , people] = await Promise.all([
    looksLikePath && page <= 1 ? api('/repos/' + term, { status: true }).catch(() => null) : Promise.resolve(null),
    api('/search/repositories?q=' + enc + '+in%3Aname' + (sortParams || '') + '&per_page=30&page=' + page).catch(() => null),
    Promise.resolve(null),
    Promise.resolve(null),
    wantPeople ? api('/search/users?q=' + enc + '&per_page=15').catch(() => null) : Promise.resolve(null)
  ]);
  const userRepos = (looksLikeUser && page <= 1 && !(byName && byName.items && byName.items.length >= 10))
    ? await api('/users/' + enc + '/repos?per_page=30&sort=updated').catch(() => null) : null;
  const out = [], seen = new Set();
  const add = list => (list || []).forEach(r => {
    const k = r && r.full_name;
    if (k && !seen.has(k)) { seen.add(k); out.push(r); }
  });
  if (direct && direct.status === 200 && direct.data && direct.data.full_name) add([direct.data]);
  add(byName && byName.items);
  let broad2 = null;
  if (out.length < 10) broad2 = await api('/search/repositories?q=' + enc + (sortParams || '') + '&per_page=30&page=' + page).catch(() => null);
  add(broad2 && broad2.items);
  add(userRepos);
  /* nothing at all: retry with the longest word alone, which rescues a name
     typed with extra words or slightly wrong spacing */
  if (!out.length && /\s/.test(term)) {
    const longest = term.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    if (longest.length >= 3) {
      const loose = await api('/search/repositories?q=' + encodeURIComponent(longest) + '+in%3Aname&per_page=30').catch(() => null);
      add(loose && loose.items);
    }
  }
  const explicitSort = !!(sortParams && sortParams.indexOf('sort=') !== -1);
  return { items: explicitSort ? out : rankFuzzy(out, term), people };
}

async function loadRepos(reset) {
  const seq = ++RSEQ;
  const list = $('#repoList'); if (!list) return;
  if (reset) { RS.page = 1; RS.items = []; list.innerHTML = spinner(); }
  if (reset && RS.q.length < 2 && RS.mode !== 'discover') {
    const cd = cached(RS.mode === 'starred' ? '/user/starred?per_page=30&page=1' : '/user/repos?sort=updated&per_page=30&page=1');
    if (cd && Array.isArray(cd) && cd.length) {
      cd.forEach(r => repoCache.set(r.full_name, r));
      RS.items = cd;
      RS.people = null;
      paintRepoList(null);
    }
  }
  $('#searchWrap').style.display = '';
  let data = [], people = null;
  try {
    if (RS.mode === 'discover') {
      if (RS.q.length >= 2) {
        const res = await deepRepoSearch(RS.q, RS.page, searchSortParams(), false);
        data = res.items;
      } else {
        const q = 'stars%3A%3E10000+pushed%3A%3E' + isoDaysAgo(90);
        const res = await api('/search/repositories?q=' + q + searchSortParams() + '&per_page=30&page=' + RS.page);
        data = res.items || [];
      }
    } else if (RS.mode === 'starred' && RS.q.length >= 2) {
      /* searching the Starred tab must look inside what YOU starred - the old
         code asked for "user:<you>", which searched your own repositories */
      const all = await api('/user/starred?per_page=100&page=1').catch(() => []);
      const t = RS.q.toLowerCase();
      data = rankFuzzy((all || []).filter(r =>
        String(r.full_name || '').toLowerCase().includes(t) ||
        String(r.description || '').toLowerCase().includes(t)), RS.q);
    } else if (RS.q.length >= 2) {
      const res = await deepRepoSearch(RS.q, RS.page, searchSortParams(), true);
      data = res.items;
      people = res.people;
    } else if (RS.mode === 'starred') {
      data = await api('/user/starred?per_page=30&page=' + RS.page);
    } else {
      data = await api('/user/repos?sort=updated&per_page=30&page=' + RS.page);
    }
  } catch (e) { if (seq !== RSEQ) return; list.innerHTML = errCard(e); return; }
  data.forEach(r => repoCache.set(r.full_name, r));
  RS.items = reset ? data : RS.items.concat(data);
  RS.people = people;
  if (seq !== RSEQ) return;
  paintRepoList(people);
  if (RS.mode !== 'discover' && (RS.q || '').length < 2) {
    liveList('#repoList',
      () => api(RS.mode === 'starred' ? '/user/starred?per_page=30&page=1' : '/user/repos?sort=updated&per_page=30&page=1'),
      r => r.full_name, repoRow, 0, 'repos');
  }
  $('#repoMore').hidden = data.length < 30;
}

/* ================= list sorting (repos, commits, issues) ================= */
const SORT_OPTIONS = {
  repos: [['best', 'Best match'], ['stars', 'Most stars'], ['sasc', 'Fewest stars'], ['forks', 'Most forks'], ['fasc', 'Fewest forks'], ['updated', 'Recently updated'], ['uasc', 'Least recently updated'], ['name', 'Name A–Z']],
  rcommits: [['new', 'Newest'], ['old', 'Oldest'], ['author', 'Author']],
  hcommits: [['new', 'Newest'], ['old', 'Oldest'], ['repo', 'Repo']],
  issues: [['updated', 'Recently updated'], ['new', 'Newest'], ['old', 'Oldest'], ['comments', 'Most commented']]
};
/* sort names carry a translation key alongside the English wording */
const SORT_KEY = {
  'Best match':'sortBest','Most stars':'sortMostStars','Fewest stars':'sortFewestStars','Most forks':'sortMostForks',
  'Fewest forks':'sortFewestForks','Recently updated':'sortRecent','Least recently updated':'sortLeastRecent',
  'Name A–Z':'sortNameAZ','Newest':'sortNewest','Oldest':'sortOldest','Author':'sortAuthor','Repo':'sortRepo',
  'Most commented':'sortMostCommented'
};
function sortLabel(kind, key) {
  const o = (SORT_OPTIONS[kind] || []).find(s => s[0] === key);
  const en = o ? o[1] : (SORT_OPTIONS[kind] ? SORT_OPTIONS[kind][0][1] : '');
  return SORT_KEY[en] ? i18n(SORT_KEY[en]) : en;
}
/* normalizes sort keys saved by older app versions */
function normSort(kind, s) {
  const opts = SORT_OPTIONS[kind];
  if (opts.some(o => o[0] === s)) return s;
  if (kind === 'repos' && (s === 'pushed' || s === 'created')) return 'updated';
  return opts[0][0];
}
/* GitHub-style "Sort: …" dropdown button */
function sortRowHTML(kind) {
  const cur = normSort(kind, LS.get('sort.' + kind, SORT_OPTIONS[kind][0][0]));
  return '<button class="btn ghost" data-sort="' + kind + '" style="margin:0 0 12px;width:100%;display:flex;justify-content:space-between;align-items:center">' +
    '<span class="sortlbl">' + esc(i18n('sort')) + ': ' + sortLabel(kind, cur) + '</span>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><polyline points="6 9 12 15 18 9"/></svg></button>';
}
function openSortSheet(kind, redo) {
  const cur = normSort(kind, LS.get('sort.' + kind, SORT_OPTIONS[kind][0][0]));
  openSheet('<div class="sheethead"><b>Sort by</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="card" style="padding:4px 0">' +
    SORT_OPTIONS[kind].map(s => '<div class="lrow" data-sel="' + s[0] + '" style="padding:12px 16px">' +
      '<div class="lmain"><div class="ltitle">' + s[1] + '</div></div>' +
      (cur === s[0] ? '<div class="istate">' + SVG.check + '</div>' : '') + '</div>').join('') + '</div>');
  $$('#sheet [data-sel]').forEach(r => r.addEventListener('click', () => {
    LS.set('sort.' + kind, r.dataset.sel);
    closeSheet();
    redo();
  }));
}
function wireSortRow(kind, redo) {
  const b = document.querySelector('[data-sort="' + kind + '"]');
  if (!b) return;
  b.addEventListener('click', () => openSortSheet(kind, redo));
}
function commitDate(x) { return (x && x.commit && x.commit.author && x.commit.author.date) || (x && x.date) || ''; }
function commitAuthor(x) { return (x && x.author && x.author.login) || (x && x.commit && x.commit.author && x.commit.author.name) || ''; }
function sortItems(items, kind) {
  const s = normSort(kind, LS.get('sort.' + kind, SORT_OPTIONS[kind][0][0]));
  const arr = (items || []).slice();
  const byName = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  if (kind === 'repos') {
    if (s === 'best') return arr;
    if (s === 'name') arr.sort((a, b) => byName(a.name, b.name));
    else if (s === 'stars' || s === 'sasc') { arr.sort((a, b) => (a.stargazers_count || 0) - (b.stargazers_count || 0)); if (s === 'stars') arr.reverse(); }
    else if (s === 'forks' || s === 'fasc') { arr.sort((a, b) => (a.forks_count || 0) - (b.forks_count || 0)); if (s === 'forks') arr.reverse(); }
    else if (s === 'updated' || s === 'uasc') { arr.sort((a, b) => new Date(a.pushed_at || a.updated_at || 0) - new Date(b.pushed_at || b.updated_at || 0)); if (s === 'updated') arr.reverse(); }
  } else if (kind === 'rcommits') {
    if (s === 'old') arr.sort((a, b) => new Date(commitDate(a) || 0) - new Date(commitDate(b) || 0));
    else if (s === 'author') arr.sort((a, b) => byName(commitAuthor(a), commitAuthor(b)));
    else arr.sort((a, b) => new Date(commitDate(b) || 0) - new Date(commitDate(a) || 0));
  } else if (kind === 'hcommits') {
    if (s === 'old') arr.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    else if (s === 'repo') arr.sort((a, b) => byName(a.repo, b.repo));
    else arr.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } else if (kind === 'issues') {
    if (s === 'new') arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    else if (s === 'old') arr.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    else if (s === 'comments') arr.sort((a, b) => (b.comments || 0) - (a.comments || 0));
    else arr.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }
  return arr;
}

/* true when the signed-in user can push to this repo (owner or collaborator) */
const PUSH_CACHE = {};
async function canPushRepo(o, n) {
  const full = o + '/' + n;
  if (full in PUSH_CACHE) return PUSH_CACHE[full];
  let r = repoCache.get(full);
  if (!r || !r.permissions) {
    try { r = await api('/repos/' + full); } catch (e) { r = null; }
  }
  PUSH_CACHE[full] = !!(r && r.permissions && r.permissions.push);
  return PUSH_CACHE[full];
}

/* ================= views: repo detail ================= */
/* Run `fn` once, the first time `el` comes near the screen. Used so a repository
   screen only asks GitHub for things the person actually scrolls to. Without
   IntersectionObserver (very old WebView) it simply runs straight away. */
function whenNearScreen(el, fn) {
  if (!el) return;
  let done = false;
  const go = () => { if (done) return; done = true; try { fn(); } catch (e) { } };
  if (typeof IntersectionObserver === 'undefined') { go(); return; }
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); go(); }
  }, { rootMargin: '200px 0px' });
  io.observe(el);
}
async function renderRepo(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  let r = cached('/repos/' + full) || null;
  if (r) api('/repos/' + full).then(fr => { if (fr && fr.full_name) repoCache.set(fr.full_name, fr); }).catch(() => {});
  if (!r) { try { r = await api('/repos/' + full); } catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; } }
  repoCache.set(r.full_name, r);
  let html = '<div class="card">' +
    '<div class="rcrow"><div class="rcname">' + esc(r.name) + '</div>' +
    '<button class="pinbtn ' + (isPinned(r.full_name) ? 'pinned' : '') + '" data-pinbtn="' + esc(r.full_name) + '" aria-label="pin">' + SVG.star + '</button></div>' +
    '<div class="chips"><span class="chip">' + i18n(r.private ? 'repoPrivate' : 'repoPublic') + '</span>' +
    (r.fork ? '<span class="chip">Fork</span>' : '') + (r.archived ? '<span class="chip warn">Archived</span>' : '') +
    (r.default_branch ? '<button class="chip branchchip" id="branchChip" data-branch="' + esc(branchFor(full) || r.default_branch) + '">' + SVG.branch + esc(branchFor(full) || r.default_branch) + ' \u25be</button>' : '') +
    (r.license && r.license.spdx_id ? '<span class="chip">' + esc(r.license.spdx_id) + '</span>' : '') + '</div>' +
    (r.description ? '<p class="rcdesc">' + esc(r.description) + '</p>' : '') +
    (r.topics && r.topics.length ? '<div class="chips">' + r.topics.slice(0, 8).map(t => '<span class="chip pr">' + esc(t) + '</span>').join('') + '</div>' : '') +
    '<div class="rcmeta">' + SVG.star + ' ' + nf(r.stargazers_count) + ' · ' + SVG.fork + ' ' + nf(r.forks_count) +
    (r.language ? ' · <span class="dot" style="background:' + langColor(r.language) + '"></span>' + esc(r.language) : '') + '</div>' +
    '<div class="bigstats">' +
    '<div class="bstat"><b>' + nf(r.open_issues_count) + '</b><span>' + esc(i18n('issuesLabel')) + '</span></div>' +
    '<div class="bstat"><b>' + nf(r.watchers_count) + '</b><span>' + esc(i18n('watchersLabel')) + '</span></div>' +
    '<div class="bstat"><b>' + tAgo(r.pushed_at) + '</b><span>' + esc(i18n('lastPush')) + '</span></div></div></div>';
  html += '<div class="card metarow" id="metaRow">' + spinner(true) + '</div>';
  html += '<div class="card"><div class="actionrow">' +
    '<button class="btn ghost" id="actStar">' + SVG.star + '<span>' + esc(i18n('star')) + '</span></button>' +
    '<button class="btn ghost" id="actWatch">' + SVG.eye + '<span>' + esc(i18n('watch')) + '</span></button>' +
    '<button class="btn ghost" id="actFork">' + SVG.fork + '<span>' + esc(i18n('fork')) + '</span></button>' +
    '<button class="btn ghost" data-go="#/repostats/' + full + '"><span>' + esc(i18n('productivity')) + '</span></button>' +
    '</div></div>';
  if (r.permissions && r.permissions.push) {
    /* four equal buttons that fill the row - the old ones had flex:1 with no
       min-width, so two of them wrapped to two lines and left a gap on the left */
    const rowBtn = 'btn sm ghost';
    const rowStyle = 'flex:1 1 0;min-width:0;padding-left:6px;padding-right:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    html += '<div class="card" style="display:flex;gap:6px">' +
      '<button class="' + rowBtn + '" id="editRepoBtn" style="' + rowStyle + '">' + esc(i18n('editShort')) + '</button>' +
      '<button class="' + rowBtn + '" data-go="#/repo/' + full + '/traffic" style="' + rowStyle + '">' + esc(i18n('traffic')) + '</button>' +
      '<button class="' + rowBtn + '" data-go="#/repo/' + full + '/settings" style="' + rowStyle + '">' + esc(i18n('settings')) + '</button>' +
      (canInvite(r) ? '<button class="' + rowBtn + '" id="addCollabBtn" style="' + rowStyle + '">+ ' + esc(i18n('addCollabShort')) + '</button>' : '') +
      '</div>';
  }
  html += '<div class="seg tabs"><a class="segb on" href="#/repo/' + full + '">' + esc(i18n('readme')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/files">' + esc(i18n('files')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/commits">' + esc(i18n('commits')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/issues">' + esc(i18n('issues')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/pulls">' + esc(i18n('pullRequests')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/actions">' + esc(i18n('actions')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/security">' + esc(i18n('security')) + '</a>' +
    '<a class="segb" href="#/repo/' + full + '/insights">' + esc(i18n('insights')) + '</a></div>';
  html += '<div id="readmeWrap">' + spinner() + '</div>';
  html += '<div id="langWrap" style="min-height:1px"></div>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  /* contributors + latest release: shown as plain rows at once, and filled in
     (2 requests) only when this card is near the screen */
  const metaHtml = (contribs, release, pending, collabs) => {
  /* Someone you just added has not committed yet, so /contributors does not
     know them - which made the row look like the invite had done nothing.
     Collaborators are merged in front, deduplicated by login. */
  {
    const seen = {}, merged = [];
    (collabs || []).forEach(c => {
      const lg = String((c && c.login) || '').toLowerCase();
      if (!lg || seen[lg]) return; seen[lg] = 1; merged.push({ login: c.login, avatar_url: c.avatar_url });
    });
    (contribs || []).forEach(c => {
      const lg = String((c && c.author && c.author.login) || '').toLowerCase();
      if (!lg || seen[lg]) return; seen[lg] = 1; merged.push({ login: c.author.login, avatar_url: c.author.avatar_url });
    });
    contribs = merged;
  }
  let meta = '<div class="mrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
    '<div class="lmain"><div class="ltitle">' + esc(i18n('contributors')) + '</div>' +
    (pending || (contribs && contribs.length) ? '' : '<div class="lsub">' + esc(i18n('noneListed')) + '</div>') + '</div>' +
    '<div class="avatars">' + (contribs || []).map(c => '<img data-go="#/user/' + esc(c.login) + '" src="' + esc(c.avatar_url) + '" alt="' + esc(c.login) + '" title="' + esc(c.login) + '">').join('') + '</div>' +
    '</div>';
  if (release && release.tag_name) {
    meta += '<div class="mrow" data-go="#/repo/' + full + '/releases">' + SVG.tag +
      '<div class="lmain"><div class="ltitle">Releases · latest ' + esc(release.tag_name) + '</div>' +
      '<div class="lsub">' + tAgo(release.published_at) + (release.author ? ' · by ' + esc(release.author.login) : '') + ' — tap to view and download</div></div></div>';
  } else {
    meta += '<div class="mrow" data-go="#/repo/' + full + '/releases">' + SVG.tag +
      '<div class="lmain"><div class="ltitle">' + esc(i18n('releases')) + '</div>' +
      '<div class="lsub">' + esc(i18n('viewAllReleases')) + '</div></div></div>';
  }
  meta += '<div class="mrow" data-act="clone" data-full="' + esc(full) + '">' + SVG.code +
    '<div class="lmain"><div class="ltitle">' + esc(i18n('clone')) + '</div>' +
    '<div class="lsub">' + esc(i18n('cloneSub')) + '</div></div></div>';
  meta += '<div class="mrow" data-act="deployments" data-full="' + esc(full) + '">' + SVG.ext +
    '<div class="lmain"><div class="ltitle">' + esc(i18n('deployments')) + '</div>' +
    '<div class="lsub">' + esc(i18n('deploymentsSub')) + '</div></div></div>';
  return meta;
  };
  const mr = $('#metaRow'); if (mr) mr.innerHTML = metaHtml(null, null, true);
  const wireAdd = () => { const b = $('#addCollabBtn'); if (b) b.addEventListener('click', () => collabSheet(full)); };
  wireAdd();
  { const bc = $('#branchChip'); if (bc) bc.addEventListener('click', (e) => { e.stopPropagation(); branchSheet(o, n); }); }
  whenNearScreen(mr, async () => {
    const [contribs, release, collabs] = await Promise.all([
      api('/repos/' + full + '/contributors?per_page=9').catch(() => null),
      api('/repos/' + full + '/releases/latest').catch(() => null),
      /* only readable with push access; anyone without it simply gets contributors */
      (r && r.permissions && r.permissions.push)
        ? api('/repos/' + full + '/collaborators?per_page=30').catch(() => null)
        : null
    ]);
    if (seq !== RSEQ) return;
    const mr2 = $('#metaRow'); if (mr2) mr2.innerHTML = metaHtml(contribs, release, false, collabs);
    { const b = $('#addCollabBtn'); if (b) b.addEventListener('click', () => collabSheet(full)); }
  });
  // repo actions: star / watch / fork
  const starBtn = $('#actStar'), watchBtn = $('#actWatch'), forkBtn = $('#actFork');
  const editBtn = $('#editRepoBtn');
  if (editBtn) editBtn.addEventListener('click', () => editRepoSheet(o, n, r));
  if (starBtn) {
    api('/user/starred/' + full, { status: true }).then(s => {
      if (s && s.status === 204) { starBtn.classList.add('on'); starBtn.querySelector('span').textContent = 'Starred'; }
    }).catch(() => {});
    starBtn.addEventListener('click', async () => {
      const on = starBtn.classList.contains('on');
      try {
        await writeOrQueue('/user/starred/' + full, on ? 'DELETE' : 'PUT', undefined, on ? 'Unstar' : 'Star');
        starBtn.classList.toggle('on', !on);
        starBtn.querySelector('span').textContent = on ? 'Star' : 'Starred';
        toast(on ? 'Unstarred ' + n : 'Starred ' + n);
      } catch (e) { toast('Failed: ' + e.message); }
    });
  }
  if (watchBtn) {
    api('/repos/' + full + '/subscription', { status: true }).then(s => {
      if (s && s.status === 200) { watchBtn.classList.add('on'); watchBtn.querySelector('span').textContent = i18n('watching'); }
    }).catch(() => {});
    watchBtn.addEventListener('click', async () => {
      const on = watchBtn.classList.contains('on');
      try {
        await api('/repos/' + full + '/subscription', { method: on ? 'DELETE' : 'PUT', body: on ? undefined : JSON.stringify({ subscribed: true }) });
        watchBtn.classList.toggle('on', !on);
        watchBtn.querySelector('span').textContent = on ? i18n('watch') : i18n('watching');
        toast(on ? 'Stopped watching ' + n : 'Watching ' + n);
      } catch (e) { toast('Failed: ' + e.message); }
    });
  }
  if (forkBtn) {
    forkBtn.addEventListener('click', async () => {
      if (!window.confirm('Fork ' + full + ' to your account?')) return;
      try {
        const f = await api('/repos/' + full + '/forks', { method: 'POST' });
        toast('Forked to ' + f.full_name);
        location.hash = '#/repo/' + f.full_name;
      } catch (e) { toast('Failed: ' + e.message); }
    });
  }
  // readme
  try {
    const md = await api('/repos/' + full + '/readme', { accept: 'application/vnd.github.html', text: true });
    const rw = $('#readmeWrap');
    if (rw && seq === RSEQ) { rw.innerHTML = '<div class="card md">' + fixMd(md, full) + '</div>'; inlineRepoImages(rw); }
  } catch (e) {
    if (seq !== RSEQ) return;
    const rw = $('#readmeWrap');
    if (rw) {
      rw.innerHTML = '<div class="card empty">No README found.<div style="margin-top:14px"><button class="btn sm ghost" id="mkReadmeBtn" style="min-width:170px">Create README</button></div></div>';
      const mrb = $('#mkReadmeBtn');
      if (mrb) mrb.addEventListener('click', () => addFileSheet(o, n, '', 'README.md'));
    }
  }
  /* languages sit below the README: asked for only once the person scrolls down to them */
  if (seq !== RSEQ) return;
  whenNearScreen($('#langWrap'), () => {
    api('/repos/' + full + '/languages').then(langs => {
      if (seq !== RSEQ) return;
      const lw = $('#langWrap'); if (lw && langs && Object.keys(langs).length) lw.innerHTML = langBars(langs);
    }).catch(() => {});
  });
}

function wireFileActions(o, n, path) {
  if (!$('#addFileBtn')) return;
  $('#addFileBtn').addEventListener('click', () => addFileSheet(o, n, path));
  const upi = $('#upInput');
  $('#upFileBtn').addEventListener('click', () => {
    if (window.OneGit && window.OneGit.pickFiles) {
      folderCtx = { o, n, dir: path || '', jid: null, kind: 'files' };
      try { window.OneGit.pickFiles(); upProgShow('Upload files'); upProgUpdate('Choose files…', 0); return; }
      catch (e) { folderCtx = null; }
    }
    upi.click();
  });
  const udb = $('#upDirBtn');
  if (udb) udb.addEventListener('click', () => {
    if (!(window.OneGit && window.OneGit.pickFolder)) { toast('Folder upload is not available'); return; }
    folderCtx = { o, n, dir: path || '', jid: null, kind: 'folder' };
    try { window.OneGit.pickFolder(); upProgShow('Upload folder'); upProgUpdate('Scanning folder…', 0); } catch (e) { folderCtx = null; toast('Could not open the folder picker'); }
  });
  upi.addEventListener('change', async () => {
    const files = Array.from(upi.files || []);
    if (!files.length) return;
    const items = [];
    for (const f of files) {
      try { items.push({ path: f.name, b64: await fileToB64(f) }); }
      catch (e) { toast('Could not read ' + f.name); }
    }
    upi.value = '';
    if (!items.length) return;
    const def = items.length === 1 ? 'Upload ' + items[0].path : 'Upload ' + items.length + ' files';
    commitMsgSheet('Upload ' + items.length + ' file' + (items.length === 1 ? '' : 's'), def, async msg => {
      upProgShow('Uploading files');
      upProgUpdate('Reading files…', 5);
      try {
        await commitMany(o, n, items, path || '', msg,
          (done, total) => upProgUpdate('Committing ' + done + ' / ' + total, done / total * 100));
        upProgUpdate('Complete — ' + items.length + ' file' + (items.length === 1 ? '' : 's') + ' in one commit', 100);
        setTimeout(upProgHide, 3000);
        try { if (window.OneGit && window.OneGit.notify) window.OneGit.notify('Upload complete', items.length + ' file' + (items.length === 1 ? '' : 's') + ' uploaded to ' + o + '/' + n + ' in a single commit'); } catch (e) {}
        renderFiles(o, n, path);
      } catch (e) { upProgHide(); toast('Failed: ' + e.message); }
    });
  });
}

async function renderFiles(o, n, path) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  const canWrite = await canPushRepo(o, n);
  if (seq !== RSEQ) return;
  /* file write actions only for repos you can push to */
  const actRow = canWrite ? '<div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn ghost" id="addFileBtn" style="flex:1">Add file</button><button class="btn ghost" id="upFileBtn" style="flex:1">Upload files</button><button class="btn ghost" id="upDirBtn" style="flex:1">Upload folder</button></div>' : '';
  let items;
  const vbr = branchFor(full);
  try { items = await api('/repos/' + full + '/contents/' + (path ? encodeURIComponent(path).replace(/%2F/g, '/') : '') + (vbr ? '?ref=' + encodeURIComponent(vbr) : '')); }
  catch (e) {
    if (seq !== RSEQ) return;
    if (/is empty/i.test(e.message || '')) {
      view().innerHTML = actRow + '<input type="file" id="upInput" multiple hidden><div class="card empty">This repository is empty \u2014 add your first file to get started.</div>';
      wireFileActions(o, n, path);
  view().querySelectorAll('.rowmenu').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fileMenuSheet(o, n, btn.dataset.menu, btn.dataset.dir === '1'); });
  });
  { const bc = $('#branchChip'); if (bc) bc.addEventListener('click', (e) => { e.stopPropagation(); branchSheet(o, n); }); }
      return;
    }
    view().innerHTML = errCard(e); return;
  }
  if (!Array.isArray(items)) { view().innerHTML = '<div class="card empty">Not a folder.</div>'; return; }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  let html = path ? '<div class="card crumb">/' + esc(path) + '</div>' : '';
  const r0 = cached('/repos/' + full) || null;
  if (r0 && r0.default_branch) {
    const cb = branchFor(full) || r0.default_branch;
    html += '<div class="chips" style="margin-bottom:10px"><button class="chip branchchip" id="branchChip" data-branch="' + esc(cb) + '">' + SVG.branch + esc(cb) + ' \u25be</button></div>';
  }
  html += actRow;
  html += '<input type="file" id="upInput" multiple hidden>';
  html += '<div class="card list">';
  if (path) {
    const parent = path.split('/').slice(0, -1).join('/');
    html += '<div class="lrow" data-go="#/repo/' + full + '/files' + (parent ? '/' + parent : '') + '">' + SVG.folder + '<div class="lmain"><div class="ltitle">..</div></div></div>';
  }
  items.forEach(it => {
    if (it.type === 'dir') html += '<div class="lrow" data-go="#/repo/' + full + '/files/' + it.path + '">' + SVG.folder + '<div class="lmain"><div class="ltitle">' + esc(it.name) + '</div></div>' +
      '<span class="rowacts"><button class="iconbtn rowmenu" data-menu="' + esc(it.path) + '" data-dir="1" aria-label="more">' + SVG.more + '</button></span></div>';
    else html += '<div class="lrow" data-act="openfile" data-repo="' + esc(full) + '" data-file="' + esc(it.path) + '">' + SVG.file + '<div class="lmain"><div class="ltitle">' + esc(it.name) + '</div><div class="lsub">' + fmtSize(it.size) + '</div></div>' +
      /* download straight from the list, without opening the file first */
      '<span class="rowacts">' +
      '<button class="iconbtn" data-act="apidl" data-owner="' + esc(o) + '" data-repo="' + esc(n) + '" data-path="' + esc(it.path) + '" data-name="' + esc(it.name) + '" aria-label="download ' + esc(it.name) + '">' + SVG.dl + '</button>' +
      '<button class="iconbtn rowmenu" data-menu="' + esc(it.path) + '" data-dir="0" aria-label="more">' + SVG.more + '</button>' +
      '</span></div>';
  });
  html += '</div>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  wireFileActions(o, n, path);
  view().querySelectorAll('.rowmenu').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fileMenuSheet(o, n, btn.dataset.menu, btn.dataset.dir === '1'); });
  });
  { const bc = $('#branchChip'); if (bc) bc.addEventListener('click', (e) => { e.stopPropagation(); branchSheet(o, n); }); }
  let lpTimer = null, lpFired = false;
  view().querySelectorAll('[data-act="openfile"]').forEach(row => {
    row.addEventListener('pointerdown', () => {
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        try { if (navigator.vibrate) navigator.vibrate(25); } catch (er) {}
        confirmDeleteFile(row.dataset.repo, row.dataset.file);
      }, 550);
    });
    const cancel = () => clearTimeout(lpTimer);
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointerleave', cancel);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('click', e => { if (lpFired) { e.stopImmediatePropagation(); e.preventDefault(); lpFired = false; } }, true);
  });
}

async function renderCommits(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const res = await Promise.allSettled([
    api('/repos/' + full + '/commits?per_page=30'),
    apiCount('/repos/' + full + '/commits'),
    apiCount('/repos/' + full + '/commits?since=' + midnight.toISOString())
  ]);
  if (seq !== RSEQ) return;
  if (res[0].status !== 'fulfilled') { view().innerHTML = errCard(res[0].reason); return; }
  const items = res[0].value;
  const total = res[1].status === 'fulfilled' ? res[1].value : null;
  const today = res[2].status === 'fulfilled' ? res[2].value : null;
  let html = '';
  if (total !== null || today !== null) html += '<div class="card commitstats" style="margin:0 0 14px">' +
    (total !== null ? '<div class="cstat total">' + nf(total) + '<span>Total commits</span></div>' : '') +
    (today !== null ? '<div class="cstat today">' + nf(today) + '<span>Today</span></div>' : '') + '</div>';
  html += sortRowHTML('rcommits');
  const sorted = sortItems(items, 'rcommits');
  html += sorted.length ? '<div class="card list">' + sorted.map(x => commitRow(x, full)).join('') + '</div>' : '<div class="card empty">No commits found.</div>';
  view().innerHTML = html;
  wireSortRow('rcommits', () => renderCommits(o, n));
  wireCommitRows();
}
/* counts results of a LIST endpoint exactly via the Link header (per_page=1 trick).
   Goes through the same system as every other read: the number is saved with
   GitHub's tag, so asking again is a free 304; it is counted in the usage meter,
   updates the live budget, and when the hour is nearly gone (or the REST budget
   is out) the saved number is shown and nothing is sent. */
async function apiCount(path) {
  const full = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'per_page=1';
  const ck = cacheKey(full);
  const saved = LS.get(ck, null);
  const have = saved && typeof saved.d === 'number';
  if (blockedFor(full) || (budgetLow() && !(have && saved.etag))) {
    if (have) return saved.d;
    throw new Error('rate limited');
  }
  const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  if (have && saved.etag) headers['If-None-Match'] = saved.etag;
  let res;
  try {
    res = await fetch('https://api.github.com' + full, { headers, cache: 'no-store' });
    usageCount(full, res.status);
  } catch (netErr) {
    if (have) return saved.d;
    throw netErr;
  }
  try {
    budgetFromRes(res);
    const rem = res.headers.get('X-RateLimit-Remaining');
    if ((res.headers.get('X-RateLimit-Resource') || 'core') === 'core' && rem !== null) {
      RL_LEFT = Number(rem);
      const lim = res.headers.get('X-RateLimit-Limit'); if (lim) RL_MAX = Number(lim);
      const rst = Number(res.headers.get('X-RateLimit-Reset') || 0) * 1000;
      if (rem === '0' && rst) rlSet(rst + 2000);
    }
  } catch (e) { }
  if (res.status === 304 && have) {
    try { LS.set(ck, { d: saved.d, at: Date.now(), etag: saved.etag }); } catch (e) { }
    return saved.d;
  }
  if (!res.ok) {
    if (have) return saved.d;
    throw new Error('HTTP ' + res.status);
  }
  const link = res.headers.get('Link') || '';
  const m = link.match(/[?&]page=(\d+)>; rel="last"/);
  let n;
  if (m) n = +m[1];
  else { const arr = await res.json().catch(() => null); n = Array.isArray(arr) ? arr.length : 0; }
  try { LS.set(ck, { d: n, at: Date.now(), etag: res.headers.get('ETag') || '' }); pruneCache(700); } catch (e) { }
  return n;
}

/* ---- global Commits tab: recent commits across all your repos ---- */
function commitTabRow(x) {
  return '<div class="lrow" data-go="#/commit/' + esc(x.repo) + '/' + x.sha + '" data-repo="' + esc(x.repo) + '" data-sha="' + esc(x.sha) + '">' +
    (x.av ? '<img class="cav" src="' + esc(x.av) + '" alt="">' : SVG.commit) +
    '<div class="lmain"><div class="ltitle">' + esc(x.msg) + '</div>' +
    '<div class="lsub">' + esc(x.repo) + ' \u00b7 ' + tAgo(x.date) + ' \u00b7 <span class="chip">' + esc(String(x.sha).slice(0, 7)) + '</span></div></div></div>';
}
async function renderCommitsHome(insertOnly) {
  const seq = ++RSEQ;
  const cached = LS.get('c.allcomm', null);
  let lastShown = cached && cached.length ? cached : [];
  const paint = (items, insertOnlyNow) => {
    lastShown = items || [];
    if (seq !== RSEQ) return;
    const sorted = sortItems(lastShown, 'hcommits');
    /* a refresh slides the new commits in on top of the old ones */
    if (insertOnlyNow) {
      const list = document.querySelector('#view .card.list');
      if (list && list.querySelector('.lrow')) {
        if (prependNewRows(list, sorted, x => x.repo + '|' + x.sha, commitTabRow, 60, 'commits')) { wireCommitRows(); refreshPulse(); }
        return;
      }
    }
    view().innerHTML = sortRowHTML('hcommits') +
      (sorted.length ? '<div class="card list">' + sorted.map(commitTabRow).join('') + '</div>' : '<div class="card empty">' + esc(i18n('noCommitsYet')) + '</div>');
    wireCommitRows();
    markNewRows(view(), 'commits');
    seedLive('commits', sorted.map(x => x.repo + '|' + x.sha));
    wireSortRow('hcommits', () => paint(lastShown));
  };
  LIVE_REFRESH = () => renderCommitsHome(true);
  if (cached && cached.length) paint(cached, insertOnly); else view().innerHTML = spinner();
  /* saved list is current enough: no request on open, tab switch or start-up refresh */
  if (gqlRecent('c.allcomm', !!(cached && cached.length))) return;
  const query = 'query{viewer{repositories(first:100,orderBy:{field:PUSHED_AT,direction:DESC},affiliations:OWNER,isFork:false){nodes{nameWithOwner defaultBranchRef{target{... on Commit{history(first:10){edges{node{oid messageHeadline committedDate author{name user{login avatarUrl(size:60)}}}}}}}}}}}}';
  try {
    const r = await api('/graphql', { method: 'POST', body: JSON.stringify({ query }) });
    const nodes = (r && r.data && r.data.viewer && r.data.viewer.repositories.nodes) || [];
    const items = [];
    nodes.forEach(nd => ((nd.defaultBranchRef && nd.defaultBranchRef.target && nd.defaultBranchRef.target.history ? nd.defaultBranchRef.target.history.edges : []) || []).forEach(e => {
      const c = e && e.node; if (!c) return;
      items.push({ repo: nd.nameWithOwner, sha: c.oid, msg: c.messageHeadline || '(no message)', date: c.committedDate,
        av: c.author && c.author.user ? c.author.user.avatarUrl : '' });
    }));
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    LS.set('c.allcomm', items.slice(0, 300));
    gqlStamp('c.allcomm');
    paint(items.slice(0, 300), insertOnly);
  } catch (e) {
    if (seq !== RSEQ) return;
    /* GraphQL is refused or out of budget. The same commits are still reachable
       two other ways, so the tab shows them instead of a message: your own push
       events over REST, and each repository's Atom feed, which carries no API
       budget at all. */
    const alt = await commitsFromOtherStreams();
    if (seq !== RSEQ) return;
    if (alt && alt.length) {
      try { LS.set('c.allcomm', alt.slice(0, 300)); } catch (e2) { }
      paint(alt.slice(0, 300), insertOnly);
      try { toast('Showing your commits from ' + (ROUTE_NOTE || 'another source')); } catch (e2) { }
      return;
    }
    if (!cached || !cached.length) view().innerHTML = errCard(e);
  }
}

/* The Commits tab asks GraphQL, which keeps its own budget. When that budget is
   gone the commits are still there to be had:
     1. your own push events over REST - exactly the pushes GitHub records for
        you, across every repository
     2. each repository's Atom feed, which carries no API budget at all
   So the tab keeps working rather than going quiet. */
async function commitsFromOtherStreams() {
  const items = [];
  try {
    const login = (USER && USER.login) || '';
    if (login) {
      const evs = await api('/users/' + login + '/events?per_page=100').catch(() => null);
      (Array.isArray(evs) ? evs : []).forEach(ev => {
        if (!ev || ev.type !== 'PushEvent') return;
        const repo = ev.repo ? ev.repo.name : '';
        (((ev.payload || {}).commits) || []).forEach(c => {
          if (!c) return;
          items.push({ repo, sha: c.sha, msg: String(c.message || '').split('\n')[0] || '(no message)',
            date: ev.created_at, av: '' });
        });
      });
    }
  } catch (e) { }
  if (items.length) return items;
  /* events had nothing (or REST is out too): read each repository's feed, which
     costs nothing. The repo names are gathered from everything already on the
     device - the saved repo list, the saved commit list, and the activity feed -
     so this still works when nothing can be asked for. */
  try {
    const names = [];
    const addName = n => { if (n && names.indexOf(n) === -1) names.push(n); };
    const repos = cached('/user/repos?per_page=100') || cached('/user/repos') || [];
    (Array.isArray(repos) ? repos : []).forEach(r => addName(r && r.full_name));
    (LS.get('c.allcomm', null) || []).forEach(c => addName(c && c.repo));
    (LS.get('c.hist', null) || LS.get('offline.feed', null) || []).forEach(ev => addName(ev && ev.repo && ev.repo.name));
    const list = names.slice(0, 8).map(n => ({ full_name: n }));
    for (const r of list) {
      try {
        const cs = await feedFallback('/repos/' + r.full_name + '/commits');
        (cs || []).forEach(c => items.push({ repo: r.full_name, sha: c.sha,
          msg: (c.commit && c.commit.message) || '(no message)',
          date: (c.commit && c.commit.author && c.commit.author.date) || '',
          av: (c.author && c.author.avatar_url) || '' }));
      } catch (e) { }
      if (items.length >= 60) break;
    }
  } catch (e) { }
  return items;
}

/* long-press support on commit rows */
function wireCommitRows() {
  $$('#view .lrow[data-go^="#/commit/"]').forEach(el => {
    let t = null, fired = false;
    const start = () => { fired = false; clearTimeout(t); t = setTimeout(() => { fired = true; try { navigator.vibrate && navigator.vibrate(15); } catch (e) {} commitOptionsSheet(el.dataset.repo, el.dataset.sha, (el.querySelector('.ltitle') || {}).textContent || ''); }, 480); };
    const stop = () => clearTimeout(t);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', stop, { passive: true });
    el.addEventListener('touchend', e => { stop(); if (fired) e.preventDefault(); }, false);
    el.addEventListener('touchcancel', stop);
    el.addEventListener('contextmenu', e => { if (fired) e.preventDefault(); });
    el.addEventListener('click', e => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); setTimeout(() => fired = false, 500); } }, true);
  });
}

/* long-press sheet: view / revert / rollback any commit */
async function commitOptionsSheet(full, sha, title) {
  if (!full || !sha) return;
  const parts = full.split('/');
  const o = parts[0], n = parts.slice(1).join('/');
  openSheet('<div class="sheethead"><b>' + esc(title || String(sha).slice(0, 7)) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:0 4px 4px">' + esc(full) + ' \u00b7 <span class="chip">' + esc(String(sha).slice(0, 7)) + '</span></p>' +
    '<button class="btn primary btnblock" id="coView">View commit</button>' +
    '<button class="btn ghost btnblock" id="coRevert" style="margin-top:8px">Revert changes</button>' +
    '<button class="btn danger btnblock" id="coRollback" style="margin-top:8px">Rollback \u2014 remove commits</button>');
  $('#coView').addEventListener('click', () => { closeSheet(); location.hash = '#/commit/' + full + '/' + sha; });
  $('#coRevert').addEventListener('click', async () => {
    const b = $('#coRevert');
    b.textContent = 'Loading\u2026';
    try {
      const c = await api('/repos/' + full + '/commits/' + sha);
      if (!c.files || !c.files.length) throw new Error('no file changes to revert');
      if (!c.parents || !c.parents.length) throw new Error('the first commit cannot be reverted');
      b.textContent = 'Reverting\u2026';
      await doRevertCommit(o, n, c);
      closeSheet();
      toast('Reverted \u2014 a new commit undoes these changes');
      try { route(); } catch (e) {}
    } catch (e) { b.textContent = 'Revert changes'; toast('Failed: ' + e.message); }
  });
  $('#coRollback').addEventListener('click', async () => {
    const b = $('#coRollback');
    b.textContent = 'Checking\u2026';
    try {
      const c = await api('/repos/' + full + '/commits/' + sha);
      if (!c.parents || !c.parents.length) throw new Error('nothing before this commit to roll back to');
      const repo = await api('/repos/' + full);
      const branch = repo.default_branch || 'main';
      const list = await api('/repos/' + full + '/commits?per_page=100');
      const idx = list.findIndex(x => x.sha === sha);
      if (idx < 0) throw new Error('this commit is not on ' + branch);
      b.textContent = 'Rollback';
      rollbackSheet(o, n, c, branch, idx + 1);
    } catch (e) { b.textContent = 'Rollback \u2014 remove commits'; toast('Failed: ' + e.message); }
  });
}

async function renderCommit(o, n, sha) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let c;
  try { c = await api('/repos/' + full + '/commits/' + sha); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  const lines = (c.commit && c.commit.message ? c.commit.message : '').split('\n');
  const title = lines[0];
  const rest = lines.slice(1).join('\n').trim();
  const who = c.author ? c.author.login : (c.commit && c.commit.author ? c.commit.author.name : 'unknown');
  const av = c.author ? c.author.avatar_url : '';
  let html = '<div class="card"><div class="crow">' + (av ? '<img class="cav" src="' + esc(av) + '" alt="">' : SVG.commit) +
    '<b data-go="#/user/' + esc(who) + '">' + esc(who) + '</b><span class="chip">' + c.sha.slice(0, 7) + '</span></div>' +
    '<div class="ihtitle">' + esc(title) + '</div>' +
    (rest ? '<p class="rcdesc" style="-webkit-line-clamp:8">' + esc(rest) + '</p>' : '') +
    '<div class="ihmeta">' + tAgo(c.commit && c.commit.author ? c.commit.author.date : '') + (c.commit && c.commit.verification && c.commit.verification.verified ? ' · verified' : '') + '</div>';
  if (c.stats) {
    html += '<div class="commitstats">' +
      '<div class="cstat add">+' + nf(c.stats.additions) + '<span>additions</span></div>' +
      '<div class="cstat del">-' + nf(c.stats.deletions) + '<span>deletions</span></div>' +
      '<div class="cstat total">' + nf(c.stats.total) + '<span>changes</span></div></div>';
  }
  if ((c.files && c.files.length) || (c.parents && c.parents.length && c.parents[0].sha)) {
    html += '<div class="actionrow" style="margin-top:12px">';
    if (c.files && c.files.length) html += '<button class="btn" id="cRevert">Revert changes</button>';
    if (c.parents && c.parents.length && c.parents[0].sha) html += '<button class="btn danger" id="cRollback">Rollback</button>';
    html += '</div>';
  }
  html += '</div>';
  html += await checksHTML(o, n, c.sha).catch(() => '');
  html += '<h2 class="sect">Changed files (' + (c.files ? c.files.length : 0) + ')</h2>';
  if (!c.files || !c.files.length) html += '<div class="card empty">No file changes listed.</div>';
  else c.files.slice(0, 40).forEach(f => {
    html += '<div class="card"><div class="filehead" data-go="#/commitfile/' + full + '/' + c.sha + '/' + encodeURIComponent(f.filename) + '">' + SVG.file +
      '<b style="font-size:13px;word-break:break-all">' + esc(f.filename) + '</b>' +
      (f.status === 'added' ? '<span class="chip add">added</span>' : f.status === 'removed' ? '<span class="chip del">removed</span>' : f.status === 'renamed' ? '<span class="chip">renamed</span>' : '<span class="chip">modified</span>') + '</div>';
    if (f.patch) {
      const ls = f.patch.split('\n').slice(0, 400);
      html += '<div class="patchpre">' + ls.map(l => {
        let cls = '';
        if (l.startsWith('+')) cls = 'add'; else if (l.startsWith('-')) cls = 'del'; else if (l.startsWith('@@')) cls = 'hh';
        return '<div class="pline ' + cls + '">' + esc(l || ' ') + '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';
  });
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  const rv = $('#cRevert');
  if (rv) rv.addEventListener('click', async () => {
    rv.textContent = 'Reverting\u2026';
    try {
      await doRevertCommit(o, n, c);
      toast('Reverted \u2014 a new commit undoes these changes');
      location.hash = '#/repo/' + full + '/commits';
    } catch (e) { rv.textContent = 'Revert changes'; toast('Failed: ' + e.message); }
  });
  const rb = $('#cRollback');
  if (rb) rb.addEventListener('click', async () => {
    rb.textContent = 'Checking\u2026';
    let cnt = -1, branch = '';
    try {
      const repo = await api('/repos/' + full);
      branch = repo.default_branch || 'main';
      const list = await api('/repos/' + full + '/commits?per_page=100');
      const idx = list.findIndex(x => x.sha === c.sha);
      cnt = idx < 0 ? -2 : idx + 1;
    } catch (e) {}
    rb.textContent = 'Rollback';
    if (cnt === -2) { toast('This commit is not on ' + (branch || 'the default branch') + ' \u2014 rollback is not available'); return; }
    if (cnt < 1) { toast('Could not check the branch \u2014 try again'); return; }
    rollbackSheet(o, n, c, branch, cnt);
  });
}

/* revert = new commit that restores the parent state for every path this commit touched */
async function doRevertCommit(o, n, c) {
  const repo = await api('/repos/' + o + '/' + n);
  const branch = repo.default_branch || 'main';
  const head = await api('/repos/' + o + '/' + n + '/git/ref/heads/' + branch);
  const headCommit = await api('/repos/' + o + '/' + n + '/git/commits/' + head.object.sha);
  const pCommit = await api('/repos/' + o + '/' + n + '/git/commits/' + c.parents[0].sha);
  const pTree = await api('/repos/' + o + '/' + n + '/git/trees/' + pCommit.tree.sha + '?recursive=1');
  const byPath = {};
  (pTree.tree || []).forEach(t => { if (t.type === 'blob') byPath[t.path] = t; });
  const tree = [];
  (c.files || []).slice(0, 300).forEach(f => {
    if (f.status === 'renamed') {
      const old = byPath[f.previous_filename];
      tree.push({ path: f.previous_filename, mode: old ? old.mode : '100644', type: 'blob', sha: old ? old.sha : null });
      tree.push({ path: f.filename, mode: '100644', type: 'blob', sha: null });
    } else {
      const e = byPath[f.filename];
      tree.push({ path: f.filename, mode: e ? e.mode : '100644', type: 'blob', sha: e ? e.sha : null });
    }
  });
  if (!tree.length) throw new Error('Nothing to revert');
  const newTree = await api('/repos/' + o + '/' + n + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
  const msg = 'Revert "' + (c.commit && c.commit.message ? c.commit.message : '').split('\n')[0] + '"\n\nThis reverts commit ' + c.sha + '.';
  const nc = await api('/repos/' + o + '/' + n + '/git/commits', { method: 'POST', body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [head.object.sha] }) });
  await api('/repos/' + o + '/' + n + '/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: nc.sha }) });
}

/* rollback = force-move the branch ref to this commit's parent, dropping it and everything after */
function rollbackSheet(o, n, c, branch, cnt) {
  openSheet('<div class="sheethead"><b>Rollback ' + esc(branch) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 14px">This permanently removes <b>' + cnt + ' commit' + (cnt === 1 ? '' : 's') + '</b> \u2014 the one you are viewing and every commit made after it \u2014 from ' + esc(branch) + '. The changes will be gone. Anyone who already pulled a copy may still have them.</p>' +
    '<button class="btn danger btnblock" id="rbGo">Remove ' + cnt + ' commit' + (cnt === 1 ? '' : 's') + '</button>');
  $('#rbGo').addEventListener('click', async () => {
    const b = $('#rbGo');
    b.textContent = 'Removing\u2026';
    try {
      await api('/repos/' + o + '/' + n + '/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: c.parents[0].sha, force: true }) });
      location.hash = '#/repo/' + o + '/' + n + '/commits';
      toast('Rolled back \u2014 ' + cnt + ' commit' + (cnt === 1 ? '' : 's') + ' removed');
    } catch (e) { b.textContent = 'Remove ' + cnt + ' commit' + (cnt === 1 ? '' : 's'); toast('Failed: ' + e.message); }
  });
}

/* asks for a custom commit message before an upload commits */
function commitMsgSheet(title, prefill, onGo, onCancel) {
  openSheet('<div class="sheethead"><b>' + esc(title) + '</b><button class="iconbtn" id="cmX" aria-label="close">' + SVG.x + '</button></div>' +
    commitComposer('cm', prefill) +
    '<button class="btn primary btnblock" id="cmGo" style="margin-top:16px">Commit</button>');
  const inp = $('#cmTitle');
  try { if (inp) inp.focus(); } catch (e) { }
  $('#cmX').addEventListener('click', () => { closeSheet(); if (onCancel) onCancel(); });
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') $('#cmGo').click(); });
  $('#cmGo').addEventListener('click', () => { const m = commitMsg('cm', prefill); closeSheet(); onGo(m); });
}

/* full file content at a commit, plus its diff \u2014 GitHub-style "view file" */
async function renderCommitFile(o, n, sha, path) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const res = await Promise.allSettled([
    api('/repos/' + full + '/commits/' + sha),
    api('/repos/' + full + '/contents/' + path + '?ref=' + sha)
  ]);
  if (seq !== RSEQ) return;
  const c = res[0].status === 'fulfilled' ? res[0].value : null;
  const meta = res[1].status === 'fulfilled' ? res[1].value : null;
  if (!c && !meta) { view().innerHTML = errCard(res[0].reason || res[1].reason); return; }
  const f = c ? (c.files || []).find(x => x.filename === path) : null;
  const cmsg = c && c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '';
  let raw = '';
  if (meta && typeof meta.content === 'string' && meta.encoding === 'base64') {
    const b64 = meta.content.replace(/\n/g, '');
    try { raw = decodeURIComponent(escape(atob(b64))); } catch (e2) { raw = atob(b64); }
  }
  const headSha = (c && c.sha) || sha;
  let html = '<div class="card"><div class="filehead">' + SVG.file +
    '<b style="font-size:13px;word-break:break-all">' + esc(path) + '</b></div>' +
    '<div class="ihmeta">at commit ' + headSha.slice(0, 7) + (cmsg ? ' \u00b7 ' + esc(cmsg) : '') +
    (f ? ' \u00b7 <span class="chip add">+' + nf(f.additions || 0) + '</span> <span class="chip del">-' + nf(f.deletions || 0) + '</span>' : '') + '</div>' +
    '<div class="seg" style="margin-top:12px"><button class="segb on" id="cfTabFile">File</button><button class="segb" id="cfTabDiff">Changes</button></div></div>';
  let fileBlock;
  if (raw) {
    const MAX = 60000;
    let shown = raw, cut = false;
    if (raw.length > MAX) { shown = raw.slice(0, MAX); cut = true; }
    const ls = shown.split('\n');
    if (ls.length > 2000) { shown = ls.slice(0, 2000).join('\n'); cut = true; }
    fileBlock = '<div class="card">' + codeWithLines(shown || '') + (cut ? '<div class="lsub" style="padding:0 14px 12px">\u2026 \u2014 truncated for display</div>' : '') + '</div>';
  } else {
    fileBlock = '<div class="card empty">' + (f && f.status === 'removed' ? 'This file was deleted in this commit \u2014 no content exists at this commit.' : 'This file cannot be previewed here (binary or too large).') +
      (meta && meta.download_url ? '<br><button class="btn ghost" style="margin-top:12px" data-act="download" data-url="' + esc(meta.download_url) + '" data-name="' + esc(path.split('/').pop()) + '">Download</button>' : '') + '</div>';
  }
  let diffBlock;
  if (f && f.patch) {
    const ls = f.patch.split('\n').slice(0, 3000);
    diffBlock = '<div class="card"><div class="patchpre">' + ls.map(l => {
      let cls = '';
      if (l.startsWith('+')) cls = 'add'; else if (l.startsWith('-')) cls = 'del'; else if (l.startsWith('@@')) cls = 'hh';
      return '<div class="pline ' + cls + '">' + esc(l || ' ') + '</div>';
    }).join('') + '</div></div>';
  } else if (f && f.status === 'added') diffBlock = '<div class="card empty">This file was added in this commit \u2014 see the File tab for its full content.</div>';
  else if (f && f.status === 'removed') diffBlock = '<div class="card empty">This file was deleted in this commit \u2014 there is nothing to show.</div>';
  else diffBlock = '<div class="card empty">No inline diff available for this file.</div>';
  html += '<div id="cfFile">' + fileBlock + '</div><div id="cfDiff" style="display:none">' + diffBlock + '</div>';
  view().innerHTML = html;
  const tF = $('#cfTabFile'), tD = $('#cfTabDiff');
  if (tF && tD) {
    tF.addEventListener('click', () => { tF.classList.add('on'); tD.classList.remove('on'); $('#cfFile').style.display = ''; $('#cfDiff').style.display = 'none'; });
    tD.addEventListener('click', () => { tD.classList.add('on'); tF.classList.remove('on'); $('#cfFile').style.display = 'none'; $('#cfDiff').style.display = ''; });
  }
}

async function renderReleases(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  const canWrite = await canPushRepo(o, n);
  if (seq !== RSEQ) return;
  let items;
  try { items = await api('/repos/' + full + '/releases?per_page=30'); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  if (!items.length) { view().innerHTML = (canWrite ? '<button class="btn ghost btnblock" id="newRelBtn" style="margin-bottom:12px">New release</button>' : '') + '<div class="card empty">No releases published yet.' + (canWrite ? '<br><span class="dim">Create one above — tag a version, describe it, done.</span>' : '') + '</div><input type="file" id="relUpInput" hidden>'; if (canWrite) $('#newRelBtn').addEventListener('click', () => newReleaseSheet(o, n)); return; }
  let html = (canWrite ? '<button class="btn ghost btnblock" id="newRelBtn" style="margin-bottom:12px">New release</button>' : '') + '<input type="file" id="relUpInput" hidden>';
  items.forEach(rl => {
    html += '<div class="card">' +
      '<div class="rcrow"><div class="rcname">' + esc(rl.name || rl.tag_name) + '</div>' +
      '<span class="chip">' + esc(rl.tag_name) + '</span></div>' +
      '<div class="chips">' + (rl.prerelease ? '<span class="chip warn">pre-release</span>' : '') +
      (rl.draft ? '<span class="chip">draft</span>' : '') + '</div>' +
      (rl.body ? '<div class="relbody">' + esc(rl.body) + '</div>' : '') +
      '<div class="rcmeta">' + tAgo(rl.published_at) + (rl.author ? ' · by ' + esc(rl.author.login) : '') + '</div>';
    // release assets — in-app downloads
    if (rl.assets && rl.assets.length) {
      html += '<div class="assetlist">';
      rl.assets.forEach(a => {
        html += '<div class="lrow" data-act="download" data-url="' + esc(a.browser_download_url) + '" data-name="' + esc(a.name) + '" data-api="https://api.github.com/repos/' + esc(full) + '/releases/assets/' + a.id + '" data-accept="application/octet-stream">' + SVG.dl +
          '<div class="lmain"><div class="ltitle">' + esc(a.name) + '</div>' +
          '<div class="lsub">' + fmtSize(a.size) + ' · ' + nf(a.download_count) + ' downloads</div></div>' +
          (canWrite ? '<button class="iconbtn" data-act="delasset" data-full="' + esc(full) + '" data-aid="' + a.id + '" data-aname="' + esc(a.name) + '" aria-label="delete file">' + SVG.x + '</button>' : '') + '</div>';
      });
      html += '</div>';
    }
    // source code archives
    html += '<div class="assetlist">' +
      '<div class="lrow" data-act="download" data-url="https://github.com/' + full + '/archive/refs/tags/' + esc(rl.tag_name) + '.zip" data-name="' + esc(n + '-' + rl.tag_name + '.zip') + '">' + SVG.dl +
      '<div class="lmain"><div class="ltitle">Source code (zip)</div><div class="lsub">complete snapshot of ' + esc(rl.tag_name) + '</div></div></div>' +
      '<div class="lrow" data-act="download" data-url="https://github.com/' + full + '/archive/refs/tags/' + esc(rl.tag_name) + '.tar.gz" data-name="' + esc(n + '-' + rl.tag_name + '.tar.gz') + '">' + SVG.dl +
      '<div class="lmain"><div class="ltitle">Source code (tar.gz)</div><div class="lsub">complete snapshot of ' + esc(rl.tag_name) + '</div></div></div>' +
      '</div>' +
      (canWrite ? '<div style="display:flex;gap:8px;margin-top:12px"><button class="btn sm ghost" data-act="relup" data-relup="' + rl.id + '" data-full="' + esc(full) + '" style="flex:1">Upload files</button>' +
      '<button class="btn sm ghost" data-rel="' + rl.id + '" style="flex:1">Edit release</button></div></div>' : '</div>');
  });
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  $$('[data-rel]').forEach(b => b.addEventListener('click', () => {
    const rl = items.find(x => String(x.id) === b.dataset.rel);
    if (rl) editReleaseSheet(o, n, rl);
  }));
  const nb = $('#newRelBtn');
  if (nb) nb.addEventListener('click', () => newReleaseSheet(o, n));
  $('#relUpInput').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    const rid = window._relTarget;
    e.target.value = '';
    if (!f || !rid) return;
    toast('Uploading ' + f.name + '…');
    try { await uploadAsset(full, rid, f); toast('Uploaded ' + f.name); renderReleases(o, n); }
    catch (er) { toast('Failed: ' + er.message); }
  });
}

function cloneSheet(full) {
  const https = 'https://github.com/' + full + '.git';
  const ssh = 'git@github.com:' + full + '.git';
  openSheet('<div class="sheethead"><b>Clone ' + esc(full) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">HTTPS</label>' +
    '<div class="clonebar"><input class="fld" readonly value="' + esc(https) + '"><button class="iconbtn" data-act="copy" data-copy="' + esc(https) + '">' + SVG.copy + '</button></div>' +
    '<label class="fldlabel" style="margin-top:12px">SSH</label>' +
    '<div class="clonebar"><input class="fld" readonly value="' + esc(ssh) + '"><button class="iconbtn" data-act="copy" data-copy="' + esc(ssh) + '">' + SVG.copy + '</button></div>' +
    '<button class="btn primary btnblock" style="margin-top:16px" data-act="download" data-url="https://github.com/' + full + '/archive/HEAD.zip" data-name="' + esc(full.split('/')[1]) + '-main.zip">Download ZIP</button>');
}

async function renderRepoIssues(o, n) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let items;
  try { items = await api('/repos/' + o + '/' + n + '/issues?state=all&sort=updated&per_page=50'); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  const newBtn = '<button class="btn ghost btnblock" id="newIssueBtn" style="margin-bottom:12px">New issue</button>';
  if (!items.length) {
    if (seq !== RSEQ) return;
    view().innerHTML = newBtn + '<div class="card empty">' + esc(i18n('noIssues')) + '</div>';
    $('#newIssueBtn').addEventListener('click', () => newIssueSheet(o, n));
    return;
  }
  if (seq !== RSEQ) return;
  view().innerHTML = newBtn + sortRowHTML('issues') + '<div class="card list">' + sortItems(items, 'issues').map(issueRow).join('') + '</div>';
  $('#newIssueBtn').addEventListener('click', () => newIssueSheet(o, n));
  wireSortRow('issues', () => renderRepoIssues(o, n));
}

/* ================= repo settings (full GitHub-style screen) ================= */
function tgRow(title, sub, key, on) {
  return '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">' + title + '</div>' + (sub ? '<div class="lsub">' + sub + '</div>' : '') + '</div><button class="switch' + (on ? ' on' : '') + '" data-tg="' + key + '"></button></div>';
}
/* ---------- webhooks ----------
   See, create, edit, ping and delete the webhooks on a repository, plus the
   recent deliveries for one. Creating or changing them needs admin access. */
const HOOK_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'release', 'create', 'delete',
  'fork', 'star', 'watch', 'workflow_run', 'check_run', 'deployment', 'repository', 'ping'];

function hookRow(o, n, h) {
  const cfg = h.config || {};
  const evs = (h.events || []).map(e => e === '*' ? 'all events' : e);
  const evText = evs.length > 3 ? evs.slice(0, 3).join(', ') + ' +' + (evs.length - 3) + ' more' : evs.join(', ');
  return '<div class="card"><div class="rcrow"><div class="rcname" style="word-break:break-all">' + esc(cfg.url || '(no url)') + '</div>' +
    '<span class="chip' + (h.active ? ' ok' : '') + '">' + (h.active ? 'Active' : 'Paused') + '</span></div>' +
    '<div class="lsub" style="margin-top:4px;white-space:normal">' + esc(evText || 'no events') +
    (cfg.content_type ? ' \u00b7 ' + esc(cfg.content_type) : '') + (cfg.secret ? ' \u00b7 signed' : '') + '</div>' +
    '<div class="actionrow" style="margin-top:12px">' +
    '<button class="btn sm ghost" data-act="hookping" data-id="' + h.id + '" data-full="' + esc(o + '/' + n) + '">Ping</button>' +
    '<button class="btn sm ghost" data-act="hooktoggle" data-id="' + h.id + '" data-full="' + esc(o + '/' + n) + '" data-on="' + (h.active ? '1' : '0') + '">' + (h.active ? 'Pause' : 'Enable') + '</button>' +
    '<button class="btn sm ghost" data-act="hookdeliv" data-id="' + h.id + '" data-full="' + esc(o + '/' + n) + '">Deliveries</button>' +
    '<button class="btn sm danger" data-act="hookdel" data-id="' + h.id + '" data-full="' + esc(o + '/' + n) + '" data-url="' + esc(cfg.url || '') + '">Delete</button>' +
    '</div></div>';
}
async function renderRepoHooks(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const canWrite = await canPushRepo(o, n).catch(() => false);
  if (seq !== RSEQ) return;
  let hooks;
  try { hooks = await api('/repos/' + full + '/hooks'); } catch (e) { if (seq === RSEQ) view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  if (!Array.isArray(hooks)) hooks = [];
  let html = '<div class="card"><div class="ltitle">' + esc(full) + '</div>' +
    '<div class="lsub" style="white-space:normal">' + hooks.length + ' webhook' + (hooks.length === 1 ? '' : 's') +
    ' on this repository. A webhook is a POST request GitHub sends to your URL when something happens.</div></div>';
  html += '<button class="btn primary btnblock" id="hookNew" style="margin-bottom:12px"' + (canWrite ? '' : ' disabled') + '>New webhook</button>';
  html += hooks.length ? hooks.map(h => hookRow(o, n, h)).join('') : '<div class="card empty">No webhooks yet.<br><span class="dim">Add one to have GitHub call your own service.</span></div>';
  html += '<button class="btn ghost btnblock" style="margin-top:12px" data-go="#/repo/' + full + '/settings">Back to settings</button>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  const nb = $('#hookNew');
  if (nb && canWrite) nb.addEventListener('click', () => newHookSheet(o, n));
}
function newHookSheet(o, n) {
  const full = o + '/' + n;
  openSheet('<div class="sheethead"><b>New webhook</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Payload URL</label>' +
    '<input class="fld" id="hkUrl" placeholder="https://example.com/hook" autocomplete="off" spellcheck="false">' +
    '<label class="fldlabel" style="margin-top:12px">Secret (optional)</label>' +
    '<input class="fld" id="hkSecret" placeholder="used to sign each delivery" autocomplete="off" spellcheck="false">' +
    '<label class="fldlabel" style="margin-top:12px">Content type</label>' +
    '<div class="seg"><button class="segb on" data-hkc="json">application/json</button><button class="segb" data-hkc="form">form</button></div>' +
    '<label class="fldlabel" style="margin-top:14px">Events</label>' +
    '<div class="lblpick" id="hkEvents">' + HOOK_EVENTS.map(e =>
      '<button class="lblpickb' + (e === 'push' ? ' on' : '') + '" data-hke="' + esc(e) + '">' + esc(e) + '</button>').join('') + '</div>' +
    '<button class="btn primary btnblock" id="hkGo" style="margin-top:16px">Add webhook</button>' +
    '<p class="tiny" style="margin-top:10px">Only events you pick are sent. GitHub sends a test "ping" straight away so you can check the URL works.</p>');
  let ctype = 'json';
  $$('[data-hkc]').forEach(b => b.addEventListener('click', () => {
    ctype = b.dataset.hkc;
    $$('[data-hkc]').forEach(x => x.classList.toggle('on', x === b));
  }));
  $$('[data-hke]').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  const go = $('#hkGo');
  if (go) go.addEventListener('click', async () => {
    const url = ($('#hkUrl').value || '').trim();
    if (!/^https?:\/\//i.test(url)) { toast('Enter a full http(s) URL'); return; }
    const events = $$('[data-hke]').filter(b => b.classList.contains('on')).map(b => b.dataset.hke);
    if (!events.length) { toast('Pick at least one event'); return; }
    const secret = ($('#hkSecret').value || '').trim();
    go.disabled = true;
    try {
      await api('/repos/' + full + '/hooks', { method: 'POST', body: JSON.stringify({
        name: 'web', active: true, events: events,
        config: { url: url, content_type: ctype === 'form' ? 'form' : 'json', secret: secret || undefined }
      }) });
      closeSheet(); toast('Webhook added — GitHub is sending a test ping');
      renderRepoHooks(o, n);
    } catch (e) { toast('Failed: ' + e.message); go.disabled = false; }
  });
}
async function hookDeliveries(full, id) {
  openSheet('<div class="sheethead"><b>Recent deliveries</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div><div id="hdList">' + spinner(true) + '</div>');
  let list;
  try { list = await api('/repos/' + full + '/hooks/' + id + '/deliveries?per_page=30'); }
  catch (e) { const l = $('#hdList'); if (l) l.innerHTML = errCard(e); return; }
  const l = $('#hdList');
  if (!l) return;
  if (!Array.isArray(list) || !list.length) { l.innerHTML = '<div class="card empty">No deliveries recorded yet.</div>'; return; }
  l.innerHTML = '<div class="card">' + list.map((d, i) =>
    '<div class="lrow" style="padding:10px 0' + (i ? ';border-top:1px solid var(--divider)' : '') + '">' +
    '<div class="lmain"><div class="ltitle">' + esc(d.event || 'event') + ' \u00b7 HTTP ' + esc(String(d.status_code || d.status || '')) + '</div>' +
    '<div class="lsub">' + esc(tAgo(d.delivered_at)) + (d.redelivery ? ' \u00b7 redelivery' : '') + '</div></div>' +
    '<span class="chip' + ((d.status === 'OK' || (d.status_code >= 200 && d.status_code < 300)) ? ' ok' : '') + '">' + esc(d.status || '') + '</span></div>').join('') + '</div>';
}

async function renderRepoSettings(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const canWrite = await canPushRepo(o, n);
  if (seq !== RSEQ) return;
  if (!canWrite) { view().innerHTML = '<div class="card empty">You do not have permission to change this repository\u2019s settings.</div>'; return; }
  let r;
  try { r = await api('/repos/' + full); } catch (e) { if (seq === RSEQ) view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  const branches = await api('/repos/' + full + '/branches?per_page=100').catch(() => []);
  if (seq !== RSEQ) return;
  const lzOpen = {};
  let lzLoaders = {};
  /* reload a section after a change, but only if it has been opened */
  const lzRefresh = key => { if (lzOpen[key] && lzLoaders[key]) lzLoaders[key](); };
  let html = '';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 12px;font-size:15px">General</div>' +
    '<label class="fldlabel">Repository name</label><input class="fld" id="rsName" value="' + esc(r.name || '') + '" autocomplete="off" spellcheck="false">' +
    '<label class="fldlabel" style="margin-top:12px">Description</label><input class="fld" id="rsDesc" value="' + esc(r.description || '') + '" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Homepage</label><input class="fld" id="rsHome" value="' + esc(r.homepage || '') + '" placeholder="https://…" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Default branch</label><select class="fld" id="rsBranch">' +
    ((branches || []).map(b => '<option value="' + esc(b.name) + '"' + (b.name === r.default_branch ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') || '<option value="' + esc(r.default_branch || 'main') + '">' + esc(r.default_branch || 'main') + '</option>') +
    '</select><button class="btn primary btnblock" id="rsSave" style="margin-top:16px">Save changes</button></div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Features</div>' +
    tgRow('Issues', 'Issue tracker for this repo', 'has_issues', r.has_issues) +
    tgRow('Wiki', 'Editable wiki pages', 'has_wiki', r.has_wiki) +
    tgRow('Projects', 'Repo projects and task boards', 'has_projects', r.has_projects) +
    tgRow('Discussions', 'Community discussion forum', 'has_discussions', r.has_discussions) +
    tgRow('Template repository', 'Others can generate new repos from it', 'is_template', r.is_template) +
    tgRow('Private repository', 'Only you and collaborators can see it', 'private', r.private) + '</div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Pull requests</div>' +
    tgRow('Allow merge commits', 'Merge with a merge commit', 'allow_merge_commit', r.allow_merge_commit) +
    tgRow('Allow squash merging', 'Squash all commits into one', 'allow_squash_merge', r.allow_squash_merge) +
    tgRow('Allow rebase merging', 'Rebase and fast-forward', 'allow_rebase_merge', r.allow_rebase_merge) +
    tgRow('Allow auto-merge', 'Merge automatically when checks pass', 'allow_auto_merge', r.allow_auto_merge) +
    tgRow('Auto-delete head branches', 'Delete branches after merging', 'delete_branch_on_merge', r.delete_branch_on_merge) +
    tgRow('Allow forking', 'Let others fork this private repo', 'allow_forking', r.allow_forking) + '</div>';
  html += '<div class="card lzcard" data-lz="collab"><div class="rcrow" data-lzhead><div class="rcname">Collaborators<span class="lzchev">\u203a</span></div><button class="btn sm ghost" id="rsAddCollab">Add</button></div><div id="rsCollabList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" data-lz="branches"><div class="rcrow" data-lzhead><div class="rcname">Branches<span class="lzchev">\u203a</span></div></div><div id="rsBranchList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" data-lz="tags"><div class="rcrow" data-lzhead><div class="rcname">Tags<span class="lzchev">\u203a</span></div></div><div id="rsTagList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" data-lz="hooks"><div class="rcrow" data-lzhead><div class="rcname">Webhooks<span class="lzchev">\u203a</span></div><button class="btn sm ghost" id="rsAddHook">Add</button></div><div id="rsHookList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" data-lz="keys"><div class="rcrow" data-lzhead><div class="rcname">Deploy keys<span class="lzchev">\u203a</span></div><button class="btn sm ghost" id="rsAddKey">Add</button></div><div id="rsKeyList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" id="pagesCard" data-lz="pages"><div class="rcrow" data-lzhead><div class="rcname">GitHub Pages<span class="lzchev">\u203a</span></div></div></div>';
  html += '<div class="card lzcard" data-lz="envs"><div class="rcrow" data-lzhead><div class="rcname">Environments<span class="lzchev">\u203a</span></div><button class="btn sm ghost" id="rsAddEnv">New</button></div><div id="rsEnvList" data-lzbody style="display:none">' + spinner(true) + '</div></div>';
  html += '<div class="card lzcard" id="ilCard" data-lz="il"><div class="rcrow" data-lzhead><div class="rcname">Interaction limits<span class="lzchev">\u203a</span></div></div></div>';
  html += '<div class="card"><div class="rcrow"><div class="rcname">Branch protection</div></div><div class="lsub" style="margin-top:4px">Require reviews, status checks or admin enforcement before merging into a branch.</div><label class="fldlabel" style="margin-top:12px">Branch</label><select class="fld" id="bpBranch"></select><button class="btn ghost btnblock" id="bpEdit" style="margin-top:14px">Protection rules</button></div>';
  html += '<div class="card"><div class="rcrow"><div class="rcname">Webhooks</div><button class="btn sm ghost" data-go="#/repo/' + full + '/hooks">Manage</button></div><div class="lsub" style="margin-top:4px">Send a request to a URL you choose whenever something happens in this repository.</div></div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Danger zone</div>' +
    tgRow('Archived', 'Makes the repository read-only for everyone', 'archived', r.archived) +
    '<div style="display:flex;gap:8px;margin-top:16px"><button class="btn danger" id="rsVisibility" style="flex:1">Change visibility</button><button class="btn danger" id="rsTransfer" style="flex:1">Transfer</button></div>' +
    '<button class="btn danger btnblock" id="rsDelete" style="margin-top:8px">Delete repository</button></div>';
  view().innerHTML = html;
  $('#rsSave').addEventListener('click', async () => {
    const newName = $('#rsName').value.trim();
    if (!newName) { toast('Repository name cannot be empty'); return; }
    if (!/^[A-Za-z0-9._-]+$/.test(newName)) { toast('Name can only use letters, numbers, . _ and -'); return; }
    if (newName.length > 100) { toast('Name is too long (max 100 characters)'); return; }
    const btn = $('#rsSave'); btn.disabled = true;
    try {
      const upd = await api('/repos/' + full, { method: 'PATCH', body: JSON.stringify({ name: newName, description: $('#rsDesc').value.trim(), homepage: $('#rsHome').value.trim() }) });
      const finalName = (upd && upd.name) ? upd.name : newName;
      if (finalName !== n) { toast('Renamed to ' + finalName); location.hash = '#/repo/' + o + '/' + finalName + '/settings'; }
      else { toast('Saved'); btn.disabled = false; }
    } catch (e) { toast('Failed: ' + e.message); btn.disabled = false; }
  });
  $('#rsBranch').addEventListener('change', async e => {
    try { await api('/repos/' + full, { method: 'PATCH', body: JSON.stringify({ default_branch: e.target.value }) }); r.default_branch = e.target.value; toast('Default branch set to ' + e.target.value); lzRefresh('branches'); }
    catch (er) { toast('Failed: ' + er.message); }
  });
  view().querySelectorAll('[data-tg]').forEach(sw => sw.addEventListener('click', async () => {
    const key = sw.dataset.tg;
    const val = !sw.classList.contains('on');
    try {
      if (key === 'archived') await api('/repos/' + full + (val ? '/archive' : '/unarchive'), { method: 'PUT' });
      else await api('/repos/' + full, { method: 'PATCH', body: JSON.stringify({ [key]: val }) });
      sw.classList.toggle('on', val);
      toast('Saved');
    } catch (e) { toast('Failed: ' + e.message); }
  }));
  $('#rsDelete').addEventListener('click', () => deleteRepoSheet(o, n));
  const rsVis = $('#rsVisibility');
  if (rsVis) rsVis.addEventListener('click', () => {
    const makePrivate = !r.private;
    if (!window.confirm(makePrivate ? 'Make this repository private? Only you and collaborators will see it.' : 'Make this repository public? Anyone on the internet can see it.')) return;
    api('/repos/' + full, { method: 'PATCH', body: JSON.stringify({ private: makePrivate }) }).then(() => { toast('Repository is now ' + (makePrivate ? 'private' : 'public')); r.private = makePrivate; })
      .catch(e => toast('Failed: ' + e.message));
  });
  const rsTr = $('#rsTransfer');
  if (rsTr) rsTr.addEventListener('click', () => transferSheet(o, n));
  const bpSel = $('#bpBranch');
  if (bpSel) {
    bpSel.innerHTML = (branches || []).map(b => '<option value="' + esc(b.name) + '"' + (b.name === r.default_branch ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
    const bpe = $('#bpEdit');
    if (bpe) bpe.addEventListener('click', () => { if (bpSel.value) protectionSheet(o, n, bpSel.value); });
  }
  const aenv = $('#rsAddEnv');
  if (aenv) aenv.addEventListener('click', async () => {
    const name = window.prompt('Environment name (e.g. production, github-pages)');
    if (!name) return;
    try { await api('/repos/' + full + '/environments/' + encodeURIComponent(name.trim()), { method: 'PUT', body: JSON.stringify({}) }); toast('Environment created'); loadEnvs(o, n); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const loadCollab = async () => {
    const el = $('#rsCollabList'); if (!el) return;
    try {
      const cols = await api('/repos/' + full + '/collaborators?affiliation=direct');
      el.innerHTML = cols.length ? cols.map(c => '<div class="lrow" style="padding:10px 0">' +
        '<img class="cav" src="' + esc(c.avatar_url) + '" alt=""><div class="lmain"><div class="ltitle">' + esc(c.login) + '</div><div class="lsub">' +
        (c.permissions && c.permissions.admin ? 'admin' : (c.permissions && c.permissions.push ? 'write' : 'read')) + (USER && c.login === USER.login ? ' · you' : '') + '</div></div>' +
        (USER && c.login !== USER.login ? '<button class="iconbtn" data-rmcol="' + esc(c.login) + '" aria-label="remove">' + SVG.x + '</button>' : '') + '</div>').join('') :
        '<div class="lsub" style="padding:10px 0">No collaborators yet — add one above.</div>';
      el.querySelectorAll('[data-rmcol]').forEach(b => b.addEventListener('click', async () => {
        if (!window.confirm('Remove ' + b.dataset.rmcol + ' from this repository?')) return;
        try { await api('/repos/' + full + '/collaborators/' + b.dataset.rmcol, { method: 'DELETE' }); toast('Removed ' + b.dataset.rmcol); loadCollab(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
    } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">' + esc(e.message) + '</div>'; }
  };
  const loadBranches = async () => {
    const el = $('#rsBranchList'); if (!el) return;
    try {
      const bs = await api('/repos/' + full + '/branches?per_page=100');
      el.innerHTML = bs.length ? bs.map(b => '<div class="lrow" style="padding:10px 0">' + SVG.folder +
        '<div class="lmain"><div class="ltitle">' + esc(b.name) + (b.name === r.default_branch ? ' <span class="chip">default</span>' : '') + '</div></div>' +
        (b.name !== r.default_branch ? '<button class="btn sm ghost" data-setdef="' + esc(b.name) + '" style="margin-right:6px">Make default</button><button class="iconbtn" data-rmbr="' + esc(b.name) + '" aria-label="delete">' + SVG.x + '</button>' : '') + '</div>').join('') :
        '<div class="lsub" style="padding:10px 0">No branches.</div>';
      el.querySelectorAll('[data-setdef]').forEach(b => b.addEventListener('click', async () => {
        try { await api('/repos/' + full, { method: 'PATCH', body: JSON.stringify({ default_branch: b.dataset.setdef }) }); r.default_branch = b.dataset.setdef; $('#rsBranch').value = b.dataset.setdef; toast('Default branch set to ' + b.dataset.setdef); loadBranches(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
      el.querySelectorAll('[data-rmbr]').forEach(b => b.addEventListener('click', async () => {
        if (!window.confirm('Delete branch ' + b.dataset.rmbr + '?')) return;
        try { await api('/repos/' + full + '/git/refs/heads/' + b.dataset.rmbr, { method: 'DELETE' }); toast('Branch deleted'); loadBranches(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
    } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">' + esc(e.message) + '</div>'; }
  };
  const loadTags = async () => {
    const el = $('#rsTagList'); if (!el) return;
    try {
      const ts = await api('/repos/' + full + '/tags?per_page=100');
      el.innerHTML = ts.length ? ts.map(t => '<div class="lrow" style="padding:10px 0"><div class="lmain"><div class="ltitle">' + esc(t.name) + '</div><div class="lsub">' + esc((t.commit && t.commit.sha || '').slice(0, 7)) + '</div></div>' +
        '<button class="iconbtn" data-rmtag="' + esc(t.name) + '" aria-label="delete">' + SVG.x + '</button></div>').join('') :
        '<div class="lsub" style="padding:10px 0">No tags yet.</div>';
      el.querySelectorAll('[data-rmtag]').forEach(b => b.addEventListener('click', async () => {
        if (!window.confirm('Delete tag ' + b.dataset.rmtag + '? This can break releases that point to it.')) return;
        try { await api('/repos/' + full + '/git/refs/tags/' + b.dataset.rmtag, { method: 'DELETE' }); toast('Tag deleted'); loadTags(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
    } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">' + esc(e.message) + '</div>'; }
  };
  const loadHooks = async () => {
    const el = $('#rsHookList'); if (!el) return;
    try {
      const hs = await api('/repos/' + full + '/hooks');
      el.innerHTML = hs.length ? hs.map(h => '<div class="lrow" style="padding:10px 0"><div class="lmain"><div class="ltitle" style="word-break:break-all">' + esc((h.config && h.config.url) || 'webhook') + '</div><div class="lsub">' +
        ((h.events || []).join(', ') || 'no events') + (h.active === false ? ' · paused' : '') + '</div></div>' +
        '<button class="iconbtn" data-rmhook="' + h.id + '" aria-label="delete">' + SVG.x + '</button></div>').join('') :
        '<div class="lsub" style="padding:10px 0">No webhooks configured.</div>';
      el.querySelectorAll('[data-rmhook]').forEach(b => b.addEventListener('click', async () => {
        if (!window.confirm('Delete this webhook?')) return;
        try { await api('/repos/' + full + '/hooks/' + b.dataset.rmhook, { method: 'DELETE' }); toast('Webhook deleted'); loadHooks(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
    } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">' + esc(e.message) + '</div>'; }
  };
  const loadKeys = async () => {
    const el = $('#rsKeyList'); if (!el) return;
    try {
      const ks = await api('/repos/' + full + '/keys');
      el.innerHTML = ks.length ? ks.map(k => '<div class="lrow" style="padding:10px 0"><div class="lmain"><div class="ltitle">' + esc(k.title) + (k.read_only ? ' <span class="chip">read-only</span>' : '') + '</div><div class="lsub">' + esc((k.fingerprint || '').replace(/^SHA256:/, '')) + '</div></div>' +
        '<button class="iconbtn" data-rmkey="' + k.id + '" aria-label="delete">' + SVG.x + '</button></div>').join('') :
        '<div class="lsub" style="padding:10px 0">No deploy keys.</div>';
      el.querySelectorAll('[data-rmkey]').forEach(b => b.addEventListener('click', async () => {
        if (!window.confirm('Delete this deploy key?')) return;
        try { await api('/repos/' + full + '/keys/' + b.dataset.rmkey, { method: 'DELETE' }); toast('Key deleted'); loadKeys(); }
        catch (e) { toast('Failed: ' + e.message); }
      }));
    } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">' + esc(e.message) + '</div>'; }
  };
  $('#rsAddCollab').addEventListener('click', () => addCollabSheet(full, loadCollab));
  $('#rsAddHook').addEventListener('click', () => addWebhookSheet(full, loadHooks));
  $('#rsAddKey').addEventListener('click', () => addDeployKeySheet(full, loadKeys));
  /* Each section below asks GitHub for its list only the first time it is opened
     (or when its Add / New button is pressed), instead of all eight on every visit. */
  lzLoaders = { collab: loadCollab, branches: loadBranches, tags: loadTags, hooks: loadHooks, keys: loadKeys,
    pages: () => loadPages(o, n), envs: () => loadEnvs(o, n), il: () => loadIL(o, n) };
  view().querySelectorAll('[data-lz]').forEach(card => {
    const key = card.dataset.lz;
    const head = card.querySelector('[data-lzhead]');
    const body = card.querySelector('[data-lzbody]');
    const openIt = () => {
      lzOpen[key] = 1;
      card.classList.add('lzopen');
      if (body) body.style.display = '';
      else card.insertAdjacentHTML('beforeend', spinner(true));   /* the loader fills the whole card */
      try { lzLoaders[key](); } catch (e) { }
    };
    if (head) head.addEventListener('click', ev => {
      const onBtn = !!(ev.target.closest && ev.target.closest('button'));
      if (!lzOpen[key]) { openIt(); return; }
      if (onBtn || !body) return;
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : '';
      card.classList.toggle('lzopen', !hide);
    });
  });
}
function addCollabSheet(full, after) {
  openSheet('<div class="sheethead"><b>Add collaborator</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">GitHub username</label><input class="fld" id="acUser" placeholder="username" autocomplete="off">' +
    '<button class="btn primary btnblock" id="acGo" style="margin-top:16px">Add</button>');
  $('#acGo').addEventListener('click', async () => {
    const u = $('#acUser').value.trim();
    if (!u) { toast('Enter a username'); return; }
    try {
      await api('/repos/' + full + '/collaborators/' + u, { method: 'PUT', body: JSON.stringify({ permission: 'write' }) });
      closeSheet(); toast('Added ' + u + ' as a collaborator'); after && after();
    } catch (e) { toast('Failed: ' + e.message); }
  });
}
function addWebhookSheet(full, after) {
  openSheet('<div class="sheethead"><b>Add webhook</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Payload URL</label><input class="fld" id="whUrl" placeholder="https://example.com/hook" autocomplete="off">' +
    '<div class="seg sm" style="margin-top:14px"><button class="segb on" id="whEvPush">Push events</button><button class="segb" id="whEvAll">Everything</button></div>' +
    '<div class="lsub" style="margin-top:10px">GitHub will POST repo activity to this URL.</div>' +
    '<button class="btn primary btnblock" id="whGo" style="margin-top:16px">Add webhook</button>');
  let all = false;
  $('#whEvPush').addEventListener('click', () => { all = false; $('#whEvPush').classList.add('on'); $('#whEvAll').classList.remove('on'); });
  $('#whEvAll').addEventListener('click', () => { all = true; $('#whEvAll').classList.add('on'); $('#whEvPush').classList.remove('on'); });
  $('#whGo').addEventListener('click', async () => {
    const url = $('#whUrl').value.trim();
    if (!/^https?:\/\//.test(url)) { toast('Enter a valid https:// URL'); return; }
    try {
      await api('/repos/' + full + '/hooks', { method: 'POST', body: JSON.stringify({ name: 'web', active: true, events: all ? ['*'] : ['push'], config: { url: url, content_type: 'json' } }) });
      closeSheet(); toast('Webhook added'); after && after();
    } catch (e) { toast('Failed: ' + e.message); }
  });
}
function addDeployKeySheet(full, after) {
  openSheet('<div class="sheethead"><b>Add deploy key</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Title</label><input class="fld" id="dkTitle" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Key</label><textarea class="replyta" id="dkKey" placeholder="ssh-ed25519 AAAA…" spellcheck="false"></textarea>' +
    '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Read-only access</div><div class="lsub">This key can pull but not push</div></div><button class="switch on" id="dkRo"></button></div>' +
    '<button class="btn primary btnblock" id="dkGo" style="margin-top:16px">Add key</button>');
  $('#dkRo').addEventListener('click', () => $('#dkRo').classList.toggle('on'));
  $('#dkGo').addEventListener('click', async () => {
    const title = $('#dkTitle').value.trim(), key = $('#dkKey').value.trim();
    if (!title || !key) { toast('Title and key are both required'); return; }
    try {
      await api('/repos/' + full + '/keys', { method: 'POST', body: JSON.stringify({ title: title, key: key, read_only: $('#dkRo').classList.contains('on') }) });
      closeSheet(); toast('Deploy key added'); after && after();
    } catch (e) { toast('Failed: ' + e.message); }
  });
}

function repoPickerSheet(cb) {
  openSheet('<div class="sheethead"><b>Pick a repository</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div id="rpList" style="max-height:60vh;overflow:auto">' + spinner() + '</div>');
  api('/user/repos?per_page=100&sort=pushed').then(repos => {
    const el = $('#rpList');
    if (!el) return;
    if (!repos.length) { el.innerHTML = '<div class="card empty">No repositories found.</div>'; return; }
    el.innerHTML = '<div class="card list">' + repos.map(r =>
      '<div class="lrow" data-pick="' + esc(r.full_name) + '">' + SVG.folder + '<div class="lmain"><div class="ltitle">' + esc(r.name) + '</div><div class="lsub">' + esc(r.full_name) + (r.description ? ' · ' + esc(r.description.slice(0, 60)) : '') + '</div></div></div>').join('') + '</div>';
    $$('[data-pick]').forEach(row => row.addEventListener('click', () => {
      const parts = row.dataset.pick.split('/');
      cb(parts[0], parts[1]);
    }));
  }).catch(e => { const el = $('#rpList'); if (el) el.innerHTML = errCard(e); });
}

function newIssueSheet(o, n) {
  openSheet('<div class="sheethead"><b>New issue — ' + esc(n) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<input class="fld" id="niTitle" placeholder="Issue title" style="margin-bottom:10px">' +
    '<textarea id="niBody" class="replyta" placeholder="Describe the issue…"></textarea>' +
    '<button class="btn primary btnblock" id="niSubmit" style="margin-top:12px">Submit issue</button>');
  $('#niSubmit').addEventListener('click', async () => {
    const title = $('#niTitle').value.trim(), body = $('#niBody').value;
    if (!title) { toast('Add a title first'); return; }
    $('#niSubmit').disabled = true;
    try {
      const iss = await api('/repos/' + o + '/' + n + '/issues', { method: 'POST', body: JSON.stringify({ title, body }) });
      closeSheet(); toast('Issue #' + iss.number + ' created');
      location.hash = '#/issue/' + o + '/' + n + '/' + iss.number;
    } catch (e) { toast('Failed: ' + e.message); $('#niSubmit').disabled = false; }
  });
}

/* ================= create sheets (repo / gist / file / profile) ================= */
function newRepoSheet() {
  openSheet('<div class="sheethead"><b>New repository</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Repository name</label>' +
    '<input class="fld" id="nrName" placeholder="my-awesome-project" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Description (optional)</label>' +
    '<input class="fld" id="nrDesc" placeholder="A short description" autocomplete="off">' +
    '<div class="seg" style="margin:16px 0 0"><button class="segb on" data-vis="private">Private</button><button class="segb" data-vis="public">Public</button></div>' +
    '<div class="setrow" style="margin-top:16px"><div class="lmain"><div class="ltitle">Initialize with README</div><div class="lsub">Adds a starter README.md</div></div><button class="switch" id="nrReadme"></button></div>' +
    '<button class="btn primary btnblock" id="nrSubmit" style="margin-top:18px">Create repository</button>');
  let vis = 'private';
  $$('[data-vis]').forEach(b => b.addEventListener('click', () => { vis = b.dataset.vis; $$('[data-vis]').forEach(x => x.classList.toggle('on', x === b)); }));
  const rmSw = $('#nrReadme');
  rmSw.addEventListener('click', () => rmSw.classList.toggle('on'));
  $('#nrSubmit').addEventListener('click', async () => {
    const name = $('#nrName').value.trim();
    if (!name) { toast('Give your repo a name'); return; }
    $('#nrSubmit').disabled = true;
    try {
      const r = await api('/user/repos', { method: 'POST', body: JSON.stringify({ name, description: $('#nrDesc').value.trim(), private: vis === 'private', auto_init: rmSw.classList.contains('on') }) });
      closeSheet(); toast('Created ' + r.full_name);
      location.hash = '#/repo/' + r.full_name;
    } catch (e) { toast('Failed: ' + e.message); $('#nrSubmit').disabled = false; }
  });
}

function newGistSheet() {
  openSheet('<div class="sheethead"><b>New gist</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Description (optional)</label>' +
    '<input class="fld" id="ngDesc" placeholder="What is this snippet?">' +
    '<label class="fldlabel" style="margin-top:12px">Filename</label>' +
    '<input class="fld" id="ngFile" value="snippet.txt" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Content</label>' +
    '<textarea class="replyta" id="ngBody" placeholder="Paste or write your code here…"></textarea>' +
    '<div class="seg" style="margin:16px 0 0"><button class="segb on" data-gvis="secret">Secret</button><button class="segb" data-gvis="public">Public</button></div>' +
    '<button class="btn primary btnblock" id="ngSubmit" style="margin-top:18px">Create gist</button>');
  let gvis = 'secret';
  $$('[data-gvis]').forEach(b => b.addEventListener('click', () => { gvis = b.dataset.gvis; $$('[data-gvis]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#ngSubmit').addEventListener('click', async () => {
    const fname = $('#ngFile').value.trim() || 'snippet.txt';
    const content = $('#ngBody').value;
    if (!content.trim()) { toast('Write something first'); return; }
    $('#ngSubmit').disabled = true;
    try {
      const files = {}; files[fname] = { content };
      const g = await api('/gists', { method: 'POST', body: JSON.stringify({ description: $('#ngDesc').value.trim(), public: gvis === 'public', files }) });
      closeSheet(); toast('Gist created');
      location.hash = '#/gist/' + g.id;
    } catch (e) { toast('Failed: ' + e.message); $('#ngSubmit').disabled = false; }
  });
}

function addFileSheet(o, n, path, prefill) {
  openSheet('<div class="sheethead"><b>Add file — ' + esc(n + '/' + (path || '')) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Filename</label>' +
    '<input class="fld" id="afName" placeholder="hello.js" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Content</label>' +
    '<textarea class="replyta" id="afBody" placeholder="File contents…"></textarea>' +
    '<label class="fldlabel" style="margin-top:12px">Commit message</label>' +
    commitComposer('af', '', i18n('createFile')) +
    '<button class="btn primary btnblock" id="afSubmit" style="margin-top:18px">Commit file</button>');
  if (prefill) $('#afName').value = prefill;
  $('#afSubmit').addEventListener('click', async () => {
    const fname = $('#afName').value.trim();
    if (!fname) { toast('Give the file a name'); return; }
    const content = $('#afBody').value;
    if (!content) { toast('File is empty'); return; }
    $('#afSubmit').disabled = true;
    try {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      const p = path ? path + '/' + fname : fname;
      const body = { message: commitMsg('af', 'Create ' + fname), content: b64 };
      const meta = await api('/repos/' + o + '/' + n + '/contents/' + p, { status: true }).catch(() => null);
      if (meta && meta.ok && meta.data && meta.data.sha) body.sha = meta.data.sha;
      await api('/repos/' + o + '/' + n + '/contents/' + p, { method: 'PUT', body: JSON.stringify(body) });
      closeSheet(); toast('Committed ' + fname);
      renderFiles(o, n, path);
    } catch (e) { toast('Failed: ' + e.message); $('#afSubmit').disabled = false; }
  });
}

function editProfileSheet() {
  const u = USER || {};
  openSheet('<div class="sheethead"><b>Edit profile</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Name</label>' +
    '<input class="fld" id="epName" value="' + esc(u.name || '') + '">' +
    '<label class="fldlabel" style="margin-top:12px">Bio</label>' +
    '<textarea class="replyta" id="epBio" style="min-height:90px">' + esc(u.bio || '') + '</textarea>' +
    '<label class="fldlabel" style="margin-top:12px">Location</label>' +
    '<input class="fld" id="epLoc" value="' + esc(u.location || '') + '">' +
    '<button class="btn primary btnblock" id="epSubmit" style="margin-top:18px">Save profile</button>');
  $('#epSubmit').addEventListener('click', async () => {
    $('#epSubmit').disabled = true;
    try {
      USER = await api('/user', { method: 'PATCH', body: JSON.stringify({ name: $('#epName').value.trim(), bio: $('#epBio').value.trim(), location: $('#epLoc').value.trim() }) });
      closeSheet(); toast('Profile updated');
      if (location.hash === '#/user/' + USER.login || location.hash === '#/user/' + u.login) renderUser(USER.login); else route();
    } catch (e) { toast('Failed: ' + e.message); $('#epSubmit').disabled = false; }
  });
}

/* ================= repo editing: upload / edit file / release / repo meta ================= */
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
let uplSeq = 0; const uplWait = {};
window.__uplDone = (jid, ok, msg) => {
  try { if (window.OneGit && window.OneGit.clearUploadState) window.OneGit.clearUploadState(); } catch (e) { }
  const w = uplWait[jid]; if (w) { delete uplWait[jid]; ok ? w.res(true) : w.rej(new Error(msg || 'upload failed')); } };
/* byte progress for a single release asset, reported by the native side */
window.__uplProgress = (jid, sent, total) => {
  const w = uplWait[jid];
  if (!w) return;
  const pct = total ? Math.round(sent / total * 100) : 0;
  upProgUpdate((w.name || 'file') + ' — ' + pct + '%', pct);
};
/* per-file progress for the multi-file picker */
window.__assetProgress = (idx, total, pct, name) => {
  upProgUpdate('File ' + idx + ' of ' + total + ' · ' + (name || '') + ' — ' + pct + '%', pct);
};
/* Upload one file to a release. Shows the same progress card the folder upload
   uses, reports the percentage the native side sends back, and raises a toast
   and a system notification when the file lands. keepOpen leaves the card up so
   a batch of files shares one progress display. */
function uploadNotify(name) {
  try { toast('Uploaded ' + name); } catch (e) {}
}
async function uploadAsset(full, id, file, keepOpen, name) {
  /* name lets the release sheet upload a file under a different asset name */
  const nm = name || (file && file.name) || 'file';
  upProgShow('Uploading to release');
  upProgUpdate(nm + ' — preparing…', 0);
  if (window.OneGit && window.OneGit.uploadAsset) {
    const jid = ++uplSeq;
    try {
      const b64 = await fileToB64(file);
      upProgUpdate(nm + ' — 0%', 0);
      await new Promise((res, rej) => {
        uplWait[jid] = { res, rej, name: nm };
        try { window.OneGit.uploadAsset(jid, full, String(id), nm, file.type || 'application/octet-stream', b64); }
        catch (e) { delete uplWait[jid]; rej(e); }
      });
      upProgUpdate('Uploaded ' + nm, 100);
      if (!keepOpen) setTimeout(upProgHide, 2500);
      uploadNotify(nm);
      return true;
    } catch (e) { /* fall through to the fetch path */ }
  }
  try {
    const buf = await file.arrayBuffer();
    upProgUpdate(nm + ' — uploading…', 40);
    const res = await fetch('https://uploads.github.com/repos/' + full + '/releases/' + id + '/assets?name=' + encodeURIComponent(nm), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': file.type || 'application/octet-stream' },
      body: buf
    });
    if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) {} throw new Error((d && d.message) || ('HTTP ' + res.status)); }
    upProgUpdate('Uploaded ' + nm, 100);
    if (!keepOpen) setTimeout(upProgHide, 2500);
    uploadNotify(nm);
    return res.json();
  } catch (e) {
    upProgHide();
    toast('Upload failed: ' + (e.message || 'unknown error'));
    throw e;
  }
}

function editFileSheet(full, path, raw, sha) {
  const name = path.split('/').pop();
  /* A full screen, the way the GitHub app edits a file: the code takes whatever
     height is left and the commit controls stay pinned to the bottom, so they
     never scroll away however long the file is. */
  openSheet('<div class="efhead">' +
    '<button class="iconbtn" data-act="closesheet" aria-label="close">' + SVG.x + '</button>' +
    '<div class="efname"><span class="eftitle">' + esc(i18n('editFileTitle')) + '</span>' +
    '<span class="efsub">' + esc(path) + '</span></div></div>' +
    '<div class="editwrap"><pre class="codeln" id="efGutter" aria-hidden="true"></pre>' +
    '<textarea class="replyta editarea" id="efBody" spellcheck="false" autocapitalize="none"></textarea></div>' +
    '<div class="effoot">' +
    commitComposer('ef', 'Update ' + name) +
    '<div class="btnrow" style="margin-top:12px">' +
    '<button class="btn ghost" id="efRename">' + esc(i18n('rename')) + '</button>' +
    '<button class="btn primary" id="efSave">' + esc(i18n('commitChanges')) + '</button></div></div>');
  { const c = document.querySelector('.sheetcard'); if (c) c.classList.add('efscreen'); }
  const ta = $('#efBody'), gut = $('#efGutter');
  ta.value = raw;
  /* The text wraps, so a logical line can occupy several rows. The gutter is
     measured with a hidden mirror rather than counted, so the numbers stay
     beside the first row of each line. */
  const mirror = document.createElement('div');
  mirror.style.cssText = 'position:absolute;top:-99999px;left:-99999px;visibility:hidden;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;box-sizing:border-box;';
  document.body.appendChild(mirror);
  const paintNums = () => {
    try {
      const cs = getComputedStyle(ta);
      const w = Math.max(40, ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
      mirror.style.width = w + 'px';
      mirror.style.fontFamily = cs.fontFamily; mirror.style.fontSize = cs.fontSize;
      mirror.style.lineHeight = cs.lineHeight; mirror.style.letterSpacing = cs.letterSpacing;
      const lh = parseFloat(cs.lineHeight) || 20;
      const out = [];
      ta.value.split('\n').forEach((ln, i) => {
        mirror.textContent = ln.length ? ln : ' ';
        const rows = Math.max(1, Math.round(mirror.getBoundingClientRect().height / lh));
        out.push(String(i + 1));
        for (let k = 1; k < rows; k++) out.push('');
      });
      gut.textContent = out.join('\n');
      gut.scrollTop = ta.scrollTop;
    } catch (e) { }
  };
  ta.addEventListener('input', paintNums);
  ta.addEventListener('scroll', () => { gut.scrollTop = ta.scrollTop; });
  paintNums();
  { const rb = $('#efRename'); if (rb) rb.addEventListener('click', () => { closeSheet(); renameSheet(full, path, false); }); }
  $('#efSave').addEventListener('click', async () => {
    const content = $('#efBody').value;
    if (content === raw) {
      /* the commit message field is not the file name - point at the right one */
      toast(i18n('noChangesRename'));
      return;
    }
    $('#efSave').disabled = true;
    try {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      await api('/repos/' + full + '/contents/' + path, { method: 'PUT', body: JSON.stringify({ message: commitMsg('ef', 'Update ' + name), content: b64, sha }) });
      closeSheet(); toast('Committed changes');
      const parts = full.split('/'), dir = path.split('/').slice(0, -1).join('/');
      renderFiles(parts[0], parts[1], dir);
    } catch (e) { toast('Failed: ' + e.message); $('#efSave').disabled = false; }
  });
}

function confirmDeleteFile(full, path) {
  const name = path.split('/').pop();
  openSheet('<div class="sheethead"><b>Delete — ' + esc(name) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + spinner(true));
  api('/repos/' + full + '/contents/' + encodeURIComponent(path).replace(/%2F/g, '/')).then(meta => {
    if (meta && meta.sha) deleteFileSheet(full, path, meta.sha);
    else { closeSheet(); toast('Cannot delete this file'); }
  }).catch(e => { closeSheet(); toast('Failed: ' + e.message); });
}

function editReleaseSheet(o, n, rl) {
  const full = o + '/' + n;
  const curTag = (rl.tag_name && rl.tag_name.indexOf('untagged-') === 0) ? '' : (rl.tag_name || '');
  openSheet('<div class="sheethead"><b>Edit release — ' + esc(rl.name || rl.tag_name) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Tag</label>' +
    '<input class="fld" id="xrlTag" value="' + esc(curTag) + '" placeholder="v1.0.0" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Release title</label>' +
    '<input class="fld" id="xrlTitle" value="' + esc(rl.name || rl.tag_name) + '" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Release notes</label>' +
    '<textarea class="replyta" id="xrlBody">' + esc(rl.body || '') + '</textarea>' +
    '<button class="btn primary btnblock" id="xrlSave" style="margin-top:16px">Save release</button>' +
    (rl.draft ? '<label class="fldlabel" style="margin-top:20px">Publish draft</label>' +
      '<div class="lsub" style="margin-bottom:8px">This release is a draft — only you can see it. Publishing makes it public for everyone, using the tag above.</div>' +
      '<button class="btn primary btnblock" id="xrlPublish" style="margin-top:10px">Publish release</button>' : '') +
    '<label class="fldlabel" style="margin-top:20px">Attach files</label>' +
    '<div class="lsub" style="margin-bottom:8px">Uploads go straight into this release</div>' +
    '<button class="btn ghost btnblock" id="xrlFiles">Upload files to this release</button>' +
    '<div id="xrlAssets"></div>' +
    '<input type="file" id="xrlInput" multiple hidden>');
  const drawXAssets = () => {
    const el = $('#xrlAssets');
    if (!el) return;
    const as = rl.assets || [];
    el.innerHTML = as.length ? '<div class="lsub" style="margin-top:12px">Files in this release</div>' + as.map(a =>
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 0">' +
      '<div class="lmain" style="flex:1;min-width:0"><div class="ltitle">' + esc(a.name) + '</div>' +
      '<div class="lsub">' + fmtSize(a.size) + ' · ' + nf(a.download_count) + ' downloads</div></div>' +
      '<button class="iconbtn" data-act="renasset" data-full="' + esc(full) + '" data-aid="' + a.id + '" data-aname="' + esc(a.name) + '" aria-label="rename">' + SVG.pen + '</button>' +
      '<button class="iconbtn" data-act="delasset" data-full="' + esc(full) + '" data-aid="' + a.id + '" data-aname="' + esc(a.name) + '" aria-label="delete">' + SVG.x + '</button></div>').join('') : '';
  };
  drawXAssets();
  $('#xrlSave').addEventListener('click', async () => {
    const tag = ($('#xrlTag').value || '').trim();
    if (/[^A-Za-z0-9._\-+]/.test(tag)) { toast('Tags cannot contain spaces — use letters, numbers, dots, dashes (e.g. First-Stable)'); return; }
    const patch = { name: $('#xrlTitle').value.trim() || rl.tag_name, body: $('#xrlBody').value };
    if (tag && tag !== curTag) patch.tag_name = tag;
    $('#xrlSave').disabled = true;
    try {
      await api('/repos/' + full + '/releases/' + rl.id, { method: 'PATCH', body: JSON.stringify(patch) });
      closeSheet(); toast('Release updated'); renderReleases(o, n);
    } catch (e) { toast('Failed: ' + e.message); $('#xrlSave').disabled = false; }
  });
  const pb = $('#xrlPublish');
  if (pb) pb.addEventListener('click', async () => {
    const tag = ($('#xrlTag').value || '').trim();
    if (!tag) { toast('Enter a tag like v1.0.0'); return; }
    if (/[^A-Za-z0-9._\-+]/.test(tag)) { toast('Tags cannot contain spaces — use letters, numbers, dots, dashes (e.g. First-Stable)'); return; }
    pb.disabled = true;
    try {
      await api('/repos/' + full + '/releases/' + rl.id, { method: 'PATCH', body: JSON.stringify({ tag_name: tag, draft: false, prerelease: !!rl.prerelease }) });
      closeSheet(); toast('Release published'); renderReleases(o, n);
    } catch (e) { toast('Failed: ' + e.message); pb.disabled = false; }
  });
  $('#xrlFiles').addEventListener('click', () => {
    if (window.OneGit && window.OneGit.pickAssets) {
      try {
        window._assetAfter = async () => {
          try {
            const rels = await api('/repos/' + full + '/releases');
            const fresh = (rels || []).find(x => x.id === rl.id);
            if (fresh) { rl.assets = fresh.assets || []; drawXAssets(); }
          } catch (er) {}
          renderReleases(o, n);
        };
        toast('Choose files to attach');
        upProgShow('Uploading to release');
        upProgUpdate('Preparing…', 0);
        window.OneGit.pickAssets(full, String(rl.id));
        return;
      } catch (e) {}
    }
    $('#xrlInput').click();
  });
  $('#xrlInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    upProgShow('Uploading to release');
    upProgUpdate('Uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…', 0);
    let done = 0;
    for (const f of files) {
      try { await uploadAsset(full, rl.id, f, true); done++; }
      catch (er) { toast('Failed: ' + f.name + ' — ' + er.message); }
    }
    upProgUpdate(done ? 'Uploaded ' + done + ' file' + (done > 1 ? 's' : '') : 'No files uploaded', 100);
    setTimeout(upProgHide, 2500);
    toast(done ? 'Uploaded ' + done + ' file' + (done > 1 ? 's' : '') : 'No files uploaded');
    try {
      const rels = await api('/repos/' + full + '/releases');
      const fresh = (rels || []).find(x => x.id === rl.id);
      if (fresh) rl.assets = fresh.assets || [];
    } catch (er) {}
    drawXAssets();
    renderReleases(o, n);
  });
}

function renameAssetSheet(full, aid, name) {
  openSheet('<div class="sheethead"><b>Rename file</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">File name</label>' +
    '<input class="fld" id="raName" value="' + esc(name) + '" autocomplete="off" spellcheck="false">' +
    '<button class="btn primary btnblock" id="raSave" style="margin-top:16px">Rename</button>');
  $('#raName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#raSave').click(); });
  $('#raSave').addEventListener('click', async () => {
    const nn = $('#raName').value.trim();
    if (!nn) { toast('Enter a file name'); return; }
    if (nn === name) { closeSheet(); return; }
    $('#raSave').disabled = true;
    try {
      await api('/repos/' + full + '/releases/assets/' + aid, { method: 'PATCH', body: JSON.stringify({ name: nn }) });
      closeSheet(); toast('Renamed to ' + nn);
      const parts = full.split('/');
      renderReleases(parts[0], parts[1]);
    } catch (e) { toast('Failed: ' + e.message); $('#raSave').disabled = false; }
  });
}

function deleteAssetSheet(full, aid, name) {
  openSheet('<div class="sheethead"><b>Delete file — ' + esc(name) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 14px">Remove this file from the release? People who already downloaded it keep their copy.</p>' +
    '<button class="btn danger btnblock" id="daConfirm">Delete file</button>');
  $('#daConfirm').addEventListener('click', async () => {
    $('#daConfirm').disabled = true;
    try {
      await api('/repos/' + full + '/releases/assets/' + aid, { method: 'DELETE' });
      closeSheet(); toast('Deleted ' + name);
      const parts = full.split('/');
      renderReleases(parts[0], parts[1]);
    } catch (e) { toast('Failed: ' + e.message); $('#daConfirm').disabled = false; }
  });
}

function deleteFileSheet(full, path, sha) {
  const name = path.split('/').pop();
  openSheet('<div class="sheethead"><b>Delete — ' + esc(name) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    commitComposer('df', 'Delete ' + name) +
    '<p class="dim" style="margin:12px 4px 14px">Delete this file from the repository? This creates a commit — it can be reverted on GitHub but not undone from here.</p>' +
    '<button class="btn danger btnblock" id="dfConfirm">Delete file</button>');
  $('#dfConfirm').addEventListener('click', async () => {
    $('#dfConfirm').disabled = true;
    try {
      await api('/repos/' + full + '/contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: commitMsg('df', 'Delete ' + name), sha }) });
      closeSheet(); toast('Deleted ' + name);
      const parts = full.split('/'), dir = path.split('/').slice(0, -1).join('/');
      renderFiles(parts[0], parts[1], dir);
    } catch (e) { toast('Failed: ' + e.message); $('#dfConfirm').disabled = false; }
  });
}

function newReleaseSheet(o, n) {
  openSheet('<div class="sheethead"><b>New release — ' + esc(n) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Tag version</label>' +
    '<input class="fld" id="rlTag" placeholder="v1.0.0" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Release title</label>' +
    '<input class="fld" id="rlTitle" placeholder="Version 1.0.0" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Describe this release</label>' +
    '<textarea class="replyta" id="rlBody" placeholder="What is new in this release…"></textarea>' +
    '<div class="seg" style="margin:16px 0 0"><button class="segb on" data-rls="final">Final</button><button class="segb" data-rls="pre">Pre-release</button><button class="segb" data-rls="draft">Draft</button></div>' +
    '<label class="fldlabel" style="margin-top:20px">Attach files</label>' +
    '<div class="lsub" style="margin-bottom:8px">Picked files upload with the release — tap the pencil to rename one first</div>' +
    '<button class="btn ghost btnblock" id="rlFiles">Choose files</button>' +
    '<div id="rlFileList" style="margin-top:6px"></div>' +
    '<input type="file" id="rlInput" multiple hidden>' +
    '<button class="btn primary btnblock" id="rlPublish" style="margin-top:18px">Publish release</button>');
  let rls = 'final', pending = [], renaming = -1;
  /* each picked file keeps its own upload name, so a file can go up as
     something other than what it is called on the phone */
  const upName = it => it.name || (it.f && it.f.name) || 'file';
  const sizeOf = f => (f && f.size > 1048576) ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(((f && f.size) || 0) / 1024)) + ' KB';
  const drawFiles = () => {
    const el = $('#rlFileList');
    if (!el) return;
    el.innerHTML = pending.length ? pending.map((it, i) =>
      '<div class="filerow">' +
      (renaming === i
        ? '<input class="fld" id="rnInput" value="' + esc(upName(it)) + '" style="flex:1;min-width:0;font-size:14px;padding:12px 14px" autocomplete="off">' +
          '<button class="iconbtn" data-rnok="1" aria-label="save name">' + SVG.check + '</button>' +
          '<button class="iconbtn" data-rncancel="1" aria-label="cancel">' + SVG.x + '</button>'
        : '<div class="lmain" style="flex:1;min-width:0"><div class="ltitle">' + esc(upName(it)) + '</div>' +
          '<div class="lsub">' + sizeOf(it.f) + (it.f && upName(it) !== it.f.name ? ' · was ' + esc(it.f.name) : '') + '</div></div>' +
          '<button class="iconbtn" data-rnfile="' + i + '" aria-label="rename">' + SVG.pen + '</button>' +
          '<button class="iconbtn" data-rmfile="' + i + '" aria-label="remove">' + SVG.x + '</button>') +
      '</div>').join('') : '';
    if (renaming >= 0) {
      const inp = $('#rnInput');
      if (inp) { try { inp.focus(); inp.select(); } catch (e) {} }
    }
  };
  const commitRename = () => {
    const inp = $('#rnInput');
    if (inp && renaming >= 0 && pending[renaming]) {
      const v = (inp.value || '').trim().replace(/[\\/]/g, '-');
      if (v) pending[renaming].name = v;
      else toast('The name cannot be empty');
    }
    renaming = -1;
    drawFiles();
  };
  $$('[data-rls]').forEach(b => b.addEventListener('click', () => { rls = b.dataset.rls; $$('[data-rls]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#rlFiles').addEventListener('click', () => $('#rlInput').click());
  $('#rlInput').addEventListener('change', e => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    picked.forEach(f => pending.push({ f, name: f.name }));
    renaming = -1;
    drawFiles();
  });
  $('#rlFileList').addEventListener('click', e => {
    const rm = e.target.closest('[data-rmfile]');
    if (rm) { pending.splice(+rm.dataset.rmfile, 1); renaming = -1; drawFiles(); return; }
    const rn = e.target.closest('[data-rnfile]');
    if (rn) { renaming = +rn.dataset.rnfile; drawFiles(); return; }
    if (e.target.closest('[data-rnok]')) { commitRename(); return; }
    if (e.target.closest('[data-rncancel]')) { renaming = -1; drawFiles(); }
  });
  $('#rlFileList').addEventListener('keydown', e => {
    if (renaming < 0) return;
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); renaming = -1; drawFiles(); }
  });
  $('#rlPublish').addEventListener('click', async () => {
    const tag = $('#rlTag').value.trim();
    if (!tag) { toast('Enter a tag like v1.0.0'); return; }
    if (/[^A-Za-z0-9._\-+]/.test(tag)) { toast('Tags cannot contain spaces — use letters, numbers, dots, dashes (e.g. First-Stable)'); return; }
    $('#rlPublish').disabled = true;
    try {
      const rel = await api('/repos/' + o + '/' + n + '/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: $('#rlTitle').value.trim() || tag, body: $('#rlBody').value, draft: rls === 'draft', prerelease: rls === 'pre' }) });
      if (pending.length && rel && rel.id) {
        toast('Release published — uploading ' + pending.length + ' file' + (pending.length > 1 ? 's' : '') + '…');
        upProgShow('Uploading to release');
        upProgUpdate('Uploading ' + pending.length + ' file' + (pending.length > 1 ? 's' : '') + '…', 0);
        let done = 0;
        for (const it of pending.slice()) {
          try { await uploadAsset(o + '/' + n, rel.id, it.f, true, upName(it)); done++; }
          catch (er) { toast('Failed: ' + upName(it) + ' — ' + er.message); }
        }
        upProgUpdate('Uploaded ' + done + ' file' + (done === 1 ? '' : 's'), 100);
        setTimeout(upProgHide, 2500);
        toast('Release published with ' + done + ' file' + (done === 1 ? '' : 's'));
      } else toast('Release published');
      closeSheet();
      renderReleases(o, n);
    } catch (e) { toast('Failed: ' + e.message); $('#rlPublish').disabled = false; }
  });
}

function editRepoSheet(o, n, r) {
  openSheet('<div class="sheethead"><b>Edit repository</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<label class="fldlabel">Repository name</label>' +
    '<input class="fld" id="erName" value="' + esc(n) + '" autocomplete="off" spellcheck="false">' +
    '<label class="fldlabel" style="margin-top:12px">Description</label>' +
    '<input class="fld" id="erDesc" value="' + esc(r.description || '') + '" autocomplete="off">' +
    '<label class="fldlabel" style="margin-top:12px">Homepage</label>' +
    '<input class="fld" id="erHome" value="' + esc(r.homepage || '') + '" placeholder="https://…" autocomplete="off">' +
    '<div class="setrow" style="margin-top:16px"><div class="lmain"><div class="ltitle">Private repository</div><div class="lsub">Only you and collaborators can see it</div></div><button class="switch' + (r.private ? ' on' : '') + '" id="erPriv"></button></div>' +
    '<button class="btn primary btnblock" id="erSave" style="margin-top:18px">Save changes</button>' +
    '<div class="lsub" style="margin:20px 0 8px;text-align:center">Danger zone</div>' +
    '<button class="btn danger btnblock" id="erDelete">Delete repository</button>');
  const pv = $('#erPriv');
  pv.addEventListener('click', () => pv.classList.toggle('on'));
  $('#erSave').addEventListener('click', async () => {
    const newName = $('#erName').value.trim();
    if (!newName) { toast('Repository name cannot be empty'); return; }
    if (!/^[A-Za-z0-9._-]+$/.test(newName)) { toast('Name can only use letters, numbers, . _ and -'); return; }
    if (newName.length > 100) { toast('Name is too long (max 100 characters)'); return; }
    $('#erSave').disabled = true;
    try {
      const upd = await api('/repos/' + o + '/' + n, { method: 'PATCH', body: JSON.stringify({ name: newName, description: $('#erDesc').value.trim(), homepage: $('#erHome').value.trim(), private: pv.classList.contains('on') }) });
      closeSheet();
      const finalName = (upd && upd.name) ? upd.name : newName;
      if (finalName !== n) {
        /* keep pins pointing at the renamed repo */
        let rePinned = false;
        pins.forEach(p => { if (p.full_name === o + '/' + n) { p.full_name = o + '/' + finalName; p.name = finalName; rePinned = true; } });
        if (rePinned) { LS.set('pins', pins); queueSync(); }
        toast('Repository renamed to ' + finalName);
        location.hash = '#/repo/' + o + '/' + finalName;
      } else {
        toast('Repository updated');
        renderRepo(o, n);
      }
    } catch (e) { toast('Failed: ' + e.message); $('#erSave').disabled = false; }
  });
  $('#erDelete').addEventListener('click', () => deleteRepoSheet(o, n));
}

/* v3.09: upload progress lives in a round button, not a banner across the top.
   The button carries a ring + percentage; tapping it opens the full detail. */
let upProgTitle = '', upProgSub = '', upProgPct = 0;
function upProgShow(title) {
  upProgTitle = title || 'Upload';
  let el = document.getElementById('upProgCard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'upProgCard';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Upload progress');
    el.innerHTML = '<div id="upProgRing"><span id="upProgPct">0%</span></div>';
    el.addEventListener('click', () => { if (document.getElementById('upProgCard')) upProgSheet(); });
    document.body.appendChild(el);
  }
  const p = document.getElementById('upProgPct');
  if (p) p.textContent = Math.round(upProgPct) + '%';
  upProgPaint();
}
function upProgPaint() {
  const r = document.getElementById('upProgRing');
  if (r) r.style.setProperty('--p', Math.max(0, Math.min(100, upProgPct)));
}
function upProgUpdate(sub, pct) {
  upProgSub = sub || '';
  if (typeof pct === 'number' && !isNaN(pct)) upProgPct = Math.max(0, Math.min(100, pct));
  const p = document.getElementById('upProgPct');
  if (p) p.textContent = Math.round(upProgPct) + '%';
  upProgPaint();
}
function upProgHide() {
  const el = document.getElementById('upProgCard');
  if (el) el.remove();
  upProgTitle = ''; upProgSub = ''; upProgPct = 0;
}
function upProgSheet() {
  openSheet('<div class="sheethead"><b>' + esc(upProgTitle || 'Upload') + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub" style="margin-bottom:12px">' + esc(upProgSub || '') + '</div>' +
    '<div class="upbar"><i style="width:' + Math.round(upProgPct) + '%"></i></div>');
}
let folderCtx = null;
/* native scan result: folder walked or files picked — offer the commit sheet.
 * count < 0 means the picker was cancelled; tooBig counts files over
 * GitHub's 100 MB per-file limit; truncated means the 2000-file cap was hit. */
window.__folderScanned = (jid, count, bytes, tooBig, truncated) => {
  if (!folderCtx) return;
  if (folderCtx.jid === null) folderCtx.jid = jid;
  if (jid !== folderCtx.jid) return;
  if (count < 0) { folderCtx = null; upProgHide(); toast('Upload cancelled'); return; }
  if (count === 0) { folderCtx = null; upProgHide(); toast(tooBig > 0 ? 'Every file in there is over 100 MB — GitHub refuses files that big' : 'No files found to upload'); return; }
  if (truncated) toast('More than 2000 files — uploading the first 2000');
  if (tooBig > 0) toast(tooBig + ' file' + (tooBig > 1 ? 's' : '') + ' over 100 MB skipped — GitHub refuses files that big');
  const ctx = folderCtx;
  upProgUpdate(count + ' files — ' + fmtSize(bytes) + ' ready', 100);
  commitMsgSheet('Upload ' + (ctx.kind === 'folder' ? 'folder' : 'files'), 'Upload ' + count + ' file' + (count === 1 ? '' : 's'), async msg => {
    if (!window.OneGit || !window.OneGit.uploadFolder) { folderCtx = null; upProgHide(); toast('Upload not available'); return; }
    upProgUpdate('Uploading 0 / ' + count + ' \u2014 keeps going if you leave the app', 2);
    try { window.OneGit.uploadFolder(jid, ctx.o, ctx.n, ctx.dir || '', msg); }
    catch (e) { folderCtx = null; upProgHide(); toast('Failed: ' + e.message); }
  }, () => { folderCtx = null; upProgHide(); toast('Upload cancelled'); });
};
window.__folderProgress = (jid, done, total) => {
  if (!folderCtx || folderCtx.jid !== jid) return;
  upProgUpdate('Uploading ' + done + ' / ' + total + (total === 1 ? ' file' : ' files'), total ? done / total * 100 : 100);
};
window.__folderStage = (jid, text) => {
  if (!folderCtx || folderCtx.jid !== jid) return;
  upProgUpdate(text, 100);
};
window.__folderResult = (jid, ok, fail, errs) => {
  try { LS.del(gqlFreshKey('c.allcomm')); } catch (e) { }
  try { if (window.OneGit && window.OneGit.clearUploadState) window.OneGit.clearUploadState(); } catch (e) { }
  if (!folderCtx || folderCtx.jid !== jid) return;
  const ctx = folderCtx; folderCtx = null;
  upProgHide();
  let m = '';
  try { const a = typeof errs === 'string' ? JSON.parse(errs) : errs; if (a && a.length) m = a.slice(0, 3).join(' · '); } catch (e) {}
  if (fail > 0) toast(ok + ' uploaded, ' + fail + ' failed' + (m ? ' — ' + m : ''));
  else toast('Uploaded ' + ok + ' file' + (ok === 1 ? '' : 's') + ' in one commit');
  renderFiles(ctx.o, ctx.n, ctx.dir);
};
/* native release-asset upload finished (window._assetAfter re-renders the view) */
window.__assetDone = (ok, fail, msg) => {
  try { if (window.OneGit && window.OneGit.clearUploadState) window.OneGit.clearUploadState(); } catch (e) { }
  upProgUpdate(fail > 0 ? (ok + ' uploaded, ' + fail + ' failed') : ('Uploaded ' + ok + ' file' + (ok === 1 ? '' : 's')), 100);
  setTimeout(upProgHide, 2500);
  toast(fail > 0 ? (ok + ' uploaded, ' + fail + ' failed' + (msg ? ' — ' + msg : '')) : 'Uploaded ' + ok + ' file' + (ok === 1 ? '' : 's'));
  const after = window._assetAfter; window._assetAfter = null;
  if (after) { try { after(); } catch (e) {} }
};
/* commits many files as ONE commit via the Git Data API (blobs -> tree -> commit) */
async function commitMany(o, n, files, dir, message, onProg) {
  const repo = await api('/repos/' + o + '/' + n);
  const branch = repo.default_branch || 'main';
  let ref;
  try { ref = await api('/repos/' + o + '/' + n + '/git/ref/heads/' + branch); }
  catch (e) {
    // repository has no commits yet: create files via the contents API
    for (let i = 0; i < files.length; i++) {
      await api('/repos/' + o + '/' + n + '/contents/' + encodeURIComponent((dir ? dir + '/' : '') + files[i].path).replace(/%2F/g, '/'),
        { method: 'PUT', body: JSON.stringify({ message: message + (files.length > 1 ? ' \u2014 ' + files[i].path : ''), content: files[i].b64, branch }) });
      if (onProg) onProg(i + 1, files.length);
    }
    return files.length;
  }
  const parentSha = ref.object.sha;
  /* one GraphQL request instead of a request per file plus about 5 (own budget).
     Only when the payload is modest; any refusal falls back to the blob route below. */
  let b64Total = 0; files.forEach(f => { b64Total += (f.b64 || '').length; });
  if (b64Total <= 10 * 1024 * 1024) {
    try {
      const msgLines = String(message || 'Upload files').split('\n');
      const input = {
        branch: { repositoryNameWithOwner: o + '/' + n, branchName: branch },
        message: Object.assign({ headline: msgLines[0] }, msgLines.slice(1).join('\n').trim() ? { body: msgLines.slice(1).join('\n').trim() } : {}),
        expectedHeadOid: parentSha,
        fileChanges: { additions: files.map(f => ({ path: (dir ? dir + '/' : '') + f.path, contents: f.b64 })) }
      };
      const gr = await api('/graphql', { method: 'POST', body: JSON.stringify({
        query: 'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}', variables: { input } }) });
      if (gr && gr.data && gr.data.createCommitOnBranch && !(gr.errors && gr.errors.length)) {
        try { staleApiCache('/repos/' + o + '/' + n + '/contents'); LS.del(gqlFreshKey('c.allcomm')); } catch (e) { }
        if (onProg) onProg(files.length, files.length);
        return files.length;
      }
    } catch (e) {
      /* a dropped connection may or may not have written: do not risk a second commit */
      if (e instanceof TypeError) throw e;
    }
  }
  const headCommit = await api('/repos/' + o + '/' + n + '/git/commits/' + parentSha);
  const baseTree = headCommit.tree.sha;
  const tree = [];
  for (let i = 0; i < files.length; i += 6) {
    const chunk = files.slice(i, i + 6);
    const blobs = await Promise.all(chunk.map(f => api('/repos/' + o + '/' + n + '/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.b64, encoding: 'base64' }) })));
    blobs.forEach((b, k) => tree.push({ path: (dir ? dir + '/' : '') + chunk[k].path, mode: '100644', type: 'blob', sha: b.sha }));
    if (onProg) onProg(Math.min(i + 6, files.length), files.length);
  }
  const newTree = await api('/repos/' + o + '/' + n + '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) });
  const newCommit = await api('/repos/' + o + '/' + n + '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] }) });
  await api('/repos/' + o + '/' + n + '/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });
  return files.length;
}

function deleteRepoSheet(o, n) {
  openSheet('<div class="sheethead"><b>Delete repository — ' + esc(n) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<p class="dim" style="margin:4px 0 14px">This permanently deletes ' + esc(o + '/' + n) + ' — every file, issue, pull request, star and setting is gone for good. This cannot be undone, not even on GitHub.</p>' +
    '<label class="fldlabel">Type ' + esc(n) + ' to confirm</label>' +
    '<input class="fld" id="drConfirm" placeholder="' + esc(n) + '" autocomplete="off" spellcheck="false">' +
    '<button class="btn danger btnblock" id="drGo" style="margin-top:16px">Delete this repository</button>');
  $('#drConfirm').addEventListener('keydown', e => { if (e.key === 'Enter') $('#drGo').click(); });
  $('#drGo').addEventListener('click', async () => {
    if ($('#drConfirm').value.trim() !== n) { toast('Type ' + n + ' to confirm'); return; }
    $('#drGo').disabled = true;
    try {
      await api('/repos/' + o + '/' + n, { method: 'DELETE' });
      closeSheet();
      toast('Deleted ' + o + '/' + n);
      pins = pins.filter(p => p.full_name !== o + '/' + n); LS.set('pins', pins); queueSync();
      location.hash = '#/repos';
    } catch (e) { toast('Failed: ' + e.message); $('#drGo').disabled = false; }
  });
}

/* ================= views: issue / PR detail ================= */
async function renderIssue(o, n, num) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let iss, comments;
  try {
    iss = await api('/repos/' + o + '/' + n + '/issues/' + num, { accept: 'application/vnd.github.html+json' });
    comments = await api('/repos/' + o + '/' + n + '/issues/' + num + '/comments?per_page=50', { accept: 'application/vnd.github.html+json' });
  } catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  const isPR = !!iss.pull_request;
  let pr = null;
  if (isPR) pr = await api('/repos/' + o + '/' + n + '/pulls/' + num).catch(() => null);
  const canTriage = await canPushRepo(o, n).catch(() => false);
  let html = '<div class="card issuehead"><div class="chips">' +
    '<span class="chip ' + (iss.state === 'open' ? 'ok' : 'closed') + '">' + (iss.state === 'open' ? 'Open' : 'Closed') + '</span>' +
    (isPR ? '<span class="chip pr">Pull Request</span>' : '') +
    (pr && pr.draft ? '<span class="chip">Draft</span>' : '') +
    (pr && pr.merged_at ? '<span class="chip ok">Merged</span>' : '') + '</div>' +
    '<div class="ihtitle">' + esc(iss.title) + '</div>' +
    '<div class="ihmeta">' + esc(iss.user.login) + ' opened ' + tAgo(iss.created_at) +
    (isPR && iss.pull_request.merged_at ? ' · merged' : '') + '</div>' +
    (pr ? '<div class="ihmeta" style="margin-top:4px">' + esc(pr.head.ref) + ' → ' + esc(pr.base.ref) +
      (pr.additions !== undefined ? ' · <span style="color:#12B76A">+' + nf(pr.additions) + '</span> <span style="color:#EF4444">−' + nf(pr.deletions) + '</span> · ' + nf(pr.changed_files) + ' files' : '') + '</div>' : '') +
    '<button class="btn ' + (iss.state === 'open' ? 'ghost' : 'primary') + '" id="stateBtn" style="margin-top:14px">' +
    (iss.state === 'open' ? (isPR ? 'Close pull request' : 'Close issue') : (isPR ? 'Reopen pull request' : 'Reopen issue')) + '</button>' +
    (pr && iss.state === 'open' && !pr.merged_at ? '<button class="btn primary" id="mergeBtn" style="margin-top:10px">Merge pull request</button>' : '') +
    (pr ? '<button class="btn ghost" id="revBtn" style="margin-top:10px">Review changes</button>' +
      '<button class="btn ghost" id="draftBtn" style="margin-top:10px">' + (pr.draft ? 'Mark ready for review' : 'Convert to draft') + '</button>' : '') +
    /* labels, assignees and milestone - shown to everyone, editable with push access */
    '<div class="triage">' +
    (iss.labels && iss.labels.length ? '<div class="chips">' + iss.labels.map(labelChip).join('') + '</div>' : '') +
    (iss.assignees && iss.assignees.length ? '<div class="assignrow">' + iss.assignees.map(a =>
      '<img class="cav" data-go="#/user/' + esc(a.login) + '" src="' + esc(a.avatar_url) + '" title="' + esc(a.login) + '" alt="">').join('') + '</div>' : '') +
    (iss.milestone ? '<div class="chips"><span class="chip pr">' + esc(iss.milestone.title) + '</span></div>' : '') +
    '</div>' +
    (canTriage ? '<div class="actionrow" style="margin-top:12px">' +
      '<button class="btn ghost" id="lblBtn">' + SVG.tag + '<span>Labels</span></button>' +
      '<button class="btn ghost" id="asgBtn">' + SVG.user + '<span>Assignees</span></button>' +
      '<button class="btn ghost" id="msBtn">' + SVG.dot + '<span>Milestone</span></button></div>' : '') +
    '</div>';
  if (pr && pr.head && pr.head.sha) html += await checksHTML(o, n, pr.head.sha).catch(() => '');
  html += '<div class="card md">' + (iss.body_html ? fixMd(iss.body_html, o + '/' + n) : '<p class="dim">No description.</p>') + '</div>';
  html += reactionBar('/repos/' + o + '/' + n + '/issues/' + num, iss.reactions);
  html += '<h2 class="sect">Comments (' + comments.length + ')</h2>';
  comments.forEach(c => {
    html += '<div class="card comment"><div class="crow"><img class="cav" src="' + esc(c.user.avatar_url) + '" alt=""><b data-go="#/user/' + esc(c.user.login) + '">' + esc(c.user.login) + '</b><span class="dim">' + tAgo(c.created_at) + '</span></div>' +
      '<div class="md">' + (c.body_html ? fixMd(c.body_html, o + '/' + n) : '') + '</div>' +
      reactionBar('/repos/' + o + '/' + n + '/issues/comments/' + c.id, c.reactions) + '</div>';
  });
  html += '<div class="card reply"><textarea id="replyText" placeholder="Write a comment…"></textarea><button class="btn primary" id="replyBtn">Comment</button></div>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  inlineRepoImages(view());
  const sb = $('#stateBtn');
  if (sb) sb.addEventListener('click', async () => {
    sb.disabled = true;
    const target = iss.state === 'open' ? 'closed' : 'open';
    try {
      await api('/repos/' + o + '/' + n + '/issues/' + num, { method: 'PATCH', body: JSON.stringify({ state: target }) });
      toast(target === 'closed' ? 'Closed' : 'Reopened');
      renderIssue(o, n, num);
    } catch (e) { toast('Failed: ' + e.message); sb.disabled = false; }
  });
  $('#replyBtn').addEventListener('click', async () => {
    const body = $('#replyText').value.trim();
    if (!body) { toast('Write something first'); return; }
    $('#replyBtn').disabled = true;
    try {
      await api('/repos/' + o + '/' + n + '/issues/' + num + '/comments', { method: 'POST', body: JSON.stringify({ body }) });
      toast('Comment posted');
      renderIssue(o, n, num);
    } catch (e) { toast('Failed: ' + e.message); $('#replyBtn').disabled = false; }
  });
  const mb = $('#mergeBtn');
  if (mb && pr) mb.addEventListener('click', async () => {
    const canMerge = await canPushRepo(o, n).catch(() => false);
    if (!canMerge) { toast('You do not have permission to merge here'); return; }
    mergeSheet(o, n, num, pr);
  });
  const lb = $('#lblBtn');
  if (lb) lb.addEventListener('click', () => labelsSheet(o, n, num, iss.labels));
  const ab = $('#asgBtn');
  if (ab) ab.addEventListener('click', () => assigneesSheet(o, n, num, iss.assignees));
  const msb = $('#msBtn');
  if (msb) msb.addEventListener('click', () => milestoneSheet(o, n, num, iss.milestone));
  const rvb = $('#revBtn');
  if (rvb) rvb.addEventListener('click', () => reviewSheet(o, n, num));
  const db = $('#draftBtn');
  if (db && pr) db.addEventListener('click', () => toggleDraft(o, n, num, pr, db));
}

/* ================= views: global issues + PRs ================= */
let IS = { type: 'issues', state: 'open', filter: 'created' };
async function renderIssues() {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = '<button class="btn ghost btnblock" id="giNew" style="margin-bottom:12px">' + esc(i18n('newIssue')) + '</button>' +
    '<div class="seg sm"><button class="segb' + (IS.type === 'issues' ? ' on' : '') + '" data-it="issues">' + esc(i18n('issues')) + '</button>' +
    '<button class="segb' + (IS.type === 'prs' ? ' on' : '') + '" data-it="prs">' + esc(i18n('pullRequests')) + '</button></div>' +
    '<div class="seg sm"><button class="segb' + (IS.state === 'open' ? ' on' : '') + '" data-is="open">' + esc(i18n('open_')) + '</button>' +
    '<button class="segb' + (IS.state === 'closed' ? ' on' : '') + '" data-is="closed">' + esc(i18n('closed')) + '</button></div>' +
    '<div class="seg sm" style="margin-bottom:12px"><button class="segb' + (IS.filter === 'created' ? ' on' : '') + '" data-if="created">' + esc(i18n('created')) + '</button>' +
    '<button class="segb' + (IS.filter === 'assigned' ? ' on' : '') + '" data-if="assigned">' + esc(i18n('assigned')) + '</button></div>' +
    sortRowHTML('issues') +
    '<div id="issueList">' + spinner() + '</div>';
  $('#giNew').addEventListener('click', () => repoPickerSheet((o, n) => { closeSheet(); newIssueSheet(o, n); }));
  $$('[data-if]').forEach(b => b.addEventListener('click', () => { IS.filter = b.dataset.if; renderIssues(); }));
  $$('[data-is]').forEach(b => b.addEventListener('click', () => { IS.state = b.dataset.is; renderIssues(); }));
  $$('[data-it]').forEach(b => b.addEventListener('click', () => { IS.type = b.dataset.it; renderIssues(); }));
  wireSortRow('issues', () => loadIssues());
  loadIssues();
}
async function loadIssues() {
  const seq = ++RSEQ;
  const list = $('#issueList'); if (!list) return;
  const paintIssues = items => {
    const it = sortItems((items || []).filter(i => IS.type === 'prs' ? !!i.pull_request : !i.pull_request), 'issues');
    if (seq !== RSEQ) return;
    list.innerHTML = it.length ? '<div class="card list">' + it.map(issueRow).join('') + '</div>' :
      '<div class="card empty">' + esc(i18n(IS.type === 'prs' ? 'noPrsHere' : 'noIssuesHere')) + '</div>';
  };
  const ic = cached('/issues?filter=' + IS.filter + '&state=' + IS.state + '&sort=updated&direction=desc&per_page=60');
  if (ic && Array.isArray(ic)) paintIssues(ic);
  try {
    let items = await api('/issues?filter=' + IS.filter + '&state=' + IS.state + '&sort=updated&direction=desc&per_page=60');
    paintIssues(items);
    liveList('#issueList',
      () => api('/issues?filter=' + IS.filter + '&state=' + IS.state + '&sort=updated&direction=desc&per_page=60')
        .then(a => (a || []).filter(i => IS.type === 'prs' ? !!i.pull_request : !i.pull_request)),
      i => i.id, issueRow, 0, 'issues');
  } catch (e) { if (seq !== RSEQ) return; list.innerHTML = errCard(e); }
}

/* ================= views: user profile ================= */
/* profile README only - what the profile card opens */
async function renderProfileReadme(login) {
  const seq = ++RSEQ;
  view().innerHTML = spinner();
  const res = await Promise.allSettled([
    api('/repos/' + login + '/' + login + '/readme', { accept: 'application/vnd.github.html', text: true }),
    api('/users/' + login)
  ]);
  if (seq !== RSEQ) return;
  if (res[0].status !== 'fulfilled') {
    view().innerHTML = '<div class="card empty">@' + esc(login) + ' has no profile README yet.<br><span class="dim">A profile README appears when there is a public repository named exactly like the username, with a README.md inside it. You can create one from the Repos tab — New repository.</span></div>';
    return;
  }
  const md = res[0].value;
  const u = res[1].status === 'fulfilled' ? res[1].value : null;
  let html = '';
  if (u) {
    html += '<div class="card profile" data-go="#/user/' + esc(login) + '"><img class="pav" src="' + esc(u.avatar_url) + '" alt="">' +
      '<div class="pname">' + esc(u.name || u.login) + '</div>' +
      '<div class="plogin">@' + esc(u.login) + '</div>' +
      (u.bio ? '<p class="pbio">' + esc(u.bio) + '</p>' : '') + '</div>';
  }
  html += '<div class="card md readmebody">' + fixMd(md, login + '/' + login) + '</div>';
  view().innerHTML = html;
  inlineRepoImages(view());
}

async function renderUser(login) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let u = cached('/users/' + login) || null, repos = cached('/users/' + login + '/repos?per_page=100&sort=pushed') || null, followState = null;
  const self = (USER && USER.login) ? USER.login.toLowerCase() === login.toLowerCase() : true;
  if (u) api('/users/' + login).catch(() => {});
  if (!u) { try { u = await api('/users/' + login); } catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; } }
  if (!self) { const f = await api('/user/following/' + login, { status: true }).catch(() => null); followState = f ? f.status === 204 : null; }
  if (repos) api('/users/' + login + '/repos?per_page=100&sort=pushed').catch(() => {});
  else { try { repos = await api('/users/' + login + '/repos?per_page=100&sort=pushed'); } catch (e) { repos = []; } }
  repos.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
  const top = repos.slice(0, 8);
  let html = '<div class="card profile" data-go="' + specialRepoGo(login) + '">' + (self ? acctBtnHTML() : '') + '<img class="pav" src="' + esc(u.avatar_url) + '" alt="">' +
    '<div class="pname">' + esc(u.name || u.login) + '</div>' +
    '<div class="plogin">@' + esc(u.login) + (u.type === 'Organization' ? ' · organization' : '') + '</div>' +
    (u.bio ? '<p class="pbio">' + esc(u.bio) + '</p>' : '') +
    (u.location ? '<p class="pbio" style="margin-top:6px;font-size:12.5px">' + esc(u.location) + '</p>' : '') +
    '<div class="pstats">' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/repos"><b>' + nf(u.public_repos) + '</b><span>repos</span></div>' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/followers"><b>' + nf(u.followers) + '</b><span>followers</span></div>' +
    '<div class="pstat" data-go="#/users/' + esc(u.login) + '/following"><b>' + nf(u.following) + '</b><span>following</span></div></div>';
  /* all three actions share one row instead of stacking on three lines */
  html += '<div class="btnrow">' +
    (!self
      ? '<button class="btn follow ' + (followState ? 'on' : 'primary') + '" id="followBtn">' + (followState ? 'Following' : 'Follow') + '</button>'
      : '<button class="btn ghost" id="editProfBtn">Edit profile</button>') +
    '<button class="btn ghost" data-go="#/productivity/' + esc(u.login) + '">Productivity</button>' +
    '</div>';
  html += '</div>';
  html += '<div id="preReadme"></div>';
  html += '<h2 class="sect">Popular repositories</h2>';
  html += top.length ? top.map(repoRow).join('') : '<div class="card empty">No public repositories.</div>';
  if (seq !== RSEQ) return;
  view().innerHTML = html;
  checkSpecialRepo(login);
  (async () => {
    try {
      const md = await api('/repos/' + login + '/' + login + '/readme', { accept: 'application/vnd.github.html', text: true });
      const el = $('#preReadme');
      if (el && seq === RSEQ) { el.innerHTML = '<h2 class="sect">Profile README</h2><div class="card md">' + fixMd(md, login + '/' + login) + '</div>'; inlineRepoImages(el); }
    } catch (e) { /* no special repo - nothing to show */ }
  })();
  const fb = $('#followBtn');
  if (fb) fb.addEventListener('click', async e => {
    e.stopPropagation();
    if (USER && USER.login && USER.login.toLowerCase() === login.toLowerCase()) { toast('You cannot follow yourself'); return; }
    fb.disabled = true;
    const following = fb.classList.contains('on');
    try {
      await api('/user/following/' + login, { method: following ? 'DELETE' : 'PUT' });
      fb.classList.toggle('on', !following);
      fb.classList.remove('primary');
      fb.textContent = following ? 'Follow' : 'Following';
      toast(following ? 'Unfollowed ' + login : 'Following ' + login);
    } catch (e) {
      if (/not found/i.test(e.message || '')) {
        toast('Could not follow ' + login + ' \u2014 this is usually your own profile');
        try {
          const me = await api('/user');
          if (me && me.login) { USER = me; LS.set('c.user', me); route(); return; }
        } catch (e2) {}
      } else toast('Failed: ' + e.message);
      fb.disabled = false;
    }
  });
  const eb = $('#editProfBtn');
  if (eb) eb.addEventListener('click', e => { e.stopPropagation(); editProfileSheet(); });
}

/* ================= views: user lists (followers / following) ================= */
/* A user's own repositories - what tapping the "repos" count on their profile
   opens. It used to jump to the Repositories tab, which showed your own or the
   Discover list instead of theirs. */
let URSORT = 'stars';
async function renderUserRepos(login) {
  const seq = ++RSEQ;
  view().innerHTML = spinner();
  let repos = cached('/users/' + login + '/repos?per_page=100&sort=pushed') || null;
  if (!repos) {
    try { repos = await api('/users/' + login + '/repos?per_page=100&sort=pushed'); }
    catch (e) { if (seq === RSEQ) view().innerHTML = errCard(e); return; }
  } else {
    api('/users/' + login + '/repos?per_page=100&sort=pushed').catch(() => {});
  }
  if (seq !== RSEQ) return;
  const sorters = {
    stars: (a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0),
    updated: (a, b) => new Date(b.pushed_at || 0) - new Date(a.pushed_at || 0),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''))
  };
  const list = (repos || []).slice().sort(sorters[URSORT] || sorters.stars);
  let html = '<div class="seg sm" style="margin-bottom:12px">' +
    [['stars', 'Most stars'], ['updated', 'Recently updated'], ['name', 'Name A–Z']].map(x =>
      '<button class="segb' + (URSORT === x[0] ? ' on' : '') + '" data-ursort="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>';
  html += '<div class="lsub" style="margin:-4px 0 10px 2px">' + nf((repos || []).length) + ' public repositories by @' + esc(login) + '</div>';
  /* the rows are cards in their own right, so there is no big container card
     behind them any more - the list sits straight on the page like GitHub's */
  html += list.length ? '<div class="repogrid">' + list.map(r => repoRow(r)).join('') + '</div>'
    : '<div class="card empty">@' + esc(login) + ' has no public repositories.</div>';
  view().innerHTML = html;
  $$('[data-ursort]').forEach(b => b.addEventListener('click', () => { URSORT = b.dataset.ursort; renderUserRepos(login); }));
}

async function renderUserList(login, which) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let items;
  try { items = await api('/users/' + login + '/' + which + '?per_page=80'); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  view().innerHTML = items.length ? '<div class="card list">' + items.map(u =>
    '<div class="lrow" data-go="#/user/' + esc(u.login) + '">' +
    '<img class="cav" src="' + esc(u.avatar_url) + '" alt="">' +
    '<div class="lmain"><div class="ltitle">' + esc(u.login) + '</div>' +
    '<div class="lsub">' + esc(u.type || 'User') + '</div></div></div>').join('') + '</div>'
    : '<div class="card empty">Nobody here yet.</div>';
}

/* ================= views: gists ================= */
async function renderGists(login) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let items;
  try { items = await api(login ? '/users/' + login + '/gists?per_page=30' : '/gists?per_page=30'); }
  catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  if (!items.length) { view().innerHTML = (login ? '' : '<button class="btn ghost btnblock" id="newGistBtn" style="margin-bottom:12px">New gist</button>') + '<div class="card empty">No gists yet.</div>'; if (!login) $('#newGistBtn').addEventListener('click', newGistSheet); return; }
  if (seq !== RSEQ) return;
  view().innerHTML = (login ? '' : '<button class="btn ghost btnblock" id="newGistBtn" style="margin-bottom:12px">New gist</button>') + '<div class="card list">' + items.map(g => {
    const files = Object.keys(g.files || {});
    const label = g.description || files[0] || 'gist';
    return '<div class="lrow" data-go="#/gist/' + g.id + '">' + SVG.file +
      '<div class="lmain"><div class="ltitle">' + esc(label) + '</div>' +
      '<div class="lsub">' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' · ' + tAgo(g.updated_at) + (g.public ? '' : ' · secret') + '</div></div></div>';
  }).join('') + '</div>';
}

async function renderGist(id) {
  const seq = ++RSEQ;
  if (seq !== RSEQ) return;
  view().innerHTML = spinner();
  let g;
  try { g = await api('/gists/' + id); } catch (e) { if (seq !== RSEQ) return; view().innerHTML = errCard(e); return; }
  const files = Object.values(g.files || {});
  let html = '<div class="card"><div class="rcname">' + esc(g.description || 'Gist') + '</div>' +
    '<div class="rcmeta">' + (g.owner ? esc(g.owner.login) : 'anonymous') + ' · ' + tAgo(g.updated_at) + (g.public ? '' : ' · secret gist') + '</div></div>';
  files.forEach(f => {
    html += '<div class="card"><div class="filehead">' + SVG.file + '<b style="font-size:13px;word-break:break-all">' + esc(f.filename) + '</b>' +
      (f.language ? '<span class="chip">' + esc(f.language) + '</span>' : '') + '</div>' +
      (f.truncated ? '<div class="lsub" style="margin-top:8px">File too large to show here.</div>' :
        codeWithLines(f.content || '')) + '</div>';
  });
  if (seq !== RSEQ) return;
  view().innerHTML = html;
}

function langBars(langs) {
  const entries = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0) || 1;
  const top = entries.slice(0, 4);
  const rest = entries.slice(4).reduce((s, e) => s + e[1], 0);
  let bar = '<div class="langbar">' + top.map(e => '<span style="width:' + (e[1] / total * 100).toFixed(1) + '%;background:' + langColor(e[0]) + '"></span>').join('') +
    (rest ? '<span style="width:' + (rest / total * 100).toFixed(1) + '%;background:#8a8a8a"></span>' : '') + '</div>';
  let legend = top.map(e => '<div class="lgd"><span class="dot" style="background:' + langColor(e[0]) + '"></span>' + esc(e[0]) + ' <span class="dim">' + (e[1] / total * 100).toFixed(1) + '%</span></div>').join('') +
    (rest ? '<div class="lgd"><span class="dot" style="background:#8a8a8a"></span>Other <span class="dim">' + (rest / total * 100).toFixed(1) + '%</span></div>' : '');
  return '<div class="card"><div class="ltitle" style="margin-bottom:12px">Languages</div>' + bar + '<div class="lgdrow">' + legend + '</div></div>';
}

/* ================= views: settings ================= */
let STAB = 'general';
/* ================= GitHub account settings ================= */
/* ================= settings: a hub, then a page per section =================
   Settings used to be one long scroll. Each heading is now a component that
   opens its own page, so Appearance holds the appearance settings and nothing
   else. The whole page is still built (and wired) underneath - a sub-page just
   shows one section - so no control ever loses its listener. */
let SET_SEC = '', SET_FIND = '';
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
const SET_SECTIONS = [
  ['appearance', 'Appearance', 'Theme, accent colour, glow and compact mode', SVG.eye],
  ['accessibility', 'Accessibility', 'Reduce motion and link underlines', SVG.check],
  ['updates', 'App updates', 'Auto-download and auto-install new releases', SVG.dl],
  ['notifications', 'Notifications', 'Upload and download progress cards', SVG.bell],
  ['sync', 'Sync across devices', 'Your pins and settings, kept in your GitHub account', SVG.copy],
  ['pins', 'Pinned repositories', 'What is pinned on your home screen', SVG.star],
  ['account', 'Account', 'Signed-in accounts, add another, sign out', SVG.user],
  ['github', 'GitHub account', 'Sign-in method, authorized apps and tokens', SVG.github],
  ['language', 'Language', 'The language Gitly speaks', SVG.globe],
  ['budget', 'API budget', 'Requests left this hour (read-only, costs nothing)', SVG.code],
  ['credits', 'About and credits', 'Version, developer and links', SVG.code]
];
const SET_TITLE = {};
SET_SECTIONS.forEach(s => { SET_TITLE[s[0]] = s[1]; });
SET_TITLE.credits = '';

/* One settings row: a title, a one-line description and the switch. */
function settingRow(title, sub, on, id, aria, divider) {
  return '<div class="setrow"' + (divider ? ' style="border-top:1px solid var(--divider)"' : '') + '>' +
    '<div class="lmain"><div class="ltitle">' + title + '</div><div class="lsub">' + sub + '</div></div>' +
    '<button class="switch' + (on ? ' on' : '') + '" id="' + id + '" aria-label="' + (aria || title) + '"></button></div>';
}

/* Every setting, by name and by the words someone might actually type, so it
   can be found instead of hunted for. */
const SET_INDEX = [
  ['Theme', 'appearance', 'light dark pitch black amoled night mode bright'],
  ['Accent colour', 'appearance', 'color colour theme blue purple green pink amber teal red indigo dynamic custom wallpaper'],
  ['Glow effects', 'appearance', 'neon glow shadow flat battery'],
  ['Navigation glow', 'appearance', 'bottom bar nav glow'],
  ['Compact mode', 'appearance', 'tight smaller one handed density compact'],
  ['Auto-adjust to screen', 'appearance', 'device shape tablet desktop layout responsive fit'],
  ['Reduce motion', 'accessibility', 'animations transitions motion accessibility'],
  ['Show link underlines', 'accessibility', 'links underline readme accessibility'],
  ['Auto-download app updates', 'updates', 'update apk download automatic'],
  ['Install updates automatically', 'updates', 'install apk android installer update'],
  ['Live-update notifications', 'notifications', 'upload progress live notification downloads'],
  ['Sync across devices', 'sync', 'gist sync restore backup devices settings'],
  ['Pinned repositories', 'pins', 'pins pinned starred home screen repositories'],
  ['API budget', 'budget', 'api requests credit credits limit rate left quota remaining rest graphql search'],
  ['Accounts', 'account', 'account switch add sign out logout'],
  ['Sign-in method', 'github', 'token oauth scopes login sign in'],
  ['Authorized apps', 'github', 'oauth apps access revoke authorize'],
  ['Personal access tokens', 'github', 'token create pat access'],
  ['Language', 'language', 'language locale region korean hindi english translate auto system'],
  ['Version and credits', 'credits', 'about version developer credits update']
];
const SEC_OF = {};
SET_SECTIONS.forEach(s => { SEC_OF[s[0]] = s; });

/* The settings search is delegated from the document: the settings page is
   redrawn by more than one path, and a listener bound to the field itself kept
   being thrown away along with the element it was bound to. */
let SET_SEARCH_T = null;
document.addEventListener('input', e => {
  const i = e.target;
  if (!i || i.id !== 'setSearch') return;
  clearTimeout(SET_SEARCH_T);
  SET_SEARCH_T = setTimeout(() => {
    const box = document.getElementById('setList');
    if (!box) return;
    box.innerHTML = i.value.trim() ? settingsResults(i.value) : settingsRows();
  }, 160);
}, false);

/* a search result opens its section and marks the row it found */
document.addEventListener('click', e => {
  const b = e.target && e.target.closest ? e.target.closest('[data-setgo]') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  SET_FIND = b.dataset.setfind || '';
  location.hash = '#/settings/' + b.dataset.setgo;
}, false);

/* the section id doubles as the translation key */
function secKey(id) { return id === 'github' ? 'githubAccount' : id; }
/* the one-line description under each hub row */
const SEC_DESC = { appearance:'dAppearance', accessibility:'dAccessibility', updates:'dUpdates',
  notifications:'dNotifications', sync:'dSync', pins:'dPins', account:'dAccount', github:'dGithub',
  budget:'dBudget', credits:'dCredits', language:'dLanguage' };
function secDesc(s) { const k = SEC_DESC[s[0]]; const v = k ? i18n(k) : s[2]; return v === k ? s[2] : v; }
function secTitle(s) { const v = i18n(secKey(s[0])); return v === secKey(s[0]) ? s[1] : v; }

/* the language picker: Auto first, then every language the phone can be set to,
   with the ones Gitly has real words for marked, so nothing is oversold */
function langPickerHTML() {
  const cur = UI_LANG === 'auto' ? 'auto' : (STRINGS[UI_LANG] ? UI_LANG : 'en');
  return '<button class="setrow langrow' + (cur === 'auto' ? ' on' : '') + '" data-lang="auto">' +
    '<span class="setic">' + SVG.globe + '</span>' +
    '<span class="lmain"><span class="ltitle">' + esc(i18n('autoSystem')) + '</span>' +
    '<span class="lsub">' + esc(i18n('autoSystemSub')) + ' \u00b7 ' + esc(langName(langCode())) + '</span></span>' +
    (cur === 'auto' ? '<span class="chip ok">' + esc(i18n('done')) + '</span>' : '') + '</button>' +
    '<div class="searchbar" style="margin:12px 0 8px">' + SVG.search +
    '<input id="langSearch" placeholder="' + esc(i18n('searchLanguages')) + '" autocomplete="off"></div>' +
    '<div id="langList">' + langRowsHTML('') + '</div>';
}
function langRowsHTML(q) {
  const cur = UI_LANG === 'auto' ? 'auto' : (STRINGS[UI_LANG] ? UI_LANG : 'en');
  const needle = String(q || '').trim().toLowerCase();
  const list = LANGS.filter(l => !needle ||
    l[1].toLowerCase().indexOf(needle) > -1 ||
    l[2].toLowerCase().indexOf(needle) > -1 ||
    l[0].indexOf(needle) === 0);
  if (!list.length) return '<div class="empty" style="padding:12px 4px">' + esc(i18n('noActivity')) + '</div>';
  return list.map(l => {
    const on = l[0] === cur;
    const tr = l[0] === 'en' || langTranslated(l[0]);
    return '<button class="setrow langrow' + (on ? ' on' : '') + '" data-lang="' + l[0] + '">' +
      '<span class="lmain"><span class="ltitle">' + esc(l[1]) + '</span>' +
      '<span class="lsub">' + esc(l[2]) + (tr ? '' : ' \u00b7 ' + esc(i18n('notTranslated'))) + '</span></span>' +
      (on ? '<span class="chip ok">' + esc(i18n('done')) + '</span>' : '') + '</button>';
  }).join('');
}
/* picking a language applies at once; the search filters the list */
document.addEventListener('click', e => {
  const b = e.target && e.target.closest ? e.target.closest('[data-lang]') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  UI_LANG = b.dataset.lang;
  LS.set('lang', UI_LANG);
  applyLang();
  try { renderSettings(); } catch (err) { }
  try { toast(langName(langCode())); } catch (err) { }
}, false);
document.addEventListener('input', e => {
  const i = e.target;
  if (!i || i.id !== 'langSearch') return;
  const box = document.getElementById('langList');
  if (box) box.innerHTML = langRowsHTML(i.value);
}, false);

function settingsRows() {
  return '<div class="card setlist">' + SET_SECTIONS.map(s =>
    '<button class="setrow" data-go="#/settings/' + s[0] + '">' +
    '<span class="setic">' + s[3] + '</span>' +
    '<span class="lmain"><span class="ltitle">' + esc(secTitle(s)) + '</span>' +
    '<span class="lsub">' + esc(secDesc(s)) + '</span></span>' +
    '<span class="setgo">' + CHEV + '</span></button>').join('') + '</div>';
}

function settingsResults(q) {
  const needle = q.trim().toLowerCase();
  const hits = [];
  SET_INDEX.forEach(s => {
    if ((s[0] + ' ' + s[2]).toLowerCase().indexOf(needle) > -1) hits.push({ t: s[0], sec: s[1] });
  });
  SET_SECTIONS.forEach(s => {
    if ((s[1] + ' ' + s[2]).toLowerCase().indexOf(needle) > -1) hits.unshift({ t: s[1], sec: s[0] });
  });
  if (!hits.length) return '<div class="card empty">Nothing in Settings matches \u201c' + esc(q) + '\u201d.</div>';
  return '<div class="card setlist">' + hits.map(h => {
    const s = SEC_OF[h.sec] || [h.sec, 'Settings', '', SVG.dot];
    return '<button class="setrow" data-setgo="' + h.sec + '" data-setfind="' + esc(h.t) + '">' +
      '<span class="setic">' + s[3] + '</span>' +
      '<span class="lmain"><span class="ltitle">' + esc(h.t) + '</span>' +
      '<span class="lsub">' + esc(s[1]) + '</span></span>' +
      '<span class="setgo">' + CHEV + '</span></button>';
  }).join('') + '</div>';
}

function settingsHub() {
  return '<div class="searchbar" id="setSearchWrap">' + SVG.search +
    '<input id="setSearch" placeholder="Search settings\u2026" autocomplete="off"></div>' +
    '<div id="setList">' + settingsRows() + '</div>';
}
/* wrap each <h2 class="sect"> block so a sub-page can show just one of them */
function wrapSettingsSections(html) {
  return html.split(/(?=<h2 class="sect">)/).map(part => {
    const m = part.match(/^<h2 class="sect">([^<]+)<\/h2>/);
    return m ? '<div class="setsec" data-sect="' + esc(m[1]) + '">' + part + '</div>' : part;
  }).join('');
}

function renderSettings() {
  const seq = ++RSEQ;
  const u = USER || {};
  let html = '<div class="seg" id="setSeg" style="margin-bottom:16px"><button class="segb' + (STAB === 'credits' ? '' : ' on') + '" data-st="general">Settings</button><button class="segb' + (STAB === 'credits' ? ' on' : '') + '" data-st="credits">Credits</button></div>';
  const wireTabs = () => $$('[data-st]').forEach(b => b.addEventListener('click', () => { STAB = b.dataset.st; renderSettings(); }));
  if (STAB === 'credits') {
    html += '<div class="card" style="text-align:center;padding:28px 20px">' +
      '<div style="font-size:34px;font-weight:800;letter-spacing:-0.5px">Gitly</div>' +
      '<ul class="creditslist" style="list-style:none;text-align:left;margin:16px auto 0;padding:0;max-width:290px">' +
      '<li class="lsub" style="padding:7px 0 7px 18px;position:relative;border-bottom:1px solid var(--divider)">Version ' + APPV + '</li>' +
      '<li class="lsub" style="padding:7px 0 7px 18px;position:relative;border-bottom:1px solid var(--divider)">Syncs via your GitHub account</li>' +
      '<li class="lsub" style="padding:7px 0 7px 18px;position:relative">Not affiliated with GitHub</li></ul></div>' +
      '<h2 class="sect">Developer</h2>' +
      '<div class="card" style="text-align:center">' +
      '<img src="logo.jpg" alt="BonkerUnkil (Bonki)" style="width:96px;height:96px;border-radius:32px;margin:0 auto 16px;box-shadow:0 8px 28px var(--glow)">' +
      '<div style="padding:8px 0;border-bottom:1px solid var(--divider)"><div class="ltitle">Name</div><div class="lsub" style="margin-top:2px">BonkerUnkil (Bonki)</div></div>' +
      '<div style="padding:8px 0;border-bottom:1px solid var(--divider)"><div class="ltitle">Age</div><div class="lsub" style="margin-top:2px">20</div></div>' +
      '<div style="padding:8px 0"><div class="ltitle">Profession</div><div class="lsub" style="margin-top:2px">Coding, problem solving, and more</div></div></div>' +
      '<h2 class="sect">Connect</h2>' +
      '<div class="card">' +
      '<button class="btn ghost btnblock" data-act="ext" data-url="https://t.me/BonkerUnkilBonki" style="display:flex;align-items:center;justify-content:flex-start;gap:12px">' + SVG.telegram + '<span>Telegram · @BonkerUnkilBonki</span></button>' +
      '<button class="btn ghost btnblock" data-act="ext" data-url="https://github.com/BonkerUnkilBonki" style="display:flex;align-items:center;justify-content:flex-start;gap:12px;margin-top:8px">' + SVG.github + '<span>GitHub · @BonkerUnkilBonki</span></button></div>' +
      '<h2 class="sect">Languages used</h2>' +
      '<div class="card"><div class="chips"><span class="chip">HTML</span><span class="chip">CSS</span><span class="chip">JavaScript</span><span class="chip">Java</span></div></div>';
    if (seq !== RSEQ) return;
    view().innerHTML = html;
    wireTabs();
    document.body.classList.remove('set-hub');
    document.body.classList.add('set-sub');
    return;
  }
  const cur = LS.get('theme', 'light');
  html += '<h2 class="sect">GitHub account</h2><div class="card">' +
    '<div class="lrow" style="padding:12px 0"><div class="lmain"><div class="ltitle">Sign-in method</div><div class="lsub lsubwrap">' + esc(loginMethodLabel()) +
    (TOKEN_SCOPES ? ' · scopes: ' + esc(TOKEN_SCOPES) : (loginMethod() === 'fine' ? ' · permissions are chosen per token on github.com' : '')) + '</div></div></div>' +
    '<div class="lrow" style="padding:12px 0;border-top:1px solid var(--divider)" data-go="#/authorized"><div class="lmain"><div class="ltitle">Authorized apps</div><div class="lsub lsubwrap">Apps you have let sign in with your GitHub account — see what they can reach, revoke them, or authorize a new one</div></div>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex-shrink:0;color:var(--text2)"><polyline points="9 18 15 12 9 6"/></svg></div>' +
    '<div class="lrow" style="padding:12px 0;border-top:1px solid var(--divider)" data-go="#/tokens"><div class="lmain"><div class="ltitle">Personal access tokens</div><div class="lsub lsubwrap">Make a token with the right permissions — Gitly fills GitHub\'s form in for you</div></div>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;flex-shrink:0;color:var(--text2)"><polyline points="9 18 15 12 9 6"/></svg></div></div>';
  const themes = { light: 'Light', dark: 'Dark', pitch: 'Pitch black' };
  const accents = { blue: ['#1B6EF3', 'Blue'], purple: ['#8B5CF6', 'Purple'], green: ['#12B76A', 'Green'], pink: ['#EC4899', 'Pink'], amber: ['#F59E0B', 'Amber'], teal: ['#14B8A6', 'Teal'], red: ['#EF4444', 'Red'], indigo: ['#6366F1', 'Indigo'], dynamic: ['', 'Dynamic'], custom: ['', 'Custom'] };
  const curA = LS.get('accent', 'blue');
  const curCustom = (LS.get('customAccent', '') || '').toUpperCase();
  html += '<div class="card profile"><img class="pav" src="' + esc(u.avatar_url || '') + '" alt=""><div class="pname">' + esc(u.name || u.login || '') + '</div><div class="plogin">@' + esc(u.login || '') + '</div></div>';
  html += '<h2 class="sect">Appearance</h2>';
  html += '<div class="card"><div class="setrow"><div class="lmain"><div class="ltitle">Theme</div><div class="lsub">Pitch black saves battery on AMOLED screens</div></div></div>' +
    '<div class="seg" style="margin:14px 0 0">' +
    Object.keys(themes).map(t => '<button class="segb' + (cur === t ? ' on' : '') + '" data-thm="' + t + '">' + themes[t] + '</button>').join('') + '</div></div>';
  const dotCls = a => (a === 'dynamic' ? ' dyn' : (a === 'custom' ? ' customdot' : ''));
  const dotStyle = a => (a === 'dynamic') ? '' : (a === 'custom' ? (curCustom ? ' style="background:' + curCustom + '"' : '') : ' style="background:' + accents[a][0] + '"');
  html += '<div class="card"><div class="ltitle">Accent color</div>' +
    '<div class="accentrow">' + Object.keys(accents).map(a => '<button class="accentdot' + (curA === a ? ' on' : '') + dotCls(a) + '" data-acc="' + a + '"' + dotStyle(a) + ' aria-label="' + accents[a][1] + '"></button>').join('') + '</div>' +
    '<div class="lsub" style="margin-top:10px">' + (curA === 'dynamic' ? 'Dynamic — follows your system / wallpaper color' : curA === 'custom' ? 'Custom — pick any color below' : accents[curA][1] + ' accent — applies to buttons, highlights and glows') + '</div>' +
    (curA === 'custom' ? '<div class="colorrow"><input type="color" id="colorPick" value="' + (curCustom || '#1B6EF3') + '"><input class="fld" id="colorHex" value="' + (curCustom || '#1B6EF3') + '" maxlength="7" spellcheck="false"><button class="btn primary" id="colorApply">Apply</button></div>' : '') + '</div>';
  html += '<div class="card">' +
    settingRow('Glow effects', 'Neon glow on buttons and cards', LS.get('glow', true), 'glowSw', 'glow effects') +
    settingRow('Navigation glow', 'Glow around the bottom bar', LS.get('navglow', false), 'navglowSw', 'navigation glow', 1) +
    settingRow('Compact mode', 'Tighter layout for one-handed use', LS.get('compact', false), 'compactSw', 'compact mode', 1) +
    settingRow('Auto-adjust to screen', 'Fits the layout to your device', LS.get('autoadjust', true), 'autoAdjSw', 'auto adjust', 1) +
    '</div>';
  html += '<h2 class="sect">Accessibility</h2>';
  html += '<div class="card">' +
    settingRow('Reduce motion', 'Turns off animations', LS.get('reduceMotion', false), 'motionSw', 'reduce motion') +
    settingRow('Show link underlines', 'Underlines links in READMEs', LS.get('linkUnderline', false), 'underlineSw', 'link underlines', 1) +
    '</div>';
  html += '<h2 class="sect">App updates</h2>';
  html += '<div class="card"><div class="setrow"><div class="lmain"><div class="ltitle">Auto-download app updates</div><div class="lsub">When you publish a new Gitly release on GitHub, the update APK is downloaded to your Downloads folder automatically.</div></div>' +
    '<button class="switch' + (LS.get('autodl', false) ? ' on' : '') + '" id="autodlSw" aria-label="auto download updates"></button></div>' +
    '<div class="setrow" style="border-top:1px solid var(--divider)"><div class="lmain"><div class="ltitle">Install updates automatically</div><div class="lsub">Opens the Android installer as soon as the update finishes downloading, so the update actually lands. Android asks once to allow Gitly to install unknown apps. Turn this off to download only.</div></div>' +
    '<button class="switch' + (LS.get('autoinstall', true) ? ' on' : '') + '" id="autoinstallSw" aria-label="install updates automatically"></button></div>' +
    '<div style="display:flex;gap:10px;align-items:center;padding:12px 0 2px;margin-top:12px;border-top:1px solid var(--divider)">' +
    '<div class="lmain" style="flex:1"><div class="ltitle">Installed</div><div class="lsub">Version ' + APPV + '</div></div>' +
    '<div class="lmain" style="flex:1;text-align:right"><div class="ltitle" id="updLatest">Checking…</div><div class="lsub">latest on GitHub</div></div></div>' +
    '<div id="updInfo"></div></div>';
  html += '<h2 class="sect">Notifications</h2>';
  html += '<div class="card">' +
    '<div class="setrow"><div class="lmain"><div class="ltitle">Live-update notifications</div><div class="lsub">Shows an upload or an app-update download as a live card in the shade: a context line beside the app name, a bold title, a time-remaining line, a thin progress bar and a Cancel button. It updates in place and never makes a sound. Turn it off for a plain, minimal progress notification.</div></div>' +
    '<button class="switch' + (LS.get('liveNotif', true) ? ' on' : '') + '" id="liveNotifSw" aria-label="live-update notifications"></button></div>' +
    '</div>';
  html += '<h2 class="sect">Language</h2>';
  html += '<div class="card"><div class="lsub" style="margin:0 4px 12px">' + esc(i18n('languageSub')) + '</div>' + langPickerHTML() + '</div>';
  html += '<h2 class="sect">Sync across devices</h2>';
  html += '<div class="card"><p style="margin:0;font-size:13.5px;color:var(--text2);line-height:1.6">Sign in with the same GitHub account on any device and Gitly pulls your data from GitHub. Your pins, theme and preferences are also saved to a private Gist in your account, so a new device picks up where you left off. Your access token stays on this device only — it is never synced.</p>' +
    '<div class="btncol"><button class="btn primary" data-act="synctoast">Sync now</button><button class="btn ghost" data-act="syncrestore">Restore from GitHub</button></div>' +
    '<div class="syncstat" id="syncStat">' + (gistId ? 'Linked to a private Gist in your account' : 'No sync Gist yet — one is created on your first sync') + '</div></div>';
  html += '<h2 class="sect">Pinned repositories</h2>';
  if (pins.length) {
    html += '<div class="card list">';
    pins.forEach(p => {
      html += '<div class="lrow"><div class="lmain"><div class="ltitle">' + esc(p.full_name) + '</div></div><button class="pinbtn pinned" data-act="unpin" data-full="' + esc(p.full_name) + '" aria-label="unpin">' + SVG.star + '</button></div>';
    });
    html += '</div>';
  } else html += '<div class="card empty">Nothing pinned yet.</div>';
  html += '<h2 class="sect">Account</h2>';
  const accs = reconcileAccounts();
  const curLogin = ((USER && USER.login) || '').toLowerCase();
  if (accs.length) {
    html += '<div class="card list">' + accs.map(a =>
      '<div class="lrow" data-swacc="' + esc(a.login) + '">' +
      (a.avatar ? '<img src="' + esc(a.avatar) + '" alt="" style="width:34px;height:34px;border-radius:50%;flex-shrink:0">' : '') +
      '<div class="lmain"><div class="ltitle">' + esc(a.login) + '</div><div class="lsub">' + (String(a.login).toLowerCase() === curLogin ? 'Currently active' : 'Tap to switch to this account') + '</div></div>' +
      (String(a.login).toLowerCase() === curLogin ? '<span class="chip ok">Active</span>' : '') + '</div>').join('') + '</div>';
  }
  html += '<div style="display:flex;gap:8px"><button class="btn ghost" id="addAccBtn" style="flex:1">Add account</button><button class="btn danger" id="logoutBtn" style="flex:1">Sign out</button></div>';
  html += '<h2 class="sect">API budget</h2><div class="card" id="budgetCard">' + budgetBodyHTML() + '</div>';
  if (seq !== RSEQ) return;
  html = wrapSettingsSections(html);
  document.body.classList.toggle('set-hub', !SET_SEC);
  document.body.classList.toggle('set-sub', !!SET_SEC);
  if (!SET_SEC) {
    /* the hub, with the full page kept in the DOM so every control stays wired */
    html = settingsHub() + '<div id="setFull">' + html + '</div>';
  } else {
    const want = SET_SEC === 'credits' ? '' : (SET_TITLE[SET_SEC] || '');
    const tag = 'data-sect="' + esc(want) + '"';
    if (html.indexOf(tag) > -1) html = html.replace(tag, tag + ' data-on="1"');
  }
  view().innerHTML = html;
  wireTabs();
  /* arriving from a search result: mark the row that was asked for. The page
     settles just after it is drawn, so the mark is re-applied once behind that
     - otherwise the redraw would take it straight back off again. */
  if (SET_SEC && SET_FIND) {
    const want = SET_FIND.toLowerCase();
    const mark = () => {
      const rows = document.querySelectorAll('.setsec[data-on] .setrow');
      for (const r of rows) {
        const t = r.querySelector('.ltitle');
        if (t && t.textContent.trim().toLowerCase() === want) {
          if (!r.classList.contains('found')) {
            r.classList.add('found');
            try { r.scrollIntoView({ block: 'center' }); } catch (e) { }
          }
          return true;
        }
      }
      return false;
    };
    mark();
    setTimeout(mark, 450);
    setTimeout(mark, 1200);
    setTimeout(() => { SET_FIND = ''; }, 4000);
  }
  view().innerHTML = html;
  wireTabs();
  $$('[data-thm]').forEach(b => b.addEventListener('click', () => {
    LS.set('theme', b.dataset.thm); applyTheme(); queueSync();
    $$('[data-thm]').forEach(x => x.classList.toggle('on', x === b));
    toast(themes[b.dataset.thm] + ' theme');
  }));
  $$('[data-acc]').forEach(b => b.addEventListener('click', () => {
    LS.set('accent', b.dataset.acc); applyTheme(); queueSync();
    $$('[data-acc]').forEach(x => x.classList.toggle('on', x === b));
    toast(b.dataset.acc === 'dynamic' ? 'Dynamic accent — following your system color' : b.dataset.acc === 'custom' ? 'Custom color — pick your shade below' : accents[b.dataset.acc][1] + ' accent');
    renderSettings();
  }));
  const cp = $('#colorPick'), chx = $('#colorHex'), cap = $('#colorApply');
  if (cp && chx) {
    cp.addEventListener('input', () => { chx.value = cp.value.toUpperCase(); });
    cp.addEventListener('change', () => { LS.set('customAccent', cp.value.toUpperCase()); applyTheme(); queueSync(); toast('Custom color applied'); });
    const applyHex = () => {
      let v = (chx.value || '').trim().toUpperCase();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9A-F]{6}$/.test(v)) { LS.set('customAccent', v); applyTheme(); queueSync(); toast('Custom color applied'); renderSettings(); }
      else toast('Enter a color like #1B6EF3');
    };
    if (cap) cap.addEventListener('click', applyHex);
    chx.addEventListener('keydown', e => { if (e.key === 'Enter') applyHex(); });
  }
  const glowSw = $('#glowSw');
  if (glowSw) glowSw.addEventListener('click', () => {
    const on = !glowSw.classList.contains('on');
    glowSw.classList.toggle('on', on);
    LS.set('glow', on); applyTheme(); queueSync();
    toast(on ? 'Glow effects on' : 'Glow effects off');
  });
  const nsw = $('#navglowSw');
  if (nsw) nsw.addEventListener('click', () => {
    const on = !nsw.classList.contains('on');
    nsw.classList.toggle('on', on);
    LS.set('navglow', on); applyTheme(); queueSync();
    toast(on ? 'Navigation glow on' : 'Navigation glow off');
  });
  const msw = $('#motionSw');
  if (msw) msw.addEventListener('click', () => {
    const on = !msw.classList.contains('on');
    msw.classList.toggle('on', on);
    LS.set('reduceMotion', on); applyA11y(); queueSync();
    toast(on ? 'Reduced motion — animations off' : 'Animations on');
  });
  const usw = $('#underlineSw');
  if (usw) usw.addEventListener('click', () => {
    const on = !usw.classList.contains('on');
    usw.classList.toggle('on', on);
    LS.set('linkUnderline', on); applyA11y(); queueSync();
    toast(on ? 'Link underlines shown' : 'Link underlines hidden');
  });
  const adw = $('#autodlSw');
  if (adw) adw.addEventListener('click', () => {
    const on = !adw.classList.contains('on');
    adw.classList.toggle('on', on);
    LS.set('autodl', on); queueSync();
    toast(on ? 'Auto-download updates on' : 'Auto-download updates off');
  });
  const aiw = $('#autoinstallSw');
  if (aiw) aiw.addEventListener('click', () => {
    const on = !aiw.classList.contains('on');
    aiw.classList.toggle('on', on);
    LS.set('autoinstall', on); queueSync();
    toast(on ? 'Updates will install themselves' : 'Updates will only be downloaded');
  });
  const latestEl = $('#updLatest'), infoEl = $('#updInfo');
  if (latestEl) {
    latestPublishedRelease().then(rel => {
      if (!latestEl.isConnected) return;
      const label = (rel && (rel.name || rel.tag_name)) || 'not found';
      latestEl.textContent = label;
      if (!infoEl || !rel || !rel.id) return;
      // update when the release's tag version is newer than this app's version,
      // or when the release was published after this install
      const published = Date.parse(rel.published_at || '') || 0;
      const tagv = releaseVersion(rel);
      const versionNewer = !!tagv && newerVersion(tagv, APPV);
      const dateNewer = !!(published && INSTALLED_AT && published > INSTALLED_AT);
      const isUpdate = versionNewer || dateNewer;
      const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name || ''));
      infoEl.innerHTML =
        (isUpdate
          ? '<div class="lsub" style="padding:10px 0 4px">Update available — ' + esc(label) + '</div>' +
            (asset ? '<div class="lrow" data-act="download" data-url="' + esc(asset.browser_download_url) + '" data-name="' + esc(asset.name) + '" data-api="https://api.github.com/repos/' + esc(UPD_REPO) + '/releases/assets/' + asset.id + '" data-accept="application/octet-stream" style="padding:10px 0">' + SVG.dl +
            '<div class="lmain"><div class="ltitle">' + esc(asset.name) + '</div><div class="lsub">' + fmtSize(asset.size) + ' · tap to download the update</div></div></div>' : '')
          : '<div class="lsub" style="padding:10px 0 4px">You are on the latest version.</div>') +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn ghost" id="updLog" style="flex:1">ChangeLog</button>' +
        (isUpdate ? '<button class="btn ghost" id="updPopup" style="flex:1">Show update popup</button>' : '') +
        '</div>';
      const lg = $('#updLog');
      if (lg) lg.addEventListener('click', () => showChangelogSheet(rel));
      const pu = $('#updPopup');
      if (pu) pu.addEventListener('click', () => { showUpdateCard(rel); });
    }).catch(() => { if (latestEl.isConnected) latestEl.textContent = 'check failed'; });
  }
  $('#logoutBtn').addEventListener('click', () => doLogout('Signed out'));
  $$('[data-swacc]').forEach(r => r.addEventListener('click', () => switchAccount(r.dataset.swacc)));
  const aab = $('#addAccBtn');
  if (aab) aab.addEventListener('click', () => { showLogin(); $('#tokenInput').value = ''; });
  const autoAdjSw = $('#autoAdjSw');
  if (autoAdjSw) autoAdjSw.addEventListener('click', () => {
    const on = !autoAdjSw.classList.contains('on');
    autoAdjSw.classList.toggle('on', on);
    LS.set('autoadjust', on);
    applyAutoAdjust();
    toast(on ? 'Auto-adjust on — fitting your screen' : 'Auto-adjust off');
  });
  const compactSw = $('#compactSw');
  if (compactSw) compactSw.addEventListener('click', () => {
    const on = !compactSw.classList.contains('on');
    compactSw.classList.toggle('on', on);
    LS.set('compact', on);
    applyTheme();
    toast(on ? 'Compact mode on — one-hand friendly' : 'Compact mode off');
  });
  const liveSw = $('#liveNotifSw');
  if (liveSw) liveSw.addEventListener('click', () => {
    const on = !liveSw.classList.contains('on');
    liveSw.classList.toggle('on', on);
    LS.set('liveNotif', on); queueSync();
    pushLiveNotif();
    toast(on ? 'Live-update notifications on' : 'Plain progress notifications');
  });
}

/* ================= actions ================= */
const ACTIONS = {
  ext: el => { try { window.location.href = el.dataset.url; } catch (e) {} },
  hookping: async el => {
    const full = el.dataset.full, id = el.dataset.id;
    el.disabled = true;
    try { await api('/repos/' + full + '/hooks/' + id + '/pings', { method: 'POST' }); toast('Test ping sent'); }
    catch (e) { toast('Ping failed: ' + e.message); }
    el.disabled = false;
  },
  hooktoggle: async el => {
    const full = el.dataset.full, id = el.dataset.id, on = el.dataset.on === '1';
    el.disabled = true;
    try {
      await api('/repos/' + full + '/hooks/' + id, { method: 'PATCH', body: JSON.stringify({ active: !on }) });
      toast(on ? 'Webhook paused' : 'Webhook enabled');
      route();
    } catch (e) { toast('Failed: ' + e.message); el.disabled = false; }
  },
  hookdeliv: el => hookDeliveries(el.dataset.full, el.dataset.id),
  hookdel: el => {
    const full = el.dataset.full, id = el.dataset.id;
    openSheet('<div class="sheethead"><b>Delete webhook</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
      '<p class="dim" style="margin:4px 0 14px">Remove the webhook pointing at ' + esc(el.dataset.url || 'this URL') + '? GitHub will stop sending it.</p>' +
      '<button class="btn danger btnblock" id="hkDelGo">Delete webhook</button>');
    const g = $('#hkDelGo');
    if (g) g.addEventListener('click', async () => {
      g.disabled = true;
      try { await api('/repos/' + full + '/hooks/' + id, { method: 'DELETE' }); closeSheet(); toast('Webhook deleted'); route(); }
      catch (e) { toast('Failed: ' + e.message); g.disabled = false; }
    });
  },
  discover: () => { RS.mode = 'discover'; location.hash = '#/repos'; },
  clone: el => cloneSheet(el.dataset.full),
  copy: el => {
    const t = el.dataset.copy;
    try { if (window.OneGit && window.OneGit.copy) { window.OneGit.copy(t); toast('Copied to clipboard'); return; } } catch (e) {}
    try { navigator.clipboard.writeText(t); toast('Copied to clipboard'); } catch (e) { toast('Copy not available here'); }
  },
  download: el => {
    const url = el.dataset.url || '';
    const name = el.dataset.name || 'download';
    /* say what is happening, not what has happened: the device reports the real
       outcome once the file is actually written */
    toast('Downloading ' + name + '\u2026');
    /* A private repository's files need the signed-in token, and the system
       Download Manager has none - that is what made "Download ZIP" fail with
       "Download unsuccessful". GitHub's API serves the same file to an
       authenticated request, so anything on github.com is rewritten to its API
       form and fetched by the app itself. */
    const api = el.dataset.api ? { url: el.dataset.api, accept: el.dataset.accept || '' } : ghApiDownload(url);
    /* a public repository's file needs no token and no API call: the system
       downloader takes the github.com link directly. Only private (or not yet
       known) repositories go through the signed-in API route. */
    let freeHost = false;
    try {
      const mm = new URL(url).pathname.match(/^\/([^\/]+)\/([^\/]+)\//);
      freeHost = !!(mm && /(^|\.)github\.com$/.test(new URL(url).hostname) && repoKnownPublic(mm[1], mm[2]));
    } catch (e) { }
    if (!freeHost && TOKEN && api && window.OneGit && window.OneGit.downloadAuthed) {
      try { window.OneGit.downloadAuthed(api.url, name, api.accept); return; } catch (e) {}
    }
    try { if (window.OneGit && window.OneGit.download) { window.OneGit.download(url, name); return; } } catch (e) {}
    try { window.location.href = url; } catch (e) {}
  },
  /* repo-file attachment download that routes through api.github.com,
     so it works even where raw.githubusercontent.com is unreachable */
  apidl: (el, e) => {
    toast('Downloading ' + el.dataset.name + '\u2026');
    const rawUrl = 'https://raw.githubusercontent.com/' + el.dataset.owner + '/' + el.dataset.repo + '/HEAD/' +
      String(el.dataset.path).split('/').map(encodeURIComponent).join('/');
    /* The file is fetched and written by the app itself, always - for public
       repositories too. The system downloader was used for public repos and it
       was the reason nothing appeared in the file manager: it decides its own
       destination, it has no token, and its failures were invisible. The app's
       own fetch writes into Downloads properly and can say what happened. */
    try {
      if (window.OneGit && window.OneGit.downloadAuthed) {
        window.OneGit.downloadAuthed(rawUrl, el.dataset.name, '');
        return;
      }
    } catch (err) { }
    try {
      if (window.OneGit && window.OneGit.apiDownload) { window.OneGit.apiDownload(el.dataset.owner, el.dataset.repo, el.dataset.path, el.dataset.name); return; }
    } catch (err) {}
    if (e) e.preventDefault ? e.preventDefault() : null;
    try { window.location.href = rawUrl; } catch (err) {}
  },
  deployments: el => deploymentsSheet(el.dataset.full),
  openfile: async el => {
    const full = el.dataset.repo, path = el.dataset.file;
    openSheet('<div class="sheethead"><b>' + esc(path.split('/').pop()) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + spinner(true));
    try {
      const meta = await api('/repos/' + full + '/contents/' + (path ? encodeURIComponent(path).replace(/%2F/g, '/') : ''));
      let raw = '';
      if (meta && typeof meta.content === 'string' && meta.encoding === 'base64') {
        const b64 = meta.content.replace(/\n/g, '');
        try { raw = decodeURIComponent(escape(atob(b64))); } catch (e2) { raw = atob(b64); }
      }
      const card = $('.sheetcard');
      if (card) {
        const MAX = 60000;
        let shown = raw, cut = false;
        if (raw.length > MAX) { shown = raw.slice(0, MAX); cut = true; }
        const lines = shown.split('\n');
        if (lines.length > 2000) { shown = lines.slice(0, 2000).join('\n'); cut = true; }
        const headHtml = '<div class="sheethead"><b>' + esc(path) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>';
        const codeHtml = codeWithLines(shown || '') + (cut ? '<div class="lsub" style="padding:0 14px 12px">… — this file is large, showing the first ' + nf(Math.min(raw.length, MAX)) + ' characters.</div>' : '');
        card.innerHTML = headHtml + codeHtml;
        {
          const parts = full.split('/');
          const fname = path.split('/').pop() || 'file';
          const canEdit = await canPushRepo(parts[0], parts[1]);
          /* Download is offered for every file - including binaries the viewer
             cannot show (a .ttf, a .keystore, anything over 1MB) */
          let acts = '<div class="fileacts" style="display:flex;gap:8px">' +
            '<button class="btn ghost" data-act="apidl" data-owner="' + esc(parts[0]) + '" data-repo="' + esc(parts[1]) + '" data-path="' + esc(path) + '" data-name="' + esc(fname) + '" style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px">' + SVG.dl + '<span>Download</span></button>';
          if (canEdit && raw) {
            acts += '<button class="btn ghost" id="editFileBtn" style="flex:1">Edit</button>' +
              '<button class="btn danger" id="delFileBtn" style="flex:1">Delete</button>';
          }
          acts += '</div>';
          card.innerHTML = headHtml + acts + codeHtml;
          if (canEdit && raw) {
            $('#editFileBtn').addEventListener('click', () => editFileSheet(full, path, raw, meta.sha));
            $('#delFileBtn').addEventListener('click', () => deleteFileSheet(full, path, meta.sha));
          }
        }
      }
    } catch (e) { closeSheet(); toast('Cannot open this file'); }
  },
  relup: el => {
    const rid = el.dataset.relup, rf = el.dataset.full;
    if (window.OneGit && window.OneGit.pickAssets && rf) {
      try { toast('Choose files to attach'); window._assetAfter = () => route(); window.OneGit.pickAssets(rf, rid); return; } catch (e) {}
    }
    window._relTarget = rid; const inp = $('#relUpInput'); if (inp) inp.click();
  },
  delasset: el => { deleteAssetSheet(el.dataset.full, el.dataset.aid, el.dataset.aname); },
  renasset: el => { renameAssetSheet(el.dataset.full, el.dataset.aid, el.dataset.aname); },
  closesheet: () => closeSheet(),
  synctoast: () => syncPush(false),
  syncrestore: () => syncRestore(false),
  unpin: el => { pins = pins.filter(p => p.full_name !== el.dataset.full); LS.set('pins', pins); queueSync(); toast('Unpinned'); renderSettings(); }
};

/* ================= global events ================= */
document.addEventListener('click', e => {
  const pin = e.target.closest('[data-pinbtn]');
  if (pin) { const r = repoCache.get(pin.dataset.pinbtn); if (r) togglePin(r); return; }
  const act = e.target.closest('[data-act]');
  if (act && ACTIONS[act.dataset.act]) { e.preventDefault(); ACTIONS[act.dataset.act](act, e); return; }
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = go.dataset.go; return; }
  /* collapsible README panels animate open/closed instead of popping */
  const sm = e.target.closest('summary');
  if (sm && sm.parentElement && sm.parentElement.tagName === 'DETAILS') {
    const d = sm.parentElement;
    e.preventDefault();
    const opening = !d.open;
    const h0 = d.offsetHeight;
    let h1;
    if (opening) { d.open = true; h1 = d.offsetHeight; } else { h1 = sm.offsetHeight; }
    d.style.overflow = 'hidden';
    d.style.transition = 'none';
    d.style.height = h0 + 'px';
    requestAnimationFrame(() => {
      d.style.transition = 'height .26s cubic-bezier(.4,0,.2,1)';
      d.style.height = h1 + 'px';
      setTimeout(() => {
        if (!opening) d.open = false;
        d.style.removeProperty('height'); d.style.removeProperty('overflow'); d.style.removeProperty('transition');
      }, 280);
    });
    return;
  }
  /* links inside rendered GitHub content */
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href') || '';
    /* in-page anchors from GitHub content only (app routes use #/…) */
    if (href.charAt(0) === '#' && href.charAt(1) !== '/') {
      /* in-page anchor - scroll to the heading, never touch the route */
      e.preventDefault();
      const id = href.slice(1).replace(/[^\w-]/g, '');
      const scope = a.closest('.md, .sheetcard') || document;
      const t = id && (scope.querySelector('a[name="' + id + '"]') || scope.querySelector('[id="' + id + '"]') || scope.querySelector('[id="user-content-' + id + '"]'));
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const m = href.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
    if (m) {
      /* repo / profile links open inside the app */
      e.preventDefault();
      location.hash = '#/repo/' + m[1] + '/' + m[2];
      return;
    }
    /* anything else falls through and the WebViewClient opens it in the browser */
  }
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
/* keyboard + window handling for desktop and laptop use */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const s = $('#sheet');
    if (s && !s.hidden) { closeSheet(); return; }
  }
});
window.addEventListener('resize', () => { if (isWide()) navShow(); });
/* ---- bottom nav auto-hide: hides on scroll-down and after idle, returns on any touch or scroll-up ---- */
let lastY = 0, idleT = null;
/* on a laptop the navigation is a permanent rail, so the auto-hide behaviour
   is limited to the phone layout */
function isWide() { try { return window.innerWidth >= 1080; } catch (e) { return false; } }
function navShow() { const nb = $('#navbar'); if (nb) nb.classList.remove('hide'); resetIdle(); }
function navHide() { if (isWide()) return; const nb = $('#navbar'); if (nb) nb.classList.add('hide'); clearTimeout(idleT); }
function resetIdle() {
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (isWide()) return; const sc = $('#scroller'); if (sc && sc.scrollTop > 150) navHide(); }, 4000);
}
$('#scroller').addEventListener('scroll', () => {
  const sc = $('#scroller'); const y = sc.scrollTop;
  $('#appbar').classList.toggle('on', y > 110);
  if (!isWide()) {
    if (y > lastY + 10 && y > 80) navHide();
    else if (y < lastY - 10) navShow();
  }
  lastY = y;
  updateToTop();
  resetIdle();
});
document.addEventListener('pointerdown', () => navShow(), true);
window.addEventListener('keydown', () => navShow());
wireAcctDelegates();
wireReactions();
/* An upload can finish while the app is closed - the native side keeps the
   outcome, and this is where the user finally hears about it. */
function reportAwayUpload() {
  try {
    if (!window.OneGit || !window.OneGit.uploadState) return;
    const raw = window.OneGit.uploadState();
    if (!raw) return;
    if (window.OneGit.clearUploadState) window.OneGit.clearUploadState();
    const s = JSON.parse(raw);
    if (s && s.text) toast((s.ok ? 'Upload finished \u2014 ' : 'Upload failed \u2014 ') + s.text);
  } catch (e) { }
}
try { applyLang(); } catch (e) { }
try { budgetLoad(); } catch (e) { }
reportAwayUpload();
pushLiveNotif();
/* rebuild the account list from the device if the page's own storage was cleared */
try { restoreAccountsFromDevice(); } catch (e) { }
$('#backBig').addEventListener('click', () => history.back());
$('#backApp').addEventListener('click', () => history.back());
const doRefresh = () => {
  /* refresh by sliding new rows in - never by redrawing the page */
  beginRefresh();
  FORCE_FRESH = true;               /* an explicit refresh always goes to the network */
  const done = () => { FORCE_FRESH = false; endRefresh(); };
  if (typeof LIVE_REFRESH === 'function') {
    try {
      const r = LIVE_REFRESH();
      if (r && typeof r.then === 'function') r.then(done, done); else done();
      return;
    } catch (e) { }
  }
  refreshInPlace().then(done, done);
};
$('#refreshBig').addEventListener('click', doRefresh);
$('#refreshApp').addEventListener('click', doRefresh);
/* shared by token login and OAuth: validates the token, stores it, restores sync */
async function completeLogin(tok) {
  const old = TOKEN; TOKEN = tok;
  dropInflight();
  dropApiMem();                     /* nothing cached for the previous account may answer this */
  try {
    /* fresh: the cache is still keyed to the OLD account at this point, so a
       saved /user reply would be the previous account's profile. That is what
       made a new sign-in overwrite the existing account with the new token
       instead of adding a second one - which in turn hid the switch button,
       because the list never grew past one. */
    USER = await api('/user', { fresh: true });
    /* A sign-in - the same account signing in again through GitHub especially -
       used to keep every screen the last session saved, plus the stamps that
       stopped those screens reloading. That is why it opened on old data. */
    clearFetchedForAccount();
    const rec = addAccount(USER.login, tok, USER.avatar_url || '');
    reconcileAccounts();
    ACCT = String(USER.login).toLowerCase();
    LS.set('cur', ACCT);
    try { budgetLoad(); } catch (e) { }   /* this account's allowance, not the last one's */
    gistId = rec.gistId || null; LS.set('gistId', gistId);
    LS.set('token', tok);
    saveTokenNative();
    pushLiveNotif();
    /* show the app now: restoring the synced settings is one more round trip and
       waiting for it held the whole sign-in up */
    if (location.hash === '#/home' || location.hash === '') route();
    else location.hash = '#/home';
    widgetPush();
    toast('Welcome, ' + USER.login);
    const restored = await syncRestore(true).catch(() => false);
    saveGistToAccount();
    if (restored) toast('Your saved settings came back from GitHub');
    /* GitHub can hand back a token missing a scope the user unticked. Without
       this, the feature that needs it fails much later with a confusing error -
       and it was never checked on either sign-in method. */
    try { warnMissingScopes(); } catch (e) { }
  } catch (e) {
    TOKEN = old; USER = null;
    throw e;
  }
}
/* says, once, which abilities GitHub did not grant */
function warnMissingScopes() {
  const have = String(TOKEN_SCOPES || '').toLowerCase();
  if (!have) return;                     /* fine-grained tokens report no scope list */
  const need = [
    ['repo', 'repositories'],
    ['notifications', 'notifications'],
    ['gist', 'cross-device sync']
  ];
  const missing = need.filter(n => have.indexOf(n[0]) === -1).map(n => n[1]);
  if (have.indexOf('read:user') === -1 && have.indexOf('user') === -1) missing.unshift('your profile');
  if (missing.length) {
    toast('Signed in \u2014 but GitHub did not grant: ' + missing.join(', ') + '. Sign in again and tick them.');
  }
}
$('#loginBtn').addEventListener('click', async () => {
  const tok = $('#tokenInput').value.trim();
  if (!tok) { toast('Paste your GitHub token first'); return; }
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in…'; $('#loginErr').textContent = '';
  try {
    await completeLogin(tok);
  } catch (e) {
    if (e && (e.rateLimited || /rate limit/i.test(e.message || ''))) {
      const mins = Math.max(1, Math.round((Math.max(RL_UNTIL, GQL_UNTIL) - Date.now()) / 60000));
      $('#loginErr').textContent = 'GitHub accepted this token but this account has used its hourly requests (REST and GraphQL). ' +
        'Nothing is wrong with the token \u2014 try again in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.';
    } else
    $('#loginErr').textContent = (e.message || 'Sign-in failed') + ' — check the token and its scopes.';
    toast('Sign-in failed');
  }
  btn.disabled = false; btn.textContent = 'Sign in';
});

/* ---------- sign-in on the published website ----------
   GitHub's token endpoint sends no CORS headers, so a page cannot finish the
   sign-in itself. The app uses the device flow through its native bridge; the
   website uses the redirect flow, which needs the small helper described in
   oauth-config.js. If no helper is configured the button stays hidden and
   personal-access-token sign-in is used, as before. */
function webOAuthReady() {
  try {
    const c = window.GITLY_OAUTH || {};
    return !!(c && c.worker && /^https:\/\//i.test(String(c.worker)));
  } catch (e) { return false; }
}
function startWebLogin() {
  const c = window.GITLY_OAUTH || {};
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { LS.set('oauth.state', state); } catch (e) {}
  const redirect = location.origin + location.pathname;
  location.href = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(c.clientId || '')
    + '&scope=' + encodeURIComponent(c.scopes || 'repo read:user notifications gist')
    + '&state=' + encodeURIComponent(state)
    + '&redirect_uri=' + encodeURIComponent(redirect);
}
/* runs on load: GitHub sends the one-time code back to the site */
async function finishWebLogin() {
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return false; }
  const code = q.get('code'), state = q.get('state'), err = q.get('error');
  if (!code && !err) return false;
  try { history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) {}
  if (err) { toast('GitHub sign-in was cancelled'); return false; }
  const expect = LS.get('oauth.state', '');
  if (!expect || state !== expect) { toast('Sign-in failed — please start again'); return false; }
  try { LS.del('oauth.state'); } catch (e) {}
  const c = window.GITLY_OAUTH || {};
  try {
    toast('Signing you in…');
    const res = await fetch(String(c.worker).replace(/\/+$/, '') + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });
    const j = await res.json().catch(() => ({}));
    const tok = j.access_token || (j.data && j.data.access_token) || '';
    if (!tok) throw new Error(j.error_description || j.error || ('helper returned ' + res.status));
    await completeLogin(tok);
    return true;
  } catch (e) {
    toast('Sign-in failed: ' + (e.message || 'could not reach the helper'));
    return false;
  }
}
try {
  const native = !!(window.OneGit && window.OneGit.oauthStart);
  if (!native && !webOAuthReady()) {
    const gb = document.getElementById('ghLoginBtn');
    if (gb) gb.hidden = true;
    const dv = document.getElementById('loginDivider');
    if (dv) dv.hidden = true;
  }
} catch (e) {}

/* ================= GitHub OAuth sign-in (device flow, no secret needed) ================= */
const OAUTH_SCOPES = 'repo read:user notifications gist';
let oauthTimer = null, oauthBusy = false;
/* v3.16: the same device flow, but asked for on purpose and with the scopes the
   user picked, so Gitly can mint a token for itself and show it back. */
let oauthScopeOverride = null, oauthMakeToken = false;
function startOauthWithScopes(scopes, makeToken) {
  if (!window.OneGit || !OneGit.oauthStart) {
    toast('This build cannot create tokens in-app — use one of the GitHub options');
    return;
  }
  oauthScopeOverride = (scopes && scopes.length) ? scopes.join(' ') : OAUTH_SCOPES;
  oauthMakeToken = !!makeToken;
  try { OneGit.oauthStart(oauthScopeOverride); }
  catch (e) { toast('Could not start: ' + e.message); }
}
function oauthPending() {
  const p = LS.get('oauth.pending', null);
  return (p && p.device_code && Date.now() < p.expires) ? p : null;
}
window.__oauthStart = (ok, resp) => {
  const btn = $('#ghLoginBtn');
  if (btn) btn.disabled = false;
  if (!ok) { toast('Could not start sign-in: ' + resp); return; }
  let j = {};
  try { j = JSON.parse(resp) || {}; } catch (e) {}
  if (!j.device_code || !j.user_code) { toast('Could not start sign-in' + (j.error_description ? ' — ' + j.error_description : '')); return; }
  LS.set('oauth.pending', { device_code: j.device_code, user_code: j.user_code, interval: j.interval || 5, expires: Date.now() + (j.expires_in || 900) * 1000 });
  try { if (window.OneGit && OneGit.copy) OneGit.copy(j.user_code); } catch (e) {}
  clearTimeout(oauthTimer);
  showDeviceSheet();
  scheduleOauthPoll();
};
window.__oauthPoll = (ok, resp) => {
  oauthBusy = false;
  const p = oauthPending();
  if (!p) return;
  let j = {};
  try { j = JSON.parse(resp) || {}; } catch (e) {}
  if (ok && j.access_token) {
    LS.del('oauth.pending');
    clearTimeout(oauthTimer);
    closeSheet();
    if (oauthMakeToken) {
      oauthMakeToken = false;
      /* creating a token must NOT touch the current sign-in - just save it */
      saveMadeToken(j.access_token, oauthScopeOverride);
      toast('Gitly created a token for you');
      tokenCreatedSheet(j.access_token);
      return;
    }
    toast('Signed in with GitHub');
    completeLogin(j.access_token).catch(e => { toast('Sign-in failed: ' + e.message); });
    return;
  }
  const err = j.error || '';
  if (err === 'authorization_pending') { scheduleOauthPoll(); return; }
  if (err === 'slow_down') { p.interval = (p.interval || 5) + 5; LS.set('oauth.pending', p); scheduleOauthPoll(); return; }
  if (err === 'expired_token') { LS.del('oauth.pending'); clearTimeout(oauthTimer); toast('Sign-in code expired — start again'); return; }
  if (err === 'access_denied') { LS.del('oauth.pending'); clearTimeout(oauthTimer); toast('Sign-in was denied on GitHub'); return; }
  scheduleOauthPoll();
};
function oauthPollNow() {
  const p = oauthPending();
  if (!p) { clearTimeout(oauthTimer); return; }
  if (oauthBusy) return;
  if (!window.OneGit || !OneGit.oauthPoll) { toast('Not available in this build'); return; }
  oauthBusy = true;
  try { OneGit.oauthPoll(p.device_code); } catch (e) { oauthBusy = false; }
}
function scheduleOauthPoll() {
  clearTimeout(oauthTimer);
  const p = oauthPending();
  if (!p) return;
  oauthTimer = setTimeout(oauthPollNow, Math.max(3, p.interval || 5) * 1000);
}
function showDeviceSheet() {
  const p = oauthPending();
  if (!p) return;
  const mins = Math.max(1, Math.round((p.expires - Date.now()) / 60000));
  const forToken = oauthMakeToken;
  openSheet('<div class="sheethead"><b>' + (forToken ? 'Create a token in Gitly' : 'Sign in with GitHub') + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="card" style="text-align:center;padding:22px 16px">' +
    '<div class="lsub">Enter this code at</div>' +
    '<div class="ltitle" style="margin:2px 0 12px">github.com/login/device</div>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:4px">' + esc(p.user_code) + '</div>' +
    '<div class="lsub" style="margin-top:10px">Copied to your clipboard</div></div>' +
    '<button class="btn primary btnblock" data-act="ext" data-url="https://github.com/login/device" style="margin-top:4px">Open github.com/login/device</button>' +
    '<button class="btn ghost btnblock" id="oauthContinue" style="margin-top:8px">Continue — I approved on GitHub</button>' +
    '<div class="lsub" style="margin-top:12px;text-align:center">GitHub never redirects back — you approve there and the ' + (forToken ? 'token comes straight back here' : 'sign-in finishes') + '. The code expires in ' + mins + ' minutes; it completes automatically even if you close this.</div>');
  const oc = $('#oauthContinue');
  if (oc) oc.addEventListener('click', () => { oauthPollNow(); toast('Checking GitHub…'); });
}
function startDeviceLogin() {
  if (!window.OneGit || !OneGit.oauthStart) { toast('Not available in this build'); return; }
  const btn = $('#ghLoginBtn');
  if (btn) { btn.disabled = true; }
  try { OneGit.oauthStart(OAUTH_SCOPES); } catch (e) { if (btn) btn.disabled = false; }
}
function gitHubSignIn() {
  if (window.OneGit && OneGit.oauthStart) return startDeviceLogin();
  return startWebLogin();
}
$('#ghLoginBtn').addEventListener('click', gitHubSignIn);
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#loginBtn').click(); });
window.addEventListener('hashchange', route);
window.addEventListener('resize', fitBigTitle);

/* ================= profile README (special repo) ================= */
function specialRepoGo(login) {
  return LS.get('spr:' + login, false) ? '#/profile/' + login : '#/user/' + login;
}
function checkSpecialRepo(login) {
  api('/repos/' + login + '/' + login, { status: true }).then(r => {
    const has = !!(r && r.ok && r.data);
    if (LS.get('spr:' + login, false) !== has) {
      LS.set('spr:' + login, has);
      const card = view() && view().querySelector('.card.profile');
      if (card) card.dataset.go = has ? '#/profile/' + login : '#/user/' + login;
    }
  }).catch(() => {});
}

/* ================= github.com deep links ================= */
window.openGithubUrl = function (raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return false; }
  const host = (u.hostname || '').toLowerCase();
  const land = () => { try { toast('Opened in Gitly'); } catch (e) {} };
  if (host === 'gist.github.com') {
    const m = (u.pathname || '').match(/^\/(?:[^\/]+\/)?([0-9a-f]{6,})/i);
    if (m) { location.hash = '#/gist/' + m[1]; land(); return true; }
    return false;
  }
  if (host !== 'github.com' && host !== 'www.github.com' && host !== 'm.github.com') return false;
  const seg = (u.pathname || '').split('/').filter(Boolean);
  if (!seg.length) { location.hash = '#/home'; land(); return true; }
  const noScreen = { notifications: 1, settings: 1, login: 1, join: 1, orgs: 1, topics: 1, explore: 1, marketplace: 1, new: 1, trending: 1, collections: 1, events: 1, pricing: 1, security: 1, features: 1, enterprise: 1, about: 1, pulls: 1, dashboard: 1, apps: 1, sponsors: 1, mobile: 1, feed: 1, site: 1 };
  if (noScreen[String(seg[0]).toLowerCase()] && seg.length === 1) return false;
  if (seg.length === 1) { location.hash = '#/user/' + seg[0]; land(); return true; }
  const full = seg[0] + '/' + seg[1];
  const rest = seg.slice(2);
  if (!rest.length) { location.hash = '#/repo/' + full; land(); return true; }
  const k = String(rest[0]).toLowerCase();
  if (k === 'commit' && rest[1]) { location.hash = '#/commit/' + full + '/' + rest[1]; land(); return true; }
  if (k === 'commits') { location.hash = '#/repo/' + full + '/commits'; land(); return true; }
  if (k === 'releases' || k === 'tags') { location.hash = '#/repo/' + full + '/releases'; land(); return true; }
  if ((k === 'issues' || k === 'pull') && /^\d+$/.test(rest[1] || '')) { location.hash = '#/issue/' + full + '/' + rest[1]; land(); return true; }
  if (k === 'issues') { location.hash = '#/repo/' + full + '/issues'; land(); return true; }
  if (k === 'pulls') { location.hash = '#/issues'; land(); return true; }
  if (k === 'tree' || k === 'blob') {
    let parts = rest.slice(2);
    if (k === 'blob' && parts.length) parts = parts.slice(0, -1); // blob points at a file - open its folder
    const p = parts.join('/');
    location.hash = '#/repo/' + full + '/files' + (p ? '/' + p : '');
    land();
    return true;
  }
  location.hash = '#/repo/' + full; land(); return true;
};

/* ================= boot ================= */
applyTheme();
applyAutoAdjust();
applyFont();
saveTokenNative();
(async () => {
  /* a website sign-in lands back here with ?code=... — finish it before routing */
  const signedIn = await finishWebLogin().catch(() => false);
  if (!signedIn) route();
})();
if (TOKEN) syncRestore(true).then(ok => {
  if (!ok) return;
  if (location.hash !== '#/home' && location.hash !== '') return;
  /* refresh what is on screen in place - never redraw the page underneath the user */
  if (typeof LIVE_REFRESH === 'function') { try { LIVE_REFRESH(); return; } catch (e) { } }
  route();
}).catch(() => {});

/* ---------- background sync ----------
   Refresh the data the main screens show the moment the app opens (and again
   whenever it comes back to the foreground), so a screen shows current data
   instead of old data that then visibly refreshes under the user. */
let warming = false, lastWarm = 0;
async function warmCaches() {
  if (!TOKEN || warming) return;
  /* never hammer a slow link: at most once every couple of minutes */
  if (Date.now() - lastWarm < 300000) return;
  warming = true;
  try {
    const u = USER || await api('/user').catch(() => null);
    if (!u) { warming = false; return; }
    /* strictly one request at a time, so whatever the user is looking at keeps
       the connection to itself */
    const jobs = [
      () => refreshActivity(u.login),
      () => api('/user/repos?sort=updated&per_page=30&page=1'),
      () => api('/user/starred?per_page=30&page=1')
    ];
    for (const j of jobs) { try { await j(); } catch (e) { } }
  } catch (e) { }
  lastWarm = Date.now();
  warming = false;
}
if (TOKEN) setTimeout(warmCaches, 1800);
/* anything queued while GitHub was unreachable goes out as soon as it can */
if (TOKEN) setTimeout(() => { try { flushQueue(); } catch (e) { } }, 2500);
/* the strip clears itself when the hour turns over */
setInterval(() => { try { updateLimitBar(); } catch (e) { } }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { try { flushQueue(); } catch (e) { } } });
window.addEventListener('online', () => { try { flushQueue(); } catch (e) { } });
/* heal a drifted account list as soon as the app is up */
if (TOKEN) setTimeout(() => { try { reconcileAccounts(); } catch (e) { } }, 900);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && TOKEN) warmCaches();
});
window.addEventListener('focus', () => { if (TOKEN) warmCaches(); });

/* ================= v2.78: pull requests, actions, security, insights, deployments,
   pages, environments, interaction limits, branch protection, SSH/GPG keys,
   organizations and accessibility settings ================= */

/* Hand the numbers the app already has to the home screen widgets. They are
   stored on the device, so the widget shows them straight away and keeps them
   after the app is closed - no background fetch required. */
let NT_UNREAD = -1;
function widgetPush(withCalendar) {
  try {
    if (!window.OneGit || !OneGit.widgetSync) return;
    const p = { login: (USER && USER.login) ? USER.login : '' };
    try {
      const a = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(a)) p.accent = a.toUpperCase();
    } catch (e) {}
    const cc = LS.get('c.prod', null);
    if (cc && cc.contributionCalendar) {
      const days = [];
      cc.contributionCalendar.weeks.forEach(w => w.contributionDays.forEach(d => days.push(d)));
      const today = todayStr();
      let cur = 0, i = days.length - 1;
      while (i >= 0 && days[i].contributionCount === 0) i--;
      while (i >= 0 && days[i].contributionCount > 0) { cur++; i--; }
      const td = days.filter(d => d.date === today)[0];
      p.today = td ? td.contributionCount : 0;
      p.streak = cur;
      p.total = cc.contributionCalendar.totalContributions || 0;
    }
    /* the Productivity screen has just fetched the calendar the widgets draw: hand it
       over so they store it on the device and never need a request of their own */
    if (withCalendar && cc && cc.contributionCalendar) p.calendar = { contributionCalendar: cc.contributionCalendar };
    if (NT_UNREAD >= 0) p.unread = NT_UNREAD;
    if (!p.login && !cc && NT_UNREAD < 0) return;
    OneGit.widgetSync(JSON.stringify(p));
  } catch (e) {}
}
function applyA11y() {
  document.body.classList.toggle('reducemotion', !!LS.get('reduceMotion', false));
  document.body.classList.toggle('showunderline', !!LS.get('linkUnderline', false));
}

/* ---------- pull requests ---------- */
let PRS = { state: 'open' };
function prRow(p, full) {
  const merged = !!p.merged_at;
  return '<div class="lrow" data-go="#/issue/' + full + '/' + p.number + '">' +
    '<div class="istate' + (merged ? ' merged' : (p.state === 'open' ? '' : ' closed')) + '">' + (merged ? SVG.check : (p.state === 'open' ? SVG.dot : SVG.x)) + '</div>' +
    '<div class="lmain"><div class="ltitle">' + esc(p.title) + (p.draft ? ' <span class="chip">Draft</span>' : '') + (merged ? ' <span class="chip ok">Merged</span>' : '') + '</div>' +
    '<div class="lsub">#' + p.number + ' · ' + esc(p.user.login) + ' · ' + esc(p.head.ref) + ' → ' + esc(p.base.ref) + ' · ' + tAgo(p.updated_at) + ' · ' + (p.comments || 0) + ' comments</div></div></div>';
}
async function renderPulls(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  const canPush = await canPushRepo(o, n).catch(() => false);
  if (seq !== RSEQ) return;
  view().innerHTML = (canPush ? '<button class="btn ghost btnblock" id="newPrBtn" style="margin-bottom:12px">New pull request</button>' : '') +
    '<div class="seg sm" style="margin-bottom:12px"><button class="segb' + (PRS.state === 'open' ? ' on' : '') + '" data-prs="open">Open</button>' +
    '<button class="segb' + (PRS.state === 'closed' ? ' on' : '') + '" data-prs="closed">Closed</button>' +
    '<button class="segb' + (PRS.state === 'all' ? ' on' : '') + '" data-prs="all">All</button></div>' +
    '<div id="prList">' + spinner() + '</div>';
  const nb = $('#newPrBtn'); if (nb) nb.addEventListener('click', () => newPullSheet(o, n));
  $$('[data-prs]').forEach(b => b.addEventListener('click', () => { PRS.state = b.dataset.prs; renderPulls(o, n); }));
  let prs;
  try { prs = await api('/repos/' + full + '/pulls?state=' + PRS.state + '&sort=updated&direction=desc&per_page=30'); }
  catch (e) { if (seq === RSEQ) { const l = $('#prList'); if (l) l.innerHTML = errCard(e); } return; }
  if (seq !== RSEQ) return;
  let html = '';
  if (!prs.length) html = '<div class="card empty">No ' + (PRS.state === 'all' ? '' : PRS.state + ' ') + 'pull requests here.</div>';
  else {
    html = '<div class="card list">';
    prs.forEach(p => { html += prRow(p, full); });
    html += '</div>';
  }
  const pl = $('#prList'); if (pl) pl.innerHTML = html;
  liveList('#prList',
    () => api('/repos/' + full + '/pulls?state=' + PRS.state + '&sort=updated&direction=desc&per_page=30'),
    p => p.id, p => prRow(p, full), 0, 'pulls');
}
function newPullSheet(o, n) {
  const full = o + '/' + n;
  openSheet('<div class="sheethead"><b>New pull request</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div id="prForm">' + spinner(true) + '</div>');
  api('/repos/' + full).then(async r => {
    const branches = await api('/repos/' + full + '/branches?per_page=100').catch(() => []);
    const f = $('#prForm'); if (!f) return;
    f.innerHTML = '<label class="fldlabel">Base branch</label><select class="fld" id="prBase">' +
      branches.map(b => '<option value="' + esc(b.name) + '"' + (b.name === r.default_branch ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select>' +
      '<label class="fldlabel" style="margin-top:12px">Compare branch (your changes)</label><select class="fld" id="prHead">' +
      branches.map(b => '<option value="' + esc(b.name) + '"' + (b.name !== r.default_branch ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') + '</select>' +
      '<label class="fldlabel" style="margin-top:12px">Title</label><input class="fld" id="prTitle" autocomplete="off">' +
      '<label class="fldlabel" style="margin-top:12px">Description</label><textarea class="fld" id="prBody" rows="4"></textarea>' +
      '<button class="btn primary btnblock" id="prGo" style="margin-top:16px">Create pull request</button>';
    $('#prGo').addEventListener('click', async () => {
      const title = $('#prTitle').value.trim();
      if (!title) { toast('Add a title first'); return; }
      $('#prGo').disabled = true;
      try {
        const pr = await api('/repos/' + full + '/pulls', { method: 'POST', body: JSON.stringify({ title: title, body: $('#prBody').value, head: $('#prHead').value, base: $('#prBase').value }) });
        closeSheet(); toast('Pull request #' + pr.number + ' created');
        location.hash = '#/issue/' + full + '/' + pr.number;
      } catch (e) { toast('Failed: ' + e.message); $('#prGo').disabled = false; }
    });
  }).catch(e => { const f = $('#prForm'); if (f) f.innerHTML = errCard(e); });
}
function mergeSheet(o, n, num, pr) {
  const full = o + '/' + n;
  let method = 'merge';
  openSheet('<div class="sheethead"><b>Merge pull request #' + num + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">' + esc(pr.head.ref) + ' → ' + esc(pr.base.ref) +
    (pr.mergeable === false ? ' · GitHub reports this branch has conflicts that must be resolved first' : '') + '</div>' +
    '<div class="seg sm" style="margin-top:14px"><button class="segb on" data-mm="merge">Merge</button>' +
    '<button class="segb" data-mm="squash">Squash</button><button class="segb" data-mm="rebase">Rebase</button></div>' +
    '<div class="lsub" style="margin-top:10px">Pick how the commits land in ' + esc(pr.base.ref) + '.</div>' +
    '<button class="btn primary btnblock" id="mgGo" style="margin-top:16px">Merge now</button>');
  $$('[data-mm]').forEach(b => b.addEventListener('click', () => { method = b.dataset.mm; $$('[data-mm]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#mgGo').addEventListener('click', async () => {
    $('#mgGo').disabled = true;
    try {
      await api('/repos/' + full + '/pulls/' + num + '/merge', { method: 'PUT', body: JSON.stringify({ merge_method: method }) });
      closeSheet(); toast('Merged pull request #' + num); renderIssue(o, n, num);
    } catch (e) { toast('Failed: ' + e.message); $('#mgGo').disabled = false; }
  });
}

/* ---------- actions ---------- */
function runIcon(conclusion, status) {
  let cls = 'mute', svg = SVG.dot;
  if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'pending') { cls = 'run'; svg = SVG.dot; }
  else if (conclusion === 'success') { cls = 'ok'; svg = SVG.check; }
  else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') { cls = 'bad'; svg = SVG.x; }
  else if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') { cls = 'mute'; svg = SVG.x; }
  return '<div class="runstate ' + cls + '">' + svg + '</div>';
}
function runDur(r) {
  const end = r.updated_at ? new Date(r.updated_at) : null, st = new Date(r.run_started_at || r.created_at);
  if (!end || end <= st) return '';
  let s = Math.round((end - st) / 1000);
  return s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
}
async function renderActions(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = '<div class="actionrow" style="margin-bottom:12px"><button class="btn ghost" id="wfRun">Run a workflow</button></div><div id="runList">' + spinner() + '</div>';
  const wfr = $('#wfRun');
  if (wfr) wfr.addEventListener('click', () => dispatchSheet(o, n));
  let runs;
  try { runs = ((await api('/repos/' + full + '/actions/runs?per_page=30')) || {}).workflow_runs || []; }
  catch (e) { if (seq === RSEQ) view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  let html;
  if (!runs.length) html = '<div class="card empty">No workflow runs yet.<div class="lsub" style="margin-top:8px">Actions run automatically on push and other events once the repository has workflow files in .github/workflows.</div></div>';
  else {
    html = '<div class="card list">' + runs.map(r =>
      '<div class="lrow" data-go="#/actionrun/' + full + '/' + r.id + '">' + runIcon(r.conclusion, r.status) +
      '<div class="lmain"><div class="ltitle">' + esc(r.name || 'Workflow run') + '</div>' +
      '<div class="lsub">#' + r.run_number + ' · ' + esc(r.head_branch || '-') + ' · ' + esc(r.event) +
      (runDur(r) ? ' · ' + runDur(r) : '') + ' · ' + tAgo(r.created_at) + '</div></div></div>').join('') + '</div>';
  }
  const rl = $('#runList'); if (rl) rl.innerHTML = html;
}
async function renderRun(o, n, id) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  let run, jobs;
  try {
    run = await api('/repos/' + full + '/actions/runs/' + id);
    jobs = ((await api('/repos/' + full + '/actions/runs/' + id + '/jobs?per_page=30')) || {}).jobs || [];
  } catch (e) { if (seq === RSEQ) view().innerHTML = errCard(e); return; }
  if (seq !== RSEQ) return;
  const active = run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting';
  let html = '<div class="card"><div class="rcrow"><div class="rcname">' + esc(run.name || 'Workflow run') + '</div>' + runIcon(run.conclusion, run.status) + '</div>' +
    '<div class="rcmeta">run #' + run.run_number + ' · ' + esc(run.event) + ' · branch ' + esc(run.head_branch || '-') +
    ' · commit ' + (run.head_sha ? run.head_sha.slice(0, 7) : '') + '</div>' +
    '<div class="lsub" style="margin-top:6px">Started ' + tAgo(run.run_started_at || run.created_at) + ' by ' + esc(run.actor ? run.actor.login : 'unknown') +
    ' · ' + esc(active ? run.status : (run.conclusion || run.status)) + (runDur(run) ? ' · took ' + runDur(run) : '') + '</div>' +
    '<div class="actionrow" style="margin-top:14px">' +
    (active ? '<button class="btn danger" id="runCancel">Cancel run</button>' : '<button class="btn ghost" id="runRerun">Re-run</button>') +
    '</div></div>';
  html += '<h2 class="sect">Jobs</h2>';
  if (!jobs.length) html += '<div class="card empty">No job details for this run.</div>';
  else {
    html += '<div class="card list">' + jobs.map(j =>
      '<div class="lrow" style="flex-wrap:wrap">' + runIcon(j.conclusion, j.status) +
      '<div class="lmain" style="flex:1"><div class="ltitle">' + esc(j.name) + '</div>' +
      '<div class="lsub">' + esc(j.status) + (j.conclusion ? ' · ' + esc(j.conclusion) : '') + (j.runner_name ? ' · ' + esc(j.runner_name) : '') + '</div>' +
      ((j.steps || []).length ? '<div class="steps">' + j.steps.map(s =>
        '<div class="step">' + (s.conclusion === 'success' ? '<span style="color:#12B76A">✓</span>' : (s.conclusion === 'failure' ? '<span style="color:#EF4444">✗</span>' : '<span>•</span>')) + esc(s.name) + '</div>').join('') + '</div>' : '') +
      '</div></div>').join('') + '</div>';
  }
  view().innerHTML = html;
  const cc = $('#runCancel');
  if (cc) cc.addEventListener('click', async () => {
    cc.disabled = true;
    try { await api('/repos/' + full + '/actions/runs/' + id + '/cancel', { method: 'POST' }); toast('Cancelling run…'); renderRun(o, n, id); }
    catch (e) { toast('Failed: ' + e.message); cc.disabled = false; }
  });
  const rr = $('#runRerun');
  if (rr) rr.addEventListener('click', async () => {
    rr.disabled = true;
    try { await api('/repos/' + full + '/actions/runs/' + id + '/rerun', { method: 'POST' }); toast('Re-running…'); setTimeout(() => renderRun(o, n, id), 1500); }
    catch (e) { toast('Failed: ' + e.message); rr.disabled = false; }
  });
}

/* ---------- security and quality ---------- */
/* after a toggle, the screen already knows the new answer: save it as the probe's
   reply instead of asking GitHub again on the next visit */
function saveProbe(path, on) {
  try { LS.set(cacheKey(path, true), { d: { status: on ? 204 : 404, ok: !!on, data: null }, at: Date.now(), etag: '' }); } catch (e) { }
}
async function renderSecurity(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const canAdmin = await canPushRepo(o, n).catch(() => false);
  const [dep, depFix, secret, alerts] = await Promise.all([
    api('/repos/' + full + '/vulnerability-alerts', { status: true }).catch(() => null),
    api('/repos/' + full + '/automated-security-fixes', { status: true }).catch(() => null),
    api('/repos/' + full + '/secret-scanning').catch(() => null),
    api('/repos/' + full + '/dependabot/alerts?per_page=20&state=open').catch(() => null)
  ]);
  if (seq !== RSEQ) return;
  const depOn = !!(dep && dep.status === 204);
  const fixOn = !!(depFix && depFix.status === 204);
  let html = '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Dependabot alerts</div>' +
    '<div class="setrow"><div class="lmain"><div class="ltitle">Alerts for vulnerable dependencies</div>' +
    '<div class="lsub">Get notified when one of your dependencies has a known vulnerability</div></div>' +
    '<button class="switch' + (depOn ? ' on' : '') + '" id="secDepSw" aria-label="dependabot alerts"></button></div>' +
    (depOn && Array.isArray(alerts) && alerts.length ?
      '<div style="margin-top:12px">' + alerts.map(a =>
        '<div class="lrow" style="padding:10px 0" data-act="ext" data-url="' + esc(a.html_url) + '">' +
        '<div class="lmain"><div class="ltitle">' + esc((a.security_vulnerability && a.security_vulnerability.package && a.security_vulnerability.package.name) || ('Alert #' + a.number)) + '</div>' +
        '<div class="lsub">' + esc((a.security_vulnerability && a.security_vulnerability.severity) || 'unknown') + ' severity · ' + esc(a.state) + '</div></div></div>').join('') + '</div>' : '') +
    '</div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Dependabot version updates</div>' +
    '<div class="setrow"><div class="lmain"><div class="ltitle">Automated security fixes</div>' +
    '<div class="lsub">Let Dependabot open pull requests that update vulnerable dependencies</div></div>' +
    '<button class="switch' + (fixOn ? ' on' : '') + '" id="secFixSw" aria-label="automated fixes"></button></div></div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Secret scanning</div>' +
    '<div class="setrow"><div class="lmain"><div class="ltitle">Scan for committed secrets</div>' +
    '<div class="lsub">Get notified when tokens, keys and other secrets are pushed to this repository' +
    (secret ? ' · currently ' + esc(secret.state) : '') + '</div></div>' +
    '<button class="switch' + (secret && secret.state === 'enabled' ? ' on' : '') + '" id="secSecretSw" aria-label="secret scanning"></button></div></div>';
  html += '<div class="card"><div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Security policy</div>' +
    '<div class="lrow" data-act="openfile" data-repo="' + esc(full) + '" data-file="SECURITY.md" style="padding:10px 0">' +
    '<div class="lmain"><div class="ltitle">View SECURITY.md</div><div class="lsub">How users should report vulnerabilities for this repository</div></div></div>' +
    '<div class="lrow" data-act="ext" data-url="https://github.com/' + esc(full) + '/security" style="padding:10px 0">' +
    '<div class="lmain"><div class="ltitle">Security overview on GitHub</div><div class="lsub">Code scanning, advisories and full alert history</div></div></div></div>';
  view().innerHTML = html;
  if (!canAdmin) view().insertAdjacentHTML('afterbegin', '<div class="card empty">Read-only view — changing security settings requires admin access to this repository.</div>');
  const dsw = $('#secDepSw');
  if (dsw) dsw.addEventListener('click', async () => {
    const on = !dsw.classList.contains('on');
    try { await api('/repos/' + full + '/vulnerability-alerts', { method: on ? 'PUT' : 'DELETE' }); saveProbe('/repos/' + full + '/vulnerability-alerts', on); dsw.classList.toggle('on', on); toast(on ? 'Dependabot alerts enabled' : 'Dependabot alerts disabled'); if (on) setTimeout(() => renderSecurity(o, n), 800); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const fsw = $('#secFixSw');
  if (fsw) fsw.addEventListener('click', async () => {
    const on = !fsw.classList.contains('on');
    try { await api('/repos/' + full + '/automated-security-fixes', { method: on ? 'PUT' : 'DELETE' }); saveProbe('/repos/' + full + '/automated-security-fixes', on); fsw.classList.toggle('on', on); toast(on ? 'Automated security fixes enabled' : 'Automated security fixes disabled'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const ssw = $('#secSecretSw');
  if (ssw) ssw.addEventListener('click', async () => {
    const on = !ssw.classList.contains('on');
    try { await api('/repos/' + full + '/secret-scanning', { method: 'PATCH', body: JSON.stringify({ state: on ? 'enabled' : 'disabled' }) }); ssw.classList.toggle('on', on); toast(on ? 'Secret scanning enabled' : 'Secret scanning disabled'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
}

/* ---------- insights (pulse) ---------- */
async function renderInsights(o, n) {
  const seq = ++RSEQ;
  const full = o + '/' + n;
  view().innerHTML = spinner();
  const [contribs, activity, events] = await Promise.all([
    api('/repos/' + full + '/stats/contributors').catch(() => null),
    api('/repos/' + full + '/stats/commit_activity').catch(() => null),
    api('/repos/' + full + '/events?per_page=15').catch(() => [])
  ]);
  if (seq !== RSEQ) return;
  let html = '';
  if (Array.isArray(contribs) && contribs.length) {
    const sorted = contribs.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
    const max = sorted[0].total || 1;
    html += '<h2 class="sect">Top contributors</h2><div class="card list">';
    sorted.slice(0, 12).forEach(c => {
      html += '<div class="lrow" data-go="#/user/' + esc(c.author ? c.author.login : '') + '">' +
        (c.author ? '<img class="cav" src="' + esc(c.author.avatar_url) + '" alt="">' : SVG.user) +
        '<div class="lmain"><div class="ltitle">' + esc(c.author ? c.author.login : 'unknown') + '</div>' +
        '<div class="cbar"><span style="width:' + Math.round(100 * (c.total || 0) / max) + '%"></span></div></div>' +
        '<div class="lsub" style="align-self:center">' + nf(c.total || 0) + ' commits</div></div>';
    });
    html += '</div>';
  } else if (contribs && !Array.isArray(contribs)) {
    html += '<div class="card empty">GitHub is still calculating contributor statistics — check back in a minute.</div>';
  } else {
    html += '<div class="card empty">No contributor statistics yet.</div>';
  }
  if (Array.isArray(activity) && activity.length) {
    const maxW = Math.max.apply(null, activity.map(w => w.total || 0)) || 1;
    html += '<h2 class="sect">Commits per week (last year)</h2><div class="card"><div class="wkchart">' +
      activity.map(w => '<div class="wkbar" style="height:' + Math.max(3, Math.round(64 * (w.total || 0) / maxW)) + 'px" title="' + (w.total || 0) + ' commits"></div>').join('') +
      '</div><div class="lsub" style="margin-top:10px">' + nf(activity.reduce((s, w) => s + (w.total || 0), 0)) + ' commits in the last 52 weeks</div></div>';
  }
  if (Array.isArray(events) && events.length) {
    html += '<h2 class="sect">Recent activity</h2><div class="card list">' + events.map(ev => eventRow(ev)).join('') + '</div>';
  }
  view().innerHTML = html || '<div class="card empty">No insights available for this repository.</div>';
}

/* ---------- deployments sheet ---------- */
async function deploymentsSheet(full) {
  openSheet('<div class="sheethead"><b>Deployments</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + spinner(true));
  const head = '<div class="sheethead"><b>Deployments</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>';
  try {
    const deps = await api('/repos/' + full + '/deployments?per_page=15');
    if (!deps.length) { const c = $('.sheetcard'); if (c) c.innerHTML = head + '<div class="lsub">No deployments yet. Deployments appear when workflows or services publish environments.</div>'; return; }
    /* a status is one request each, so only the newest 5 are looked up; the rest list without one */
    const statii = await Promise.all(deps.map((d, i) => i < 5 ? api('/repos/' + full + '/deployments/' + d.id + '/statuses?per_page=1').catch(() => []) : Promise.resolve([])));
    let html = head;
    deps.forEach((d, i) => {
      const st = statii[i] && statii[i][0] ? statii[i][0].state : '';
      const ok = st === 'success', bad = st === 'failure' || st === 'error';
      html += '<div class="lrow" style="padding:10px 0"' + (d.environment_url ? ' data-act="ext" data-url="' + esc(d.environment_url) + '"' : '') + '>' +
        '<div class="lmain"><div class="ltitle">' + esc(d.environment || 'deployment') + ' · ' + (d.sha ? d.sha.slice(0, 7) : '') + '</div>' +
        '<div class="lsub">' + tAgo(d.created_at) + (d.ref ? ' · ref ' + esc(d.ref) : '') + '</div></div>' +
        (st ? '<span class="chip ' + (ok ? 'ok' : (bad ? 'closed' : '')) + '">' + esc(st) + '</span>' : '') + '</div>';
    });
    const c = $('.sheetcard'); if (c) c.innerHTML = html;
  } catch (e) { const c = $('.sheetcard'); if (c) c.innerHTML = head + errCard(e); }
}

/* ---------- repo settings: pages / environments / interaction limits / protection ---------- */
async function loadPages(o, n) {
  const el = $('#pagesCard'); if (!el) return;
  const full = o + '/' + n;
  let p = null;
  try { p = await api('/repos/' + full + '/pages'); } catch (e) {}
  if (!p) {
    el.innerHTML = '<div class="ltitle" style="padding:2px 4px 4px;font-size:15px">GitHub Pages</div>' +
      '<div class="lsub" style="margin-bottom:10px">Publish a website straight from this repository.</div>' +
      '<label class="fldlabel">Branch</label><select class="fld" id="pgBranch"></select>' +
      '<label class="fldlabel" style="margin-top:12px">Folder</label><select class="fld" id="pgFolder"><option value="/">/ (root)</option><option value="/docs">/docs</option></select>' +
      '<button class="btn primary btnblock" id="pgPublish" style="margin-top:16px">Publish site</button>';
    const branches = await api('/repos/' + full + '/branches?per_page=100').catch(() => []);
    const sel = $('#pgBranch');
    if (sel) sel.innerHTML = branches.map(b => '<option value="' + esc(b.name) + '">' + esc(b.name) + '</option>').join('') || '<option value="main">main</option>';
    const pb = $('#pgPublish');
    if (pb) pb.addEventListener('click', async () => {
      pb.disabled = true;
      try {
        await api('/repos/' + full + '/pages', { method: 'POST', body: JSON.stringify({ source: { branch: $('#pgBranch').value, path: $('#pgFolder').value } }) });
        toast('Site published'); loadPages(o, n);
      } catch (e) { toast('Failed: ' + e.message); pb.disabled = false; }
    });
    return;
  }
  el.innerHTML = '<div class="ltitle" style="padding:2px 4px 4px;font-size:15px">GitHub Pages</div>' +
    '<div class="lrow" data-act="ext" data-url="' + esc(p.html_url) + '" style="padding:10px 0"><div class="lmain">' +
    '<div class="ltitle">' + esc(p.html_url) + '</div><div class="lsub">' + esc(p.status || '') + ' · tap to visit site</div></div></div>' +
    '<label class="fldlabel">Build from branch</label><select class="fld" id="pgBranch"></select>' +
    '<label class="fldlabel" style="margin-top:12px">Folder</label><select class="fld" id="pgFolder"><option value="/">/ (root)</option><option value="/docs">/docs</option></select>' +
    '<button class="btn ghost btnblock" id="pgSave" style="margin-top:14px">Save source</button>' +
    '<label class="fldlabel" style="margin-top:16px">Custom domain</label><input class="fld" id="pgDomain" value="' + esc(p.cname || '') + '" placeholder="example.com" autocomplete="off">' +
    '<button class="btn ghost btnblock" id="pgDomainSave" style="margin-top:14px">Save domain</button>' +
    '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Enforce HTTPS</div><div class="lsub">Encrypts traffic to your Pages site</div></div>' +
    '<button class="switch' + (p.https_enforced ? ' on' : '') + '" id="pgHttpsSw" aria-label="enforce https"></button></div>' +
    '<button class="btn danger btnblock" id="pgUnpublish" style="margin-top:16px">Unpublish site</button>';
  const branches = await api('/repos/' + full + '/branches?per_page=100').catch(() => []);
  const sel = $('#pgBranch');
  if (sel) {
    sel.innerHTML = branches.map(b => '<option value="' + esc(b.name) + '"' + (p.source && b.name === p.source.branch ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
    if (sel.options.length && sel.selectedIndex === -1 && p.source) { /* keep first */ }
    const fld = $('#pgFolder'); if (fld && p.source && p.source.path) fld.value = p.source.path;
  }
  const sv = $('#pgSave');
  if (sv) sv.addEventListener('click', async () => {
    try { await api('/repos/' + full + '/pages', { method: 'PUT', body: JSON.stringify({ source: { branch: $('#pgBranch').value, path: $('#pgFolder').value } }) }); toast('Pages source saved'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const ds = $('#pgDomainSave');
  if (ds) ds.addEventListener('click', async () => {
    const v = $('#pgDomain').value.trim();
    try { await api('/repos/' + full + '/pages', { method: 'PUT', body: JSON.stringify(v ? { cname: v } : { cname: null }) }); toast('Domain saved'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const hs = $('#pgHttpsSw');
  if (hs) hs.addEventListener('click', async () => {
    const on = !hs.classList.contains('on');
    try { await api('/repos/' + full + '/pages', { method: 'PUT', body: JSON.stringify({ https_enforced: on }) }); hs.classList.toggle('on', on); toast(on ? 'HTTPS enforced' : 'HTTPS not enforced'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  const up = $('#pgUnpublish');
  if (up) up.addEventListener('click', async () => {
    if (!window.confirm('Unpublish the Pages site?')) return;
    try { await api('/repos/' + full + '/pages', { method: 'DELETE' }); toast('Site unpublished'); loadPages(o, n); }
    catch (e) { toast('Failed: ' + e.message); }
  });
}
async function loadEnvs(o, n) {
  const el = $('#rsEnvList'); if (!el) return;
  const full = o + '/' + n;
  try {
    const res = await api('/repos/' + full + '/environments?per_page=30');
    const envs = (res && res.environments) || [];
    el.innerHTML = envs.length ? envs.map(e =>
      '<div class="lrow" style="padding:10px 0"><div class="lmain"><div class="ltitle">' + esc(e.name) + '</div>' +
      '<div class="lsub">' + ((e.protection_rules || []).length ? (e.protection_rules.length + ' protection rule' + (e.protection_rules.length > 1 ? 's' : '')) : 'no protection rules') + '</div></div>' +
      '<button class="iconbtn" data-rmenv="' + esc(e.name) + '" aria-label="delete environment">' + SVG.x + '</button></div>').join('') :
      '<div class="lsub" style="padding:10px 0">No environments yet.</div>';
    el.querySelectorAll('[data-rmenv]').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm('Delete environment ' + b.dataset.rmenv + '?')) return;
      try { await api('/repos/' + full + '/environments/' + encodeURIComponent(b.dataset.rmenv), { method: 'DELETE' }); toast('Environment deleted'); loadEnvs(o, n); }
      catch (e) { toast('Failed: ' + e.message); }
    }));
  } catch (e) { el.innerHTML = '<div class="lsub" style="padding:10px 0">Could not load environments: ' + esc(e.message) + '</div>'; }
}
async function loadIL(o, n) {
  const el = $('#ilCard'); if (!el) return;
  const full = o + '/' + n;
  const r = await api('/repos/' + full + '/interaction-limits', { status: true }).catch(() => null);
  const cur = (r && r.status === 200 && r.data) ? r.data : null;
  const opts = [['', 'No limit — anyone can interact'], ['existing_users', 'Existing users only'], ['contributors_only', 'Prior contributors only'], ['collaborators_only', 'Collaborators only']];
  const exps = [['one_day', '1 day'], ['three_days', '3 days'], ['one_week', '1 week'], ['one_month', '1 month'], ['six_months', '6 months']];
  el.innerHTML = '<div class="ltitle" style="padding:2px 4px 4px;font-size:15px">Interaction limits</div>' +
    '<div class="lsub" style="margin-bottom:10px">Temporarily restrict which users can comment, open issues or create pull requests here.</div>' +
    '<label class="fldlabel">Limit</label><select class="fld" id="ilLimit">' +
    opts.map(x => '<option value="' + x[0] + '"' + (cur && cur.limit === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
    '<label class="fldlabel" style="margin-top:12px">Expires after</label><select class="fld" id="ilExpiry">' +
    exps.map(x => '<option value="' + x[0] + '"' + (cur && cur.expiry === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
    '<button class="btn primary btnblock" id="ilSave" style="margin-top:16px">Apply limit</button>' +
    '<button class="btn danger btnblock" id="ilRemove" style="margin-top:8px">Remove limit</button>';
  $('#ilSave').addEventListener('click', async () => {
    const v = $('#ilLimit').value;
    if (!v) { toast('Pick a limit type first'); return; }
    try { await api('/repos/' + full + '/interaction-limits', { method: 'PUT', body: JSON.stringify({ limit: v, expiry: $('#ilExpiry').value }) }); toast('Interaction limit applied'); }
    catch (e) { toast('Failed: ' + e.message); }
  });
  $('#ilRemove').addEventListener('click', async () => {
    try { await api('/repos/' + full + '/interaction-limits', { method: 'DELETE' }); toast('Interaction limit removed'); loadIL(o, n); }
    catch (e) { toast('Failed: ' + e.message); }
  });
}
function protectionSheet(o, n, branch) {
  const full = o + '/' + n;
  openSheet('<div class="sheethead"><b>Protect ' + esc(branch) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + spinner(true));
  api('/repos/' + full + '/branches/' + encodeURIComponent(branch) + '/protection', { status: true }).then(r => {
    const p = (r && r.status === 200 && r.data) ? r.data : null;
    const rr = p && p.required_pull_request_reviews;
    const sc = p && p.required_status_checks;
    const cnt = (rr && typeof rr.required_approving_review_count === 'number') ? rr.required_approving_review_count : 1;
    const c = $('.sheetcard'); if (!c) return;
    c.innerHTML = '<div class="sheethead"><b>Protect ' + esc(branch) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
      '<div class="setrow"><div class="lmain"><div class="ltitle">Require pull request reviews</div><div class="lsub">Before merging, at least the number of approvals below</div></div>' +
      '<button class="switch' + (rr ? ' on' : '') + '" id="bpRev" aria-label="require reviews"></button></div>' +
      '<label class="fldlabel" style="margin-top:12px">Required approvals</label><input class="fld" id="bpCnt" type="number" min="0" max="6" value="' + cnt + '">' +
      '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Require status checks</div><div class="lsub">Block merging while required checks are failing</div></div>' +
      '<button class="switch' + (sc ? ' on' : '') + '" id="bpSc" aria-label="require checks"></button></div>' +
      '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Include administrators</div><div class="lsub">Admins must follow the same rules</div></div>' +
      '<button class="switch' + (p && p.enforce_admins && p.enforce_admins.enabled ? ' on' : '') + '" id="bpAdm" aria-label="enforce admins"></button></div>' +
      '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Allow force pushes</div><div class="lsub">Permit history rewrites on this branch</div></div>' +
      '<button class="switch' + (p && p.allow_force_pushes && p.allow_force_pushes.enabled ? ' on' : '') + '" id="bpFp" aria-label="force pushes"></button></div>' +
      '<div class="setrow" style="margin-top:14px"><div class="lmain"><div class="ltitle">Allow deletions</div><div class="lsub">Let this branch be deleted</div></div>' +
      '<button class="switch' + (p && p.allow_deletions && p.allow_deletions.enabled ? ' on' : '') + '" id="bpDel" aria-label="allow deletions"></button></div>' +
      '<button class="btn primary btnblock" id="bpSave" style="margin-top:16px">Save protection</button>' +
      '<button class="btn danger btnblock" id="bpRemove" style="margin-top:8px">Remove protection</button>';
    const gv = k => { const s = $('#' + k); return s && s.classList.contains('on'); };
    $('#bpSave').addEventListener('click', async () => {
      const body = {
        required_status_checks: gv('bpSc') ? { strict: false, contexts: [] } : null,
        enforce_admins: gv('bpAdm') ? true : false,
        required_pull_request_reviews: gv('bpRev') ? { dismiss_stale_reviews: false, require_code_owner_reviews: false, required_approving_review_count: Math.max(0, Math.min(6, parseInt($('#bpCnt').value || '1', 10) || 1)) } : null,
        restrictions: null,
        allow_force_pushes: gv('bpFp') ? true : false,
        allow_deletions: gv('bpDel') ? true : false
      };
      try { await api('/repos/' + full + '/branches/' + encodeURIComponent(branch) + '/protection', { method: 'PUT', body: JSON.stringify(body) }); toast('Protection saved for ' + branch); closeSheet(); }
      catch (e) { toast('Failed: ' + e.message); }
    });
    $('#bpRemove').addEventListener('click', async () => {
      if (!window.confirm('Remove branch protection from ' + branch + '?')) return;
      try { await api('/repos/' + full + '/branches/' + encodeURIComponent(branch) + '/protection', { method: 'DELETE' }); toast('Protection removed'); closeSheet(); }
      catch (e) { toast('Failed: ' + e.message); }
    });
  }).catch(e => { const c = $('.sheetcard'); if (c) c.innerHTML = '<div class="sheethead"><b>Protect ' + esc(branch) + '</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' + errCard(e); });
}
function transferSheet(o, n) {
  openSheet('<div class="sheethead"><b>Transfer repository</b><button class="iconbtn" data-act="closesheet">' + SVG.x + '</button></div>' +
    '<div class="lsub">Moves this repository to another user or organization where you can create repositories.</div>' +
    '<label class="fldlabel" style="margin-top:12px">New owner</label><input class="fld" id="tfOwner" placeholder="username or organization" autocomplete="off" spellcheck="false">' +
    '<button class="btn danger btnblock" id="tfGo" style="margin-top:16px">Transfer ' + esc(o + '/' + n) + '</button>');
  $('#tfGo').addEventListener('click', async () => {
    const own = $('#tfOwner').value.trim();
    if (!own) { toast('Enter the new owner'); return; }
    if (!window.confirm('Transfer ' + o + '/' + n + ' to ' + own + '?')) return;
    $('#tfGo').disabled = true;
    try {
      const r = await api('/repos/' + o + '/' + n + '/transfer', { method: 'POST', body: JSON.stringify({ new_owner: own }) });
      closeSheet(); toast('Transferred to ' + own);
      location.hash = '#/repo/' + own + '/' + ((r && r.name) ? r.name : n);
    } catch (e) { toast('Failed: ' + e.message); $('#tfGo').disabled = false; }
  });
}

/* ---------- account: SSH keys, GPG keys, organizations ---------- */
/* ---------- watched repositories (notification sources, managed in-app) ---------- */
