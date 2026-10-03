'use strict';
// NEXA Daily v3 — Node 18+ | Zero dependências externas
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = path.join(process.env.VERCEL ? '/tmp' : __dirname, 'data.json');
const PUB = __dirname;
const COOKIE = 'nexa_sid';
const TTL = 8 * 3600e3;
const SECURE = process.env.HTTPS === '1' ? '; Secure' : '';
const MAX_TASKS = 500;
const MAX_TAGS = 15;
const MAX_STEPS = 50;

// ── DB ──────────────────────────────────────────────────────────────────────
let db = { users: [], tasks: [], logs: [], tags: [] };
try {
  if (process.env.VERCEL && !fs.existsSync(DB_FILE) && fs.existsSync(path.join(__dirname, 'data.json'))) {
    try { fs.copyFileSync(path.join(__dirname, 'data.json'), DB_FILE); } catch {}
  }
  db = { users: [], tasks: [], logs: [], tags: [], ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {}

let _saving = false, _dirty = false;
const save = () => {
  if (_saving) { _dirty = true; return; }
  _saving = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (!err) fs.rename(tmp, DB_FILE, () => {});
    _saving = false;
    if (_dirty) { _dirty = false; save(); }
  });
};

// ── CRYPTO ──────────────────────────────────────────────────────────────────
const rid  = () => crypto.randomBytes(8).toString('hex');
const sha  = s  => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (p, salt) => crypto.scryptSync(p, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
const same = (a, b) => {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};
const DUMMY = { salt: 'x'.repeat(16), hash: scrypt('dummy', 'x'.repeat(16)) };
const sessions = new Map(); // sha(token) → { uid, exp, sv }

// ── LOGGING ─────────────────────────────────────────────────────────────────
const log = (ev, who, ip) => {
  db.logs.unshift({ t: Date.now(), ev, who: who || '', ip: ip || '' });
  db.logs = db.logs.slice(0, 500);
  save();
};

// ── SETUP ADMIN ─────────────────────────────────────────────────────────────
const BOOTSTRAP_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'yagopinto').toLowerCase();
const BOOTSTRAP_ADMIN_SALT = 'nexa-admin-v4';
const BOOTSTRAP_ADMIN_HASH = '2ee00491708ea4bc63329a45f4bed9947d56c6eb91e2b8821d00585aa08817aebb9ec3dd75cb3cb7\n6ff03b9f48a314ce603e8b724cc411caf85b9038a39dcaf7';
const adminSalt = process.env.ADMIN_PASSWORD ? rid() : BOOTSTRAP_ADMIN_SALT;
const adminHash = process.env.ADMIN_PASSWORD ? scrypt(process.env.ADMIN_PASSWORD, adminSalt) : BOOTSTRAP_ADMIN_HASH.replace(/\n/g, '');
if (!db.users.some(u => u.role === 'admin')) {
  db.users.push({
    id: rid(), name: 'Admin', email: BOOTSTRAP_ADMIN_EMAIL, role: 'admin', status: 'approved',
    salt: adminSalt, hash: adminHash, created: Date.now(), last: null,
    sv: 0, xp: 0, streak: 0, streakLast: null, focusMinutes: 0,
    preferences: { theme: 'dark', defaultView: 'list', notifications: true }
  });
  save();
}
if (!db.users.some(u => u.email === BOOTSTRAP_ADMIN_EMAIL)) {
  db.users.push({
    id: rid(), name: 'Admin', email: BOOTSTRAP_ADMIN_EMAIL, role: 'admin', status: 'approved',
    salt: adminSalt, hash: adminHash, created: Date.now(), last: null,
    sv: 0, xp: 0, streak: 0, streakLast: null, focusMinutes: 0,
    preferences: { theme: 'dark', defaultView: 'list', notifications: true }
  });
  save();
}

// ── RATE LIMIT ──────────────────────────────────────────────────────────────
const _hits = new Map(), _fails = new Map();
const limited = (key, max, win) => {
  const n = Date.now(), h = _hits.get(key);
  if (!h || h.r < n) { _hits.set(key, { c: 1, r: n + win }); return false; }
  return ++h.c > max;
};
const locked = k => (_fails.get(k)?.until || 0) > Date.now();
const fail   = k => {
  const f = _fails.get(k) || { n: 0, until: 0 };
  if (++f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  _fails.set(k, f);
};

// ── HEADERS ─────────────────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

const SEC_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store'
};

// ── HELPERS ─────────────────────────────────────────────────────────────────
const send = (res, code, obj, extra = {}) => {
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
};

const sendFile = (res, filePath, ct) => {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end();
  }
};

const body = req => new Promise(r => {
  let s = '', big = false;
  req.on('data', c => { s += c; if (s.length > 32768) { big = true; req.destroy(); } });
  req.on('end', () => { try { r(big ? {} : JSON.parse(s || '{}')); } catch { r({}); } });
});

const getCookie = req =>
  (req.headers.cookie || '').split(';').reduce((acc, p) => {
    const [k, ...v] = p.trim().split('=');
    acc[k] = v.join('='); return acc;
  }, {})[COOKIE];

const auth = req => {
  const t = getCookie(req); if (!t) return null;
  const s = sessions.get(sha(t)); if (!s || s.exp < Date.now()) return null;
  const u = db.users.find(x => x.id === s.uid);
  return (u && u.status === 'approved' && u.sv === s.sv) ? u : null;
};

const pubUser = u => ({
  id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
  created: u.created, last: u.last,
  xp: u.xp || 0, streak: u.streak || 0, streakLast: u.streakLast || null,
  focusMinutes: u.focusMinutes || 0,
  preferences: u.preferences || { theme: 'dark', defaultView: 'list', notifications: true }
});

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

const killSessions = uid => { for (const [k, s] of sessions) if (s.uid === uid) sessions.delete(k); };

// ── XP & GAMIFICATION ───────────────────────────────────────────────────────
const XP_MAP = { low: 10, normal: 20, high: 40, urgent: 65, step: 8 };

const awardXP = (u, pts) => {
  u.xp = Math.max(0, (u.xp || 0) + pts);
  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (pts > 0) {
    if (u.streakLast === yest)      { u.streak = (u.streak || 0) + 1; u.streakLast = today; }
    else if (u.streakLast !== today) { u.streak = 1; u.streakLast = today; }
  }
  save();
};

// ── VALIDATION ──────────────────────────────────────────────────────────────
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES   = ['todo', 'doing', 'review', 'done'];

const normalizeSteps = list => !Array.isArray(list) ? [] :
  list.slice(0, MAX_STEPS).map(s => ({
    id: String(s.id || rid()),
    text: clean(s.text || s.title || '', 200),
    done: Boolean(s.done),
    created: s.created || Date.now()
  })).filter(s => s.text);

const normalizeTags = list => !Array.isArray(list) ? [] :
  [...new Set(list.slice(0, 8).map(t => clean(String(t), 30).toLowerCase()).filter(Boolean))];

const normalizeLinks = list => !Array.isArray(list) ? [] :
  list.slice(0, 5).map(l => ({
    url: clean(l.url || '', 500).replace(/[^https?:\/\/\w\-.@#%?=&+:]/gi, ''),
    label: clean(l.label || '', 60)
  })).filter(l => /^https?:\/\//.test(l.url));

// ── STATIC FILES ─────────────────────────────────────────────────────────────
const STATIC = {
  '/':        ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css',    'text/css'],
  '/app.js':  ['app.js',     'text/javascript'],
};

// ── ROUTER ──────────────────────────────────────────────────────────────────
const app = async (req, res) => {
  const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  const p   = url.pathname;

  try {
    // ── favicon ──
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── static ──
    if (req.method === 'GET' && STATIC[p]) {
      return sendFile(res, path.join(PUB, STATIC[p][0]), STATIC[p][1]);
    }

    // ── api only ──
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Não encontrado' });

    // ── rate limit global ──
    if (limited('ip:' + ip, 200, 60e3)) return send(res, 429, { error: 'Muitas requisições. Aguarde um momento.' });

    // ── cors / content-type check ──
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return send(res, 403, { error: 'Origem não permitida' });
      if (!/^application\/json/i.test(req.headers['content-type'] || ''))
        return send(res, 415, { error: 'Content-Type deve ser application/json' });
    }

    const b = req.method === 'POST' ? await body(req) : {};

    // ══════════════════════════════════════════════════════
    // PUBLIC: /api/request  /api/login
    // ══════════════════════════════════════════════════════

    if (p === '/api/request' && req.method === 'POST') {
      if (limited('req:' + ip, 3, 3600e3)) return send(res, 429, { error: 'Muitas solicitações. Tente mais tarde.' });
      const name  = clean(b.name, 60);
      const email = clean(b.email, 120).toLowerCase();
      const pw    = String(b.password || '');
      if (name.length < 2)                                        return send(res, 400, { error: 'Nome muito curto.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))             return send(res, 400, { error: 'E-mail inválido.' });
      if (pw.length < 12 || pw.length > 128 ||
          !/[a-zA-Z]/.test(pw) || !/\d/.test(pw))                return send(res, 400, { error: 'Senha: 12+ caracteres com letras e números.' });
      if (!db.users.some(u => u.email === email) &&
          db.users.filter(u => u.status === 'pending').length < 100) {
        const salt = rid();
        db.users.push({
          id: rid(), name, email, role: 'user', status: 'pending',
          salt, hash: scrypt(pw, salt), created: Date.now(), last: null,
          sv: 0, xp: 0, streak: 0, streakLast: null, focusMinutes: 0,
          preferences: { theme: 'dark', defaultView: 'list', notifications: true }
        });
        log('Solicitação de acesso', email, ip);
        console.log(`>> Nova solicitação: ${name} <${email}>`);
      }
      return send(res, 200, { ok: true }); // anti-enumeration
    }

    if (p === '/api/login' && req.method === 'POST') {
      const email = clean(b.email, 120).toLowerCase();
      const k     = ip + '|' + email;
      if (locked(k)) return send(res, 429, { error: 'Conta bloqueada temporariamente. Aguarde 15 min.' });
      const u   = db.users.find(x => x.email === email);
      const ref = u || DUMMY;
      const ok  = same(scrypt(String(b.password || ''), ref.salt), ref.hash) && !!u && u.status === 'approved';
      if (!ok) {
        fail(k);
        log('Login recusado', email, ip);
        return send(res, 401, { error: 'Credenciais inválidas ou acesso não liberado.' });
      }
      const tok = crypto.randomBytes(32).toString('base64url');
      sessions.set(sha(tok), { uid: u.id, exp: Date.now() + TTL, sv: u.sv });
      u.last = Date.now();
      log('Login', email, ip);
      return send(res, 200, pubUser(u), {
        'Set-Cookie': `${COOKIE}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}${SECURE}`
      });
    }

    // ── logout (pre-auth) ──
    if (p === '/api/logout' && req.method === 'POST') {
      const t = getCookie(req); if (t) sessions.delete(sha(t));
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE}`
      });
    }

    // ══════════════════════════════════════════════════════
    // AUTHENTICATED
    // ══════════════════════════════════════════════════════
    const me = auth(req);
    if (!me) return send(res, 401, { error: 'Não autenticado' });

    // ── me / profile ──
    if (p === '/api/me') return send(res, 200, pubUser(me));

    if (p === '/api/me/preferences' && req.method === 'POST') {
      const { theme, defaultView, notifications } = b;
      me.preferences = me.preferences || {};
      if (['dark', 'light', 'midnight'].includes(theme)) me.preferences.theme = theme;
      if (['list', 'kanban', 'board'].includes(defaultView)) me.preferences.defaultView = defaultView;
      if (notifications !== undefined) me.preferences.notifications = Boolean(notifications);
      save();
      return send(res, 200, { ok: true, preferences: me.preferences });
    }

    if (p === '/api/me/password' && req.method === 'POST') {
      const cur = String(b.current || ''), next = String(b.next || '');
      if (!same(scrypt(cur, me.salt), me.hash))
        return send(res, 403, { error: 'Senha atual incorreta.' });
      if (next.length < 12 || next.length > 128 || !/[a-zA-Z]/.test(next) || !/\d/.test(next))
        return send(res, 400, { error: 'Nova senha: 12+ caracteres com letras e números.' });
      me.salt = rid();
      me.hash = scrypt(next, me.salt);
      me.sv++;
      killSessions(me.id);
      log('Senha alterada', me.email, ip);
      save();
      return send(res, 200, { ok: true, message: 'Senha alterada. Faça login novamente.' });
    }

    // ── focus/pomodoro ──
    if (p === '/api/user/focus' && req.method === 'POST') {
      const mins = Math.min(180, Math.max(1, +b.minutes || 25));
      me.focusMinutes = (me.focusMinutes || 0) + mins;
      awardXP(me, Math.round(mins * 1.2));
      return send(res, 200, { ok: true, user: pubUser(me) });
    }

    // ── tags ──
    if (p === '/api/tags' && req.method === 'GET') {
      // Retorna tags usadas pelo user com contagem
      const taskTags = db.tasks
        .filter(t => t.u === me.id)
        .flatMap(t => t.tags || []);
      const counts = taskTags.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
      return send(res, 200, sorted);
    }

    // ── tasks: bulk ops ──
    if (p === '/api/tasks/clear-done' && req.method === 'POST') {
      const before = db.tasks.length;
      db.tasks = db.tasks.filter(t => !(t.u === me.id && t.d));
      save();
      return send(res, 200, { ok: true, removed: before - db.tasks.length });
    }

    if (p === '/api/tasks/export' && req.method === 'GET') {
      const tasks = db.tasks.filter(t => t.u === me.id);
      return send(res, 200, { version: 3, exportedAt: new Date().toISOString(), tasks });
    }

    if (p === '/api/tasks/import' && req.method === 'POST') {
      const items = Array.isArray(b.tasks) ? b.tasks : (Array.isArray(b) ? b : []);
      let imported = 0;
      for (const item of items.slice(0, 200)) {
        const x = clean(item.x || item.title || '', 200);
        if (!x) continue;
        const priority = PRIORITIES.includes(item.priority || item.p) ? (item.priority || item.p) : 'normal';
        const status   = STATUSES.includes(item.status) ? item.status : (item.d ? 'done' : 'todo');
        db.tasks.unshift({
          id: rid(), u: me.id, x,
          d: status === 'done' || Boolean(item.d),
          p: priority,
          c: clean(item.c || item.category || '', 32),
          tags: normalizeTags(item.tags),
          due: /^\d{4}-\d{2}-\d{2}$/.test(String(item.due || '')) ? String(item.due) : '',
          note: clean(item.note || item.details || '', 1000),
          links: normalizeLinks(item.links),
          pinned: Boolean(item.pinned),
          status,
          steps: normalizeSteps(item.steps),
          comments: [],
          created: item.created || Date.now(),
          updated: Date.now()
        });
        imported++;
      }
      save();
      return send(res, 200, { ok: true, imported });
    }

    // ── tasks: list ──
    if (p === '/api/tasks' && req.method === 'GET') {
      const q       = url.searchParams.get('q') || '';
      const filter  = url.searchParams.get('filter') || 'all';
      const sortBy  = url.searchParams.get('sort') || 'smart';
      const page    = Math.max(1, +url.searchParams.get('page') || 1);
      const perPage = Math.min(200, Math.max(10, +url.searchParams.get('per_page') || 100));
      const today   = new Date().toISOString().slice(0, 10);

      let tasks = db.tasks
        .filter(t => t.u === me.id)
        .map(t => ({ ...t, steps: t.steps || [], tags: t.tags || [], links: t.links || [], comments: t.comments || [] }));

      // search
      if (q) {
        const ql = q.toLowerCase();
        tasks = tasks.filter(t =>
          t.x.toLowerCase().includes(ql) ||
          (t.note || '').toLowerCase().includes(ql) ||
          (t.c || '').toLowerCase().includes(ql) ||
          (t.tags || []).some(tag => tag.includes(ql))
        );
      }

      // filter
      switch (filter) {
        case 'open':    tasks = tasks.filter(t => !t.d); break;
        case 'done':    tasks = tasks.filter(t => t.d); break;
        case 'pinned':  tasks = tasks.filter(t => t.pinned && !t.d); break;
        case 'urgent':  tasks = tasks.filter(t => !t.d && t.p === 'urgent'); break;
        case 'high':    tasks = tasks.filter(t => !t.d && (t.p === 'high' || t.p === 'urgent')); break;
        case 'today':   tasks = tasks.filter(t => !t.d && (!t.due || t.due === today)); break;
        case 'overdue': tasks = tasks.filter(t => !t.d && t.due && t.due < today); break;
        case 'review':  tasks = tasks.filter(t => !t.d && t.status === 'review'); break;
        case 'doing':   tasks = tasks.filter(t => !t.d && t.status === 'doing'); break;
        default:
          if (filter.startsWith('tag:'))
            tasks = tasks.filter(t => (t.tags || []).includes(filter.slice(4)));
          else if (filter.startsWith('cat:'))
            tasks = tasks.filter(t => (t.c || '').toLowerCase() === filter.slice(4).toLowerCase());
      }

      // sort
      const pOrd = { urgent: 0, high: 1, normal: 2, low: 3 };
      if (sortBy === 'priority') {
        tasks.sort((a, b) => (pOrd[a.p] ?? 2) - (pOrd[b.p] ?? 2));
      } else if (sortBy === 'due') {
        tasks.sort((a, b) => {
          if (!a.due && !b.due) return 0;
          if (!a.due) return 1;
          if (!b.due) return -1;
          return a.due.localeCompare(b.due);
        });
      } else if (sortBy === 'alpha') {
        tasks.sort((a, b) => a.x.localeCompare(b.x));
      } else { // smart
        tasks.sort((a, b) => {
          if (a.d !== b.d) return a.d ? 1 : -1;
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          const pa = pOrd[a.p] ?? 2, pb = pOrd[b.p] ?? 2;
          if (pa !== pb) return pa - pb;
          if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
          if (a.due && !b.due) return -1;
          if (!a.due && b.due) return 1;
          return (b.created || 0) - (a.created || 0);
        });
      }

      const total   = tasks.length;
      const start   = (page - 1) * perPage;
      const sliced  = tasks.slice(start, start + perPage);
      return send(res, 200, { tasks: sliced, total, page, perPage, pages: Math.ceil(total / perPage) });
    }

    // ── tasks: create ──
    if (p === '/api/tasks' && req.method === 'POST') {
      const x = clean(b.x ?? b.title ?? '', 200);
      if (!x) return send(res, 400, { error: 'Escreva o título da tarefa.' });
      if (db.tasks.filter(t => t.u === me.id).length >= MAX_TASKS)
        return send(res, 400, { error: 'Limite de tarefas atingido.' });
      const priority = PRIORITIES.includes(b.priority || b.p) ? (b.priority || b.p) : 'normal';
      const status   = STATUSES.includes(b.status) ? b.status : 'todo';
      const t = {
        id: rid(), u: me.id, x,
        d: status === 'done',
        p: priority,
        c: clean(b.category || b.c || '', 32),
        tags: normalizeTags(b.tags),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || '')) ? String(b.due) : '',
        note: clean(b.note || '', 1000),
        links: normalizeLinks(b.links),
        pinned: Boolean(b.pinned),
        status,
        steps: normalizeSteps(b.steps),
        comments: [],
        created: Date.now(),
        updated: Date.now()
      };
      db.tasks.unshift(t);
      save();
      return send(res, 201, t);
    }

    // ── tasks: single task ops ──
    let m;

    // PATCH/edit
    m = p.match(/^\/api\/tasks\/([a-f0-9]+)$/);
    if (m && req.method === 'PATCH') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      if (b.x !== undefined)        t.x       = clean(b.x, 200) || t.x;
      if (b.priority !== undefined) t.p       = PRIORITIES.includes(b.priority) ? b.priority : t.p;
      if (b.category !== undefined) t.c       = clean(b.category, 32);
      if (b.tags !== undefined)     t.tags    = normalizeTags(b.tags);
      if (b.due !== undefined)      t.due     = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : '';
      if (b.note !== undefined)     t.note    = clean(b.note, 1000);
      if (b.links !== undefined)    t.links   = normalizeLinks(b.links);
      if (b.pinned !== undefined)   t.pinned  = Boolean(b.pinned);
      if (b.steps !== undefined)    t.steps   = normalizeSteps(b.steps);
      if (b.status !== undefined && STATUSES.includes(b.status)) {
        const wasDone = t.d;
        t.status = b.status;
        t.d      = b.status === 'done';
        if (t.d !== wasDone) awardXP(me, t.d ? (XP_MAP[t.p] || 20) : -(XP_MAP[t.p] || 20));
      }
      t.updated = Date.now();
      save();
      return send(res, 200, { ok: true, task: t, user: pubUser(me) });
    }

    // DELETE
    if (m && req.method === 'DELETE') {
      const idx = db.tasks.findIndex(t => t.id === m[1] && t.u === me.id);
      if (idx === -1) return send(res, 404, { error: 'Tarefa não encontrada' });
      db.tasks.splice(idx, 1);
      save();
      return send(res, 200, { ok: true });
    }

    // ── legacy POST ops (toggle, delete, edit, pin, status) ──
    m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/(toggle|delete|edit|pin|status)$/);
    if (m && req.method === 'POST') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      t.steps = t.steps || []; t.tags = t.tags || []; t.links = t.links || [];
      const [,, action] = m;

      if (action === 'toggle') {
        t.d      = !t.d;
        t.status = t.d ? 'done' : 'todo';
        awardXP(me, t.d ? (XP_MAP[t.p] || 20) : -(XP_MAP[t.p] || 20));
      } else if (action === 'pin') {
        t.pinned = !t.pinned;
      } else if (action === 'status') {
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Status inválido' });
        const wasDone = t.d;
        t.status = b.status;
        t.d      = b.status === 'done';
        if (t.d !== wasDone) awardXP(me, t.d ? (XP_MAP[t.p] || 20) : -(XP_MAP[t.p] || 20));
      } else if (action === 'delete') {
        db.tasks = db.tasks.filter(x => x !== t);
      } else { // edit
        const x = clean(b.x ?? b.title ?? '', 200);
        if (!x) return send(res, 400, { error: 'Título obrigatório.' });
        t.x    = x;
        if (b.priority !== undefined) t.p    = PRIORITIES.includes(b.priority) ? b.priority : t.p;
        if (b.category !== undefined) t.c    = clean(b.category, 32);
        if (b.tags !== undefined)     t.tags = normalizeTags(b.tags);
        if (b.due !== undefined)      t.due  = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : '';
        if (b.note !== undefined)     t.note = clean(b.note, 1000);
        if (b.links !== undefined)    t.links = normalizeLinks(b.links);
        if (b.pinned !== undefined)   t.pinned = Boolean(b.pinned);
        if (b.steps !== undefined)    t.steps = normalizeSteps(b.steps);
        if (b.status && STATUSES.includes(b.status)) {
          const wasDone = t.d; t.status = b.status; t.d = b.status === 'done';
          if (t.d !== wasDone) awardXP(me, t.d ? (XP_MAP[t.p] || 20) : -(XP_MAP[t.p] || 20));
        }
      }
      t.updated = Date.now();
      save();
      return send(res, 200, { ok: true, task: t, user: pubUser(me) });
    }

    // ── steps ──
    m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/steps?$/);
    if (m && req.method === 'POST') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      t.steps = t.steps || [];
      if (t.steps.length >= MAX_STEPS) return send(res, 400, { error: 'Limite de passos atingido.' });
      const txt = clean(b.text || b.title || '', 200);
      if (!txt) return send(res, 400, { error: 'Texto do passo obrigatório.' });
      const step = { id: rid(), text: txt, done: false, created: Date.now() };
      t.steps.push(step);
      t.updated = Date.now();
      save();
      return send(res, 201, { ok: true, step, task: t });
    }

    m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/step\/([a-f0-9]+)\/(toggle|delete|edit)$/);
    if (m && req.method === 'POST') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      t.steps = t.steps || [];
      const step = t.steps.find(s => s.id === m[2]);
      if (!step) return send(res, 404, { error: 'Passo não encontrado' });
      if (m[3] === 'toggle') {
        step.done = !step.done;
        if (step.done) awardXP(me, XP_MAP.step);
      } else if (m[3] === 'delete') {
        t.steps = t.steps.filter(s => s !== step);
      } else {
        const txt = clean(b.text || '', 200);
        if (txt) step.text = txt;
      }
      t.updated = Date.now();
      save();
      return send(res, 200, { ok: true, task: t, user: pubUser(me) });
    }

    // ── comments ──
    m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/comments$/);
    if (m && req.method === 'POST') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      t.comments = t.comments || [];
      if (t.comments.length >= 100) return send(res, 400, { error: 'Limite de comentários atingido.' });
      const text = clean(b.text || '', 500);
      if (!text) return send(res, 400, { error: 'Texto obrigatório.' });
      const comment = { id: rid(), text, author: me.name, uid: me.id, created: Date.now() };
      t.comments.push(comment);
      t.updated = Date.now();
      save();
      return send(res, 201, { ok: true, comment, task: t });
    }

    m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/comments\/([a-f0-9]+)$/);
    if (m && req.method === 'DELETE') {
      const t = db.tasks.find(t => t.id === m[1] && t.u === me.id);
      if (!t) return send(res, 404, { error: 'Tarefa não encontrada' });
      t.comments = (t.comments || []).filter(c => !(c.id === m[2] && (c.uid === me.id || me.role === 'admin')));
      t.updated = Date.now();
      save();
      return send(res, 200, { ok: true });
    }

    // ── ADMIN ────────────────────────────────────────────────────────────────
    if (p.startsWith('/api/admin/')) {
      if (me.role !== 'admin') {
        log('Tentativa admin negada', me.email, ip);
        return send(res, 403, { error: 'Acesso negado' });
      }

      if (p === '/api/admin/stats' && req.method === 'GET') {
        const users    = db.users;
        const tasks    = db.tasks;
        const today    = new Date().toISOString().slice(0, 10);
        const activeS  = sessions.size;
        const topUsers = users
          .filter(u => u.status === 'approved')
          .sort((a, b) => (b.xp || 0) - (a.xp || 0))
          .slice(0, 5)
          .map(u => ({ name: u.name, xp: u.xp || 0, streak: u.streak || 0 }));
        return send(res, 200, {
          users:       { total: users.length, approved: users.filter(u => u.status === 'approved').length, pending: users.filter(u => u.status === 'pending').length, blocked: users.filter(u => u.status === 'blocked').length },
          tasks:       { total: tasks.length, done: tasks.filter(t => t.d).length, today: tasks.filter(t => t.created > Date.now() - 86400000).length },
          activeSessions: activeS,
          topUsers
        });
      }

      if (p === '/api/admin/users' && req.method === 'GET') {
        return send(res, 200, {
          users: db.users.map(pubUser),
          logs: db.logs.slice(0, 60),
          totalTasks: db.tasks.length,
          activeSessions: sessions.size
        });
      }

      m = p.match(/^\/api\/admin\/users\/([a-f0-9]+)\/(approve|deny|block|unblock|kill|promote|demote)$/);
      const target = m && db.users.find(x => x.id === m[1]);
      if (!target || target.id === me.id || req.method !== 'POST')
        return send(res, 400, { error: 'Ação inválida ou alvo não encontrado' });

      if      (m[2] === 'approve' && target.status === 'pending') target.status = 'approved';
      else if (m[2] === 'deny'    && target.status === 'pending') db.users = db.users.filter(x => x !== target);
      else if (m[2] === 'block')   { target.status = 'blocked'; target.sv++; killSessions(target.id); }
      else if (m[2] === 'unblock' && target.status === 'blocked') target.status = 'approved';
      else if (m[2] === 'kill')    { target.sv++; killSessions(target.id); }
      else if (m[2] === 'promote' && target.role === 'user')  target.role = 'admin';
      else if (m[2] === 'demote'  && target.role === 'admin') target.role = 'user';
      log(`Admin: ${m[2]}`, target.email, ip);
      save();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Não encontrado' });
  } catch (e) {
    console.error('[NEXA]', e);
    send(res, 500, { error: 'Erro interno do servidor' });
  }
};

// ── START ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  http.createServer(app).listen(PORT, HOST, () => {
    console.log(`✦ NEXA Daily v3 rodando em http://${HOST}:${PORT}`);
  });
}

module.exports = app;
