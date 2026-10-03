'use strict';
/* ═══════════════════════════════════════════════════════
   NEXA Daily v3 — Frontend
   ═══════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDt = t => t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtDate = d => { if (!d) return ''; const [y,m,dy] = d.split('-'); return `${dy}/${m}`; };
const today = () => new Date().toISOString().slice(0, 10);
const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;

/* ── API CLIENT ──────────────────────────────────────── */
const api = async (url, method = 'GET', data) => {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data !== undefined ? JSON.stringify(data) : undefined
  };
  
  // Add token for authenticated requests
  const token = localStorage.getItem('nexa_token');
  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`;
  }
  
  try {
    const r = await fetch('/api/' + url, opts);
    let d = {};
    try { d = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, d };
  } catch {
    return { ok: false, status: 0, d: { error: 'Sem conexão com o servidor.' } };
  }
};
const GET    = url        => api(url);
const POST   = (url, d)  => api(url, 'POST', d);
const PATCH  = (url, d)  => api(url, 'PATCH', d);
const DELETE = url        => api(url, 'DELETE');

/* ── STATE ───────────────────────────────────────────── */
let me = null, currentTab = 'main', adminData = null, adminPoll = null;
let adminQuery = '', adminStatus = 'all';
let adminSearchTimer = null;
let taskFilter = 'all', taskQuery = '', sortBy = 'smart', currentView = 'list';
let cachedTasks = [];
let soundEnabled = localStorage.getItem('nexa_sound') !== '0';
let pendingCount = 0;

/* ── AUDIO ENGINE ────────────────────────────────────── */
let _audioCtx = null;
const getCtx = () => {
  try {
    const Cls = window.AudioContext || window.webkitAudioContext;
    if (!Cls) return null;
    if (!_audioCtx) _audioCtx = new Cls();
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(()=>{});
    return _audioCtx;
  } catch { return null; }
};
const note = (ctx, freq, type, start, dur, vol = 0.1) => {
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(vol, start); g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(start); osc.stop(start + dur + 0.01);
};
const sfx = {
  blip:     ctx => { const t = ctx.currentTime; note(ctx, 520, 'sine', t, 0.08, 0.07); note(ctx, 880, 'sine', t+0.04, 0.07, 0.05); },
  complete: ctx => { const t = ctx.currentTime; [523,659,784].forEach((f,i) => note(ctx, f, 'triangle', t+i*0.07, 0.28, 0.1)); },
  streak:   ctx => { const t = ctx.currentTime; [440,554,659,880].forEach((f,i) => note(ctx, f, 'sine', t+i*0.08, 0.28, 0.12)); },
  trash:    ctx => { const t = ctx.currentTime; note(ctx, 240, 'sawtooth', t, 0.18, 0.07); },
  alarm:    ctx => { const t = ctx.currentTime; [880,1174,880,1174].forEach((f,i) => note(ctx, f, 'square', t+i*0.12, 0.1, 0.07)); },
  pin:      ctx => { const t = ctx.currentTime; note(ctx, 1100, 'sine', t, 0.1, 0.07); },
  levelup:  ctx => { const t = ctx.currentTime; [523,659,784,1047].forEach((f,i) => note(ctx, f, 'triangle', t+i*0.12, 0.4, 0.14)); },
};
const play = type => {
  if (!soundEnabled || reduce) return;
  try { const ctx = getCtx(); if (ctx && sfx[type]) sfx[type](ctx); } catch {}
};

/* ── XP / RANKS ──────────────────────────────────────── */
const RANKS = [
  { min: 0,    title: 'Iniciado Cyber',    tag: 'LVL 1', color: '#7a6699' },
  { min: 100,  title: 'Code Runner',       tag: 'LVL 2', color: '#a855f7' },
  { min: 250,  title: 'Operador Grid',     tag: 'LVL 3', color: '#8b5cf6' },
  { min: 500,  title: 'Netrunner',         tag: 'LVL 4', color: '#6366f1' },
  { min: 900,  title: 'Ghost Agent',       tag: 'LVL 5', color: '#06b6d4' },
  { min: 1500, title: 'Sec-Ops Phantom',   tag: 'LVL 6', color: '#10b981' },
  { min: 2400, title: 'Neural Architect',  tag: 'LVL 7', color: '#f59e0b' },
  { min: 3800, title: 'Overclocked Prime', tag: 'LVL 8', color: '#f97316' },
  { min: 6000, title: 'Nexus Sovereign',   tag: 'LVL 9', color: '#ef4444' },
  { min: 9000, title: 'Ghost in the Shell', tag: 'MAX',  color: '#ec4899' },
];
const getRank = xp => {
  let r = RANKS[0], next = RANKS[1];
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].min) { r = RANKS[i]; next = RANKS[i + 1] || null; }
  }
  const pct = next ? Math.min(100, Math.round(((xp - r.min) / (next.min - r.min)) * 100)) : 100;
  return { ...r, next, pct, toNext: next ? next.min - xp : 0 };
};

/* ── PARTICLE BG ─────────────────────────────────────── */
(function initBg() {
  const c = document.getElementById('bg'); if (!c) return;
  const x = c.getContext('2d');
  let w, h, P = [], mx = -999, my = -999;
  const resize = () => {
    w = c.width = innerWidth; h = c.height = innerHeight;
    P = Array.from({ length: Math.min(60, (w * h / 20000) | 0) }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .5, vy: (Math.random() - .5) * .5,
      hue: 260 + Math.random() * 40
    }));
  };
  addEventListener('resize', resize); resize();
  addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; });
  (function loop() {
    x.clearRect(0, 0, w, h);
    for (const p of P) {
      const dx = p.x - mx, dy = p.y - my, d = Math.hypot(dx, dy);
      if (d < 120) { p.vx += dx / d * .04; p.vy += dy / d * .04; }
      p.vx *= .98; p.vy *= .98;
      if (!reduce) { p.x += p.vx; p.y += p.vy; }
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      x.fillStyle = `hsl(${p.hue}, 80%, 65%)`;
      x.fillRect(p.x, p.y, 1.5, 1.5);
    }
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const d = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y);
        if (d < 100) {
          const hue = (P[i].hue + P[j].hue) / 2;
          x.strokeStyle = `hsla(${hue}, 70%, 60%, ${.35 * (1 - d / 100)})`;
          x.beginPath(); x.moveTo(P[i].x, P[i].y); x.lineTo(P[j].x, P[j].y); x.stroke();
        }
      }
    }
    if (!reduce) requestAnimationFrame(loop);
  })();
})();

/* ── FX: BURST ───────────────────────────────────────── */
function burst(cx, cy, count = 16) {
  if (reduce) return;
  const colors = ['#7b2dff', '#a855f7', '#ec4899', '#f97316', '#34d399'];
  for (let i = 0; i < count; i++) {
    const s = document.createElement('i');
    const a = (i / count) * Math.PI * 2, d = 35 + Math.random() * 70;
    s.className = 'spark';
    s.style.cssText = `left:${cx}px;top:${cy}px;--dx:${Math.cos(a)*d}px;--dy:${Math.sin(a)*d}px;background:${colors[i % colors.length]}`;
    document.body.append(s);
    setTimeout(() => s.remove(), 700);
  }
}

/* ── TOAST ───────────────────────────────────────────── */
let _toastTimer;
function toast(msg, type = '') {
  $('.toast')?.remove(); clearTimeout(_toastTimer);
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.setAttribute('role', 'status');
  d.innerHTML = `<span>${type === 'success' ? '⚡' : type === 'error' ? '✕' : '◈'}</span> <span>${esc(msg)}</span>`;
  document.body.append(d);
  _toastTimer = setTimeout(() => d.remove(), 3500);
}

/* ── CONFIRM DIALOG ──────────────────────────────────── */
const ask = msg => new Promise(r => {
  const d = document.createElement('dialog');
  d.innerHTML = `
    <p style="font-size:1rem;line-height:1.5;margin:0 0 1.2rem">${esc(msg)}</p>
    <div class="acts">
      <button class="btn ghost" value="n">Cancelar</button>
      <button class="btn red" value="y">Confirmar</button>
    </div>
  `;
  document.body.append(d);
  d.querySelectorAll('button').forEach(b => b.onclick = () => { d.close(); d.remove(); r(b.value === 'y'); });
  d.oncancel = () => { d.remove(); r(false); };
  d.showModal();
});

/* ── COUNT-UP ANIMATION ──────────────────────────────── */
function countUp() {
  $$('[data-counter]').forEach(el => {
    const to = +el.dataset.counter;
    if (reduce || isNaN(to)) { el.textContent = isNaN(to) ? '0' : to; return; }
    const t0 = performance.now();
    (function f(t) {
      const k = Math.min(1, (t - t0) / 600);
      el.textContent = Math.round(to * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(f);
    })(t0);
  });
}

/* ── COPY UTIL ───────────────────────────────────────── */
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  const t = Object.assign(document.createElement('textarea'), { value: s });
  Object.assign(t.style, { position: 'fixed', opacity: '0' });
  document.body.append(t); t.select();
  const ok = document.execCommand('copy');
  t.remove(); return ok;
}

/* ── THEME ───────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'dark';
  localStorage.setItem('nexa_theme', theme || 'dark');
}
applyTheme(localStorage.getItem('nexa_theme') || 'dark');

/* ── XP BANNER ───────────────────────────────────────── */
function updateXPBanner() {
  const banner = $('#xpBanner'); if (!banner || !me) return;
  const rank = getRank(me.xp || 0);
  banner.innerHTML = `
    <div class="xp-header">
      <div class="stat-chips">
        <span class="rank-badge" style="border-color:${rank.color};color:${rank.color};background:${rank.color}1a">
          ${rank.tag} · ${rank.title}
        </span>
        <span class="stat-chip fire">🔥 ${me.streak || 0}d streak</span>
        <span class="stat-chip focus">⏱️ ${me.focusMinutes || 0}m foco</span>
        <span class="stat-chip xp">⚡ ${(me.xp || 0).toLocaleString('pt-BR')} XP</span>
      </div>
      ${rank.next ? `<span style="font-size:0.78rem;color:var(--mut);font-family:var(--mono)">${rank.toNext} XP para ${rank.next.title}</span>` : '<span style="font-size:0.78rem;color:var(--gold);font-weight:700">⭐ NÍVEL MÁXIMO</span>'}
    </div>
    <div class="xp-bar-outer">
      <div class="xp-bar-inner" style="width:${rank.pct}%"></div>
    </div>
    <div class="xp-subtext"><span>LVL progress</span><span>${rank.pct}%</span></div>
  `;
}

/* ── SANITIZE TASKS ──────────────────────────────────── */
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES   = ['todo', 'doing', 'review', 'done'];
const PRI_LABEL  = { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'URGENTE' };
const STATUS_LABEL = { todo: 'A fazer', doing: 'Em foco', review: 'Revisão', done: 'Concluída' };

function sanitize(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map(t => ({
    id: String(t.id || ''),
    u: String(t.u || ''),
    x: String(t.x || t.title || ''),
    d: Boolean(t.d),
    p: PRIORITIES.includes(t.p) ? t.p : 'normal',
    c: String(t.c || '').trim(),
    tags: Array.isArray(t.tags) ? t.tags : [],
    due: String(t.due || '').slice(0, 10),
    note: String(t.note || '').trim(),
    links: Array.isArray(t.links) ? t.links : [],
    pinned: Boolean(t.pinned),
    status: STATUSES.includes(t.status) ? t.status : (t.d ? 'done' : 'todo'),
    steps: Array.isArray(t.steps) ? t.steps.map(s => ({ id: String(s.id), text: String(s.text || ''), done: Boolean(s.done) })).filter(s => s.text) : [],
    comments: Array.isArray(t.comments) ? t.comments : [],
    created: Number(t.created) || 0,
    updated: Number(t.updated) || 0,
  }));
}

/* ── TASK FILTERING (client side fallback) ───────────── */
function filterTasks(tasks) {
  const q = taskQuery.trim().toLowerCase();
  const td = today();
  return tasks.filter(t => {
    const matchQ = !q || [t.x, t.note, t.c, ...t.tags].some(v => String(v || '').toLowerCase().includes(q));
    let matchF = true;
    switch (taskFilter) {
      case 'open':    matchF = !t.d; break;
      case 'done':    matchF = t.d; break;
      case 'pinned':  matchF = t.pinned && !t.d; break;
      case 'urgent':  matchF = !t.d && t.p === 'urgent'; break;
      case 'high':    matchF = !t.d && (t.p === 'high' || t.p === 'urgent'); break;
      case 'today':   matchF = !t.d && (!t.due || t.due === td); break;
      case 'overdue': matchF = !t.d && !!t.due && t.due < td; break;
      case 'review':  matchF = !t.d && t.status === 'review'; break;
      case 'doing':   matchF = !t.d && t.status === 'doing'; break;
      default:
        if (taskFilter.startsWith('tag:')) matchF = t.tags.includes(taskFilter.slice(4));
        else if (taskFilter.startsWith('cat:')) matchF = t.c.toLowerCase() === taskFilter.slice(4).toLowerCase();
    }
    return matchQ && matchF;
  });
}

/* ── RELOAD ──────────────────────────────────────────── */
async function reloadTasks(silent = false) {
  const r = await GET('tasks?per_page=200');
  if (r.ok && Array.isArray(r.d.tasks)) {
    cachedTasks = sanitize(r.d.tasks);
  } else if (r.ok && Array.isArray(r.d)) {
    cachedTasks = sanitize(r.d);
  }
  updateXPBanner();
  updateMetrics();
  renderTasks();
}

/* ── METRICS ─────────────────────────────────────────── */
function updateMetrics() {
  const open    = cachedTasks.filter(t => !t.d).length;
  const doing   = cachedTasks.filter(t => !t.d && t.status === 'doing').length;
  const urgent  = cachedTasks.filter(t => !t.d && t.p === 'urgent').length;
  const done    = cachedTasks.filter(t => t.d).length;
  const overdue = cachedTasks.filter(t => !t.d && t.due && t.due < today()).length;

  const set = (id, v) => { const el = $(id); if (el) { el.dataset.counter = v; el.textContent = v; } };
  set('#mOpen', open); set('#mDoing', doing); set('#mUrgent', urgent); set('#mDone', done);

  const fOpen = $('#fCountOpen'), fDone = $('#fCountDone'), fUrg = $('#fCountUrgent');
  if (fOpen) fOpen.textContent = `(${open})`;
  if (fDone) fDone.textContent = `(${done})`;
  if (fUrg)  fUrg.textContent  = `(${urgent})`;

  const sum = $('#taskSummary');
  if (sum) sum.textContent = `${open} pendente${open !== 1 ? 's' : ''} · ${done} concluída${done !== 1 ? 's' : ''}${overdue ? ` · ⚠️ ${overdue} atrasada${overdue !== 1 ? 's' : ''}` : ''}`;

  countUp();
}

/* ── TASK CARD ───────────────────────────────────────── */
function renderCard(t, compact = false) {
  const steps     = t.steps || [];
  const doneSteps = steps.filter(s => s.done).length;
  const stepPct   = steps.length ? Math.round(doneSteps / steps.length * 100) : 0;
  const td        = today();
  const isLate    = t.due && t.due < td && !t.d;
  const isToday   = t.due && t.due === td && !t.d;

  const tagsHtml = [
    t.c ? `<span class="tag click" data-cat="${esc(t.c)}">🏷 ${esc(t.c)}</span>` : '',
    ...(t.tags || []).map(tg => `<span class="tag hashtag click" data-tag="${esc(tg)}">#${esc(tg)}</span>`),
    `<span class="tag p-${t.p}">${PRI_LABEL[t.p]}</span>`,
    t.due ? `<span class="tag ${isLate ? 'due-late' : isToday ? 'due-today' : ''}">${isLate ? '⚠ Atrasada' : isToday ? '📅 Hoje' : '📅 ' + fmtDate(t.due)}</span>` : '',
    t.status !== 'todo' && !t.d ? `<span class="tag status-${t.status}">${STATUS_LABEL[t.status] || t.status}</span>` : '',
    t.d ? `<span class="tag status-done">✔ Concluída</span>` : '',
  ].filter(Boolean).join('');

  const linksHtml = (t.links || []).length ? `
    <div class="task-links">
      ${t.links.map(l => `<a class="task-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(l.label || l.url)}</a>`).join('')}
    </div>` : '';

  const stepsHtml = steps.length || !compact ? `
    <div class="subtasks-box">
      <div class="subtasks-header">
        <span>Checklist (${doneSteps}/${steps.length})</span>
        <span>${stepPct}%</span>
      </div>
      ${steps.length ? `<div class="subtasks-bar-outer"><div class="subtasks-bar-inner" style="width:${stepPct}%"></div></div>` : ''}
      <div class="subtask-items">
        ${steps.map(s => `
          <div class="subtask-item ${s.done ? 'done' : ''}">
            <input type="checkbox" data-step-toggle="${s.id}" data-tid="${t.id}" ${s.done ? 'checked' : ''}>
            <span class="step-text">${esc(s.text)}</span>
            <button type="button" class="step-del" data-step-del="${s.id}" data-tid="${t.id}">×</button>
          </div>`).join('')}
      </div>
      <form class="subtask-add-form" data-step-add="${t.id}">
        <input placeholder="+ Novo item…" maxlength="200" autocomplete="off">
        <button class="btn s" type="submit">+</button>
      </form>
    </div>` : '';

  return `
    <div class="task-card ${t.d ? 'done' : ''} ${t.p} ${t.pinned ? 'pinned' : ''}" data-id="${t.id}" draggable="true">
      <div class="task-head">
        <input type="checkbox" data-toggle="${t.id}" ${t.d ? 'checked' : ''} title="Marcar como concluída">
        <div class="task-main">
          <div class="task-title" data-edit-open="${t.id}">
            <span>${esc(t.x)}</span>
            ${t.pinned ? '<span class="pin-flag">📌 PIN</span>' : ''}
          </div>
          <div class="task-tags">${tagsHtml}</div>
          ${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ''}
          ${linksHtml}
          ${stepsHtml}
        </div>
        <div class="task-actions">
          <button type="button" class="mini ${t.pinned ? 'purple' : ''}" data-pin="${t.id}" title="${t.pinned ? 'Desafixar' : 'Fixar'}">${t.pinned ? '📌' : '📍'}</button>
          <button type="button" class="mini" data-edit-open="${t.id}">✏</button>
          <button type="button" class="mini danger" data-del="${t.id}">🗑</button>
        </div>
      </div>
    </div>`;
}

/* ── RENDER TASKS ────────────────────────────────────── */
function renderTasks() {
  const container = $('#viewContainer'); if (!container) return;
  const filtered  = filterTasks(cachedTasks);
  container.innerHTML = currentView === 'kanban' ? renderKanban(filtered) : renderList(filtered);
  bindInteractions(container);
  if (currentView === 'kanban') initDragDrop(container);
}

function renderList(tasks) {
  if (!tasks.length) return `
    <div class="empty-state">
      <p>Nenhuma tarefa encontrada</p>
      <span class="hint">Pressione <kbd>N</kbd> para criar ou <kbd>Ctrl+K</kbd> para captura rápida</span>
    </div>`;
  return `<div class="task-list">${tasks.map(t => renderCard(t)).join('')}</div>`;
}

function renderKanban(tasks) {
  const cols = [
    { key: 'todo',   label: 'A Fazer',    badge: '', next: 'doing',  nextLabel: 'Em Foco →' },
    { key: 'doing',  label: 'Em Foco',    badge: '', next: 'review', nextLabel: 'Revisão →' },
    { key: 'review', label: 'Revisão',    badge: '', next: 'done',   nextLabel: '✔ Concluir' },
    { key: 'done',   label: 'Concluídas', badge: '', prev: 'doing',  prevLabel: '← Reabrir' },
  ];

  return `<div class="kanban-board">
    ${cols.map(col => {
      const colTasks = tasks.filter(t => col.key === 'done' ? t.d : !t.d && t.status === col.key);
      const badgeColors = { todo: '', doing: 'background:var(--gold);color:#000', review: 'background:var(--pink);color:#fff', done: 'background:var(--emerald);color:#000' };
      return `
        <div class="kanban-col col-${col.key}" data-col="${col.key}">
          <div class="kanban-col-head">
            <div class="kanban-title"><span class="kanban-dot"></span>${col.label}</div>
            <span class="badge" style="animation:none;${badgeColors[col.key]}">${colTasks.length}</span>
          </div>
          <div class="kanban-cards">
            ${colTasks.map(t => `
              <div class="kanban-task-wrap">
                ${renderCard(t, true)}
                <div class="kanban-move-row">
                  ${col.prev ? `<button type="button" class="btn s ghost" data-move="${t.id}" data-target="${col.prev}">← ${col.prevLabel}</button>` : '<span></span>'}
                  ${col.next ? `<button type="button" class="btn s p" data-move="${t.id}" data-target="${col.next}">${col.nextLabel}</button>` : '<span></span>'}
                </div>
              </div>`).join('') || `<p style="color:var(--mut);font-size:0.85rem;padding:0.5rem">Vazio</p>`}
          </div>
        </div>`;
    }).join('')}
  </div>`;
}

/* ── DRAG & DROP ─────────────────────────────────────── */
function initDragDrop(container) {
  let dragged = null;
  container.querySelectorAll('[draggable=true]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragged = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
  });
  container.querySelectorAll('.kanban-col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (!dragged) return;
      const targetStatus = col.dataset.col;
      if (!targetStatus) return;
      const r = await POST(`tasks/${dragged}/status`, { status: targetStatus });
      if (r.ok) {
        if (r.d.user) { me = r.d.user; updateXPBanner(); }
        if (targetStatus === 'done') { play('complete'); burst(e.clientX, e.clientY); }
        else play('blip');
        await reloadTasks(true);
      }
    });
  });
}

/* ── BIND INTERACTIONS ───────────────────────────────── */
function bindInteractions(container) {
  // toggle
  container.querySelectorAll('[data-toggle]').forEach(cb => cb.onchange = async () => {
    const tid = cb.dataset.toggle;
    const t   = cachedTasks.find(x => x.id === tid);
    if (t) { t.d = cb.checked; t.status = cb.checked ? 'done' : 'todo'; }
    if (cb.checked) { const r = cb.getBoundingClientRect(); burst(r.left + 10, r.top + 10); play('complete'); }
    else play('blip');
    updateMetrics();
    const r = await POST(`tasks/${tid}/toggle`, {});
    if (r.ok && r.d.user) { me = r.d.user; updateXPBanner(); }
    await reloadTasks(true);
  });

  // pin
  container.querySelectorAll('[data-pin]').forEach(b => b.onclick = async () => {
    play('pin');
    await POST(`tasks/${b.dataset.pin}/pin`, {});
    await reloadTasks(true);
  });

  // kanban move
  container.querySelectorAll('[data-move]').forEach(b => b.onclick = async () => {
    const target = b.dataset.target;
    const r = await POST(`tasks/${b.dataset.move}/status`, { status: target });
    if (r.ok) {
      if (r.d.user) { me = r.d.user; updateXPBanner(); }
      if (target === 'done') { play('complete'); burst(innerWidth / 2, 200); }
      else play('blip');
      await reloadTasks(true);
    }
  });

  // edit open
  container.querySelectorAll('[data-edit-open]').forEach(el => el.onclick = () => {
    const t = cachedTasks.find(x => x.id === el.dataset.editOpen);
    if (t) openEditor(t);
  });

  // delete
  container.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await ask('Excluir esta tarefa permanentemente?')) return;
    play('trash');
    await POST(`tasks/${b.dataset.del}/delete`, {});
    await reloadTasks(true);
  });

  // step toggle
  container.querySelectorAll('[data-step-toggle]').forEach(cb => cb.onchange = async () => {
    if (cb.checked) play('blip');
    const r = await POST(`tasks/${cb.dataset.tid}/step/${cb.dataset.stepToggle}/toggle`, {});
    if (r.ok && r.d.user) { me = r.d.user; updateXPBanner(); }
    await reloadTasks(true);
  });

  // step delete
  container.querySelectorAll('[data-step-del]').forEach(b => b.onclick = async () => {
    play('trash');
    await POST(`tasks/${b.dataset.tid}/step/${b.dataset.stepDel}/delete`, {});
    await reloadTasks(true);
  });

  // step add
  container.querySelectorAll('[data-step-add]').forEach(form => form.onsubmit = async e => {
    e.preventDefault();
    const input = form.querySelector('input');
    const text  = input.value.trim(); if (!text) return;
    input.value = '';
    const r = await POST(`tasks/${form.dataset.stepAdd}/step`, { text });
    if (r.ok) { play('blip'); await reloadTasks(true); }
  });

  // tag/cat click filter
  container.querySelectorAll('[data-cat]').forEach(el => el.onclick = e => {
    e.stopPropagation(); taskFilter = `cat:${el.dataset.cat}`; play('blip'); renderTasks();
  });
  container.querySelectorAll('[data-tag]').forEach(el => el.onclick = e => {
    e.stopPropagation(); taskFilter = `tag:${el.dataset.tag}`; play('blip'); renderTasks();
  });
}

/* ── TASK EDITOR ─────────────────────────────────────── */
function openEditor(task) {
  const isNew = !task;
  const t = task || { x: '', p: 'normal', c: '', tags: [], due: '', note: '', links: [], status: 'todo', pinned: false };
  const d = document.createElement('dialog');
  d.innerHTML = `
    <form method="dialog" class="editor-form">
      <h2>${isNew ? 'Nova Tarefa' : 'Editar Tarefa'}</h2>
      <label for="et">Título *</label>
      <input id="et" value="${esc(t.x)}" maxlength="200" required placeholder="Descreva a tarefa…">

      <div class="meta-2col">
        <div>
          <label for="ep">Prioridade</label>
          <select id="ep">${Object.entries(PRI_LABEL).map(([k,v]) => `<option value="${k}" ${t.p === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div>
          <label for="est">Status</label>
          <select id="est">${Object.entries(STATUS_LABEL).map(([k,v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>
      <div class="meta-2col">
        <div>
          <label for="ec">Categoria</label>
          <input id="ec" value="${esc(t.c)}" maxlength="32" placeholder="Dev, Pessoal…">
        </div>
        <div>
          <label for="edu">Prazo</label>
          <input id="edu" type="date" value="${esc(t.due || '')}">
        </div>
      </div>
      <label for="etags">Tags (separadas por vírgula)</label>
      <input id="etags" value="${esc((t.tags || []).join(', '))}" maxlength="200" placeholder="frontend, bug, sprint3">
      <label for="en">Anotações</label>
      <textarea id="en" rows="3" maxlength="1000" placeholder="Detalhes, links, contexto…">${esc(t.note || '')}</textarea>
      <label for="elinks">Links (URLs, separadas por |)</label>
      <input id="elinks" value="${esc((t.links || []).map(l => l.label ? `${l.label}: ${l.url}` : l.url).join(' | '))}" maxlength="500" placeholder="https://github.com/... | label: https://...">
      <div class="acts">
        <button class="btn ghost" type="button" data-close>Cancelar</button>
        <button class="btn p" type="submit">${isNew ? 'Criar Tarefa' : 'Salvar'}</button>
      </div>
    </form>
  `;
  document.body.append(d);
  d.querySelector('[data-close]').onclick = () => { d.close(); d.remove(); };

  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const rawLinks = d.querySelector('#elinks').value.split('|').map(s => s.trim()).filter(Boolean);
    const links = rawLinks.map(s => {
      const match = s.match(/^(.+?):\s*(https?:\/\/.+)$/);
      return match ? { label: match[1].trim(), url: match[2].trim() } : { url: s, label: '' };
    }).filter(l => /^https?:\/\//.test(l.url));

    const payload = {
      x: d.querySelector('#et').value.trim(),
      priority: d.querySelector('#ep').value,
      category: d.querySelector('#ec').value.trim(),
      tags: d.querySelector('#etags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      due: d.querySelector('#edu').value,
      status: d.querySelector('#est').value,
      note: d.querySelector('#en').value.trim(),
      links
    };
    if (!payload.x) return;

    let r;
    if (isNew) {
      r = await POST('tasks', payload);
    } else {
      r = await POST(`tasks/${t.id}/edit`, payload);
    }
    if (!r.ok) { toast(r.d.error || 'Erro ao salvar.', 'error'); return; }
    if (r.d.user) { me = r.d.user; updateXPBanner(); }
    play('blip'); d.close(); d.remove();
    await reloadTasks();
  };
  d.showModal();
  d.querySelector('#et').focus();
}

/* ── QUICK CAPTURE (Ctrl+K) ──────────────────────────── */
function openQuickCapture() {
  if ($('.quick-capture')) return;
  const overlay = document.createElement('div');
  overlay.className = 'quick-capture';
  overlay.innerHTML = `
    <div class="quick-capture-box">
      <input class="qc-input" placeholder="⚡ Nova tarefa… (Enter para criar, Esc para fechar)" maxlength="200" autocomplete="off">
      <div class="qc-hint">
        <span><kbd>Enter</kbd> criar</span>
        <span><kbd>Esc</kbd> fechar</span>
        <span><kbd>Tab</kbd> + prioridade (u=urgente, h=alta, n=normal, l=baixa)</span>
      </div>
    </div>
  `;
  document.body.append(overlay);
  const inp = overlay.querySelector('.qc-input');
  inp.focus();

  overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); } };
  inp.onkeydown = async e => {
    if (e.key === 'Escape') { overlay.remove(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      let text = inp.value.trim(); if (!text) return;
      let priority = 'normal';
      const pm = text.match(/\s+(!u|!h|!n|!l)$/i);
      if (pm) { const map = { '!u': 'urgent', '!h': 'high', '!n': 'normal', '!l': 'low' }; priority = map[pm[1].toLowerCase()] || 'normal'; text = text.slice(0, -pm[0].length).trim(); }
      const r = await POST('tasks', { x: text, priority });
      if (r.ok) { play('blip'); toast(`Tarefa criada: ${text}`, 'success'); overlay.remove(); await reloadTasks(); }
      else toast(r.d.error || 'Erro', 'error');
    }
  };
}

/* ── FOCUS POMODORO ──────────────────────────────────── */
const Focus = {
  running: false, total: 25 * 60, remain: 25 * 60,
  endAt: 0, taskId: '', timerId: null
};

function openFocus(tasks) {
  const d = document.createElement('dialog');
  const secs2str = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  d.innerHTML = `
    <div class="focus-dock">
      <div class="focus-label"><span class="pulse-ring"></span>MATRIX OVERCLOCK — MODO FOCO</div>
      <h2 style="margin:0.5rem 0 0.2rem">Sessão de Foco Profundo</h2>
      <p style="color:var(--mut);font-size:0.88rem;margin:0 0 1rem">Concluir = +XP baseado no tempo.</p>

      <div class="focus-presets">
        ${[['25', 'Foco'], ['50', 'Sprint'], ['90', 'Deep'], ['5', 'Break']].map(([m,l]) =>
          `<button class="btn s ${Focus.total === +m*60 ? 'p' : 'ghost'}" data-preset="${m}">${m}m ${l}</button>`
        ).join('')}
      </div>

      <div class="cyber-clock ${Focus.running ? 'running' : ''}" id="clockDisplay">${secs2str(Focus.remain)}</div>

      <div class="focus-progress">
        <div class="focus-progress-bar" id="focusBar" style="width:${Math.round((1 - Focus.remain/Focus.total)*100)}%"></div>
      </div>

      <div style="margin:1rem 0">
        <label for="focusTask">Vincular tarefa:</label>
        <select id="focusTask">
          <option value="">Foco geral</option>
          ${tasks.filter(t => !t.d).map(t => `<option value="${t.id}" ${t.id === Focus.taskId ? 'selected':''} >${esc(t.x.slice(0,50))}</option>`).join('')}
        </select>
      </div>

      <div class="acts" style="justify-content:center;gap:0.6rem">
        <button class="btn p" id="focusStart">${Focus.running ? 'Pausar' : 'Iniciar'}</button>
        <button class="btn ghost" id="focusReset">Reiniciar</button>
        <button class="btn ghost" id="focusClose">Fechar</button>
      </div>
    </div>
  `;
  document.body.append(d);

  const clock  = d.querySelector('#clockDisplay');
  const bar    = d.querySelector('#focusBar');
  const startB = d.querySelector('#focusStart');

  const upd = () => {
    clock.textContent = secs2str(Focus.remain);
    bar.style.width = `${Math.round((1 - Focus.remain / Focus.total) * 100)}%`;
    document.title = `(${secs2str(Focus.remain)}) NEXA Daily`;
  };

  d.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    Focus.total = +b.dataset.preset * 60; Focus.remain = Focus.total;
    clearInterval(Focus.timerId); Focus.running = false; startB.textContent = 'Iniciar';
    d.querySelectorAll('[data-preset]').forEach(x => x.className = 'btn s ghost');
    b.className = 'btn s p'; clock.classList.remove('running'); upd(); play('blip');
  });

  d.querySelector('#focusTask').onchange = e => Focus.taskId = e.target.value;

  startB.onclick = () => {
    if (Focus.running) {
      clearInterval(Focus.timerId); Focus.running = false;
      startB.textContent = 'Retomar'; clock.classList.remove('running'); play('blip');
    } else {
      Focus.running = true; Focus.endAt = Date.now() + Focus.remain * 1000;
      startB.textContent = 'Pausar'; clock.classList.add('running'); play('blip');
      Focus.timerId = setInterval(async () => {
        Focus.remain = Math.max(0, Math.round((Focus.endAt - Date.now()) / 1000));
        upd();
        if (Focus.remain <= 0) {
          clearInterval(Focus.timerId); Focus.running = false;
          Focus.remain = Focus.total; clock.classList.remove('running');
          startB.textContent = 'Iniciar'; document.title = 'NEXA Daily';
          play('alarm'); burst(innerWidth / 2, innerHeight / 2, 24);
          const r = await POST('user/focus', { minutes: Math.round(Focus.total / 60) });
          if (r.ok && r.d.user) { me = r.d.user; updateXPBanner(); }
          toast(`🎯 Sessão concluída! +${Math.round(Focus.total / 60 * 1.2)} XP`, 'success');
          upd();
        }
      }, 1000);
    }
  };

  d.querySelector('#focusReset').onclick = () => {
    clearInterval(Focus.timerId); Focus.running = false; Focus.remain = Focus.total;
    startB.textContent = 'Iniciar'; clock.classList.remove('running');
    document.title = 'NEXA Daily'; upd(); play('blip');
  };
  d.querySelector('#focusClose').onclick = () => { d.close(); d.remove(); };
  d.oncancel = () => d.remove();
  d.showModal();
}

/* ── STANDUP ─────────────────────────────────────────── */
function openStandup(tasks) {
  const nowStr   = new Date().toLocaleDateString('pt-BR');
  const done     = tasks.filter(t => t.d);
  const doing    = tasks.filter(t => !t.d && t.status === 'doing');
  const open     = tasks.filter(t => !t.d && t.status !== 'doing');
  let md = `### ⚡ NEXA Daily Standup · ${nowStr}\n\n`;
  md += `**✅ Concluído:**\n${done.length ? done.map(t => `- [x] ${t.x}${t.c ? ` _(${t.c})_` : ''}`).join('\n') : '- _Nada ainda_'}\n\n`;
  md += `**⚡ Em andamento:**\n${doing.length ? doing.map(t => `- [ ] **${t.x}** [${PRI_LABEL[t.p]}]`).join('\n') : '- _Sem tarefas em foco_'}\n\n`;
  md += `**📋 Backlog:**\n${open.length ? open.slice(0, 8).map(t => `- [ ] ${t.x}${t.due ? ` _(${t.due})_` : ''}`).join('\n') : '- _Backlog zerado! 🎉_'}\n`;
  if (open.length > 8) md += `- _...e mais ${open.length - 8} tarefas_\n`;

  const d = document.createElement('dialog');
  d.innerHTML = `
    <h2>Daily Standup</h2>
    <p class="tag-sub">Resumo em Markdown para Discord, Slack ou WhatsApp.</p>
    <pre class="standup-pre">${esc(md)}</pre>
    <div class="acts">
      <button class="btn ghost" id="closeS">Fechar</button>
      <button class="btn p" id="copyS">Copiar Markdown</button>
    </div>
  `;
  document.body.append(d);
  d.querySelector('#closeS').onclick = () => { d.close(); d.remove(); };
  d.querySelector('#copyS').onclick  = async () => {
    const ok = await copyText(md);
    play('blip');
    toast(ok ? 'Copiado!' : 'Selecione e copie manualmente.', ok ? 'success' : '');
  };
  d.oncancel = () => d.remove();
  d.showModal();
}

/* ── SHORTCUTS MODAL ─────────────────────────────────── */
function openShortcuts() {
  const d = document.createElement('dialog');
  const shortcuts = [
    ['N', 'Criar nova tarefa rápida'],
    ['Ctrl+K', 'Captura rápida de tarefa'],
    ['/', 'Buscar tarefas'],
    ['F', 'Abrir cronômetro Pomodoro'],
    ['K', 'Alternar Lista ↔ Kanban'],
    ['S', 'Gerar Daily Standup'],
    ['M', 'Ligar/desligar som'],
    ['T', 'Alterar tema (dark/light/midnight)'],
    ['?', 'Mostrar atalhos'],
    ['Esc', 'Fechar modais'],
  ];
  d.innerHTML = `
    <h2>Atalhos de Teclado</h2>
    <p class="tag-sub">Produtividade cyberpunk — sem tirar as mãos do teclado.</p>
    <table class="shortcut-table">
      <tbody>${shortcuts.map(([k,v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="acts"><button class="btn p" onclick="this.closest('dialog').close();this.closest('dialog').remove()">Entendido</button></div>
  `;
  document.body.append(d);
  d.oncancel = () => d.remove();
  d.showModal();
}

/* ── EXPORT / IMPORT ─────────────────────────────────── */
async function exportTasks() {
  const r = await GET('tasks/export');
  if (!r.ok) { toast('Erro ao exportar.', 'error'); return; }
  const blob = new Blob([JSON.stringify(r.d, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `nexa-v3-backup-${today()}.json`
  });
  a.click(); URL.revokeObjectURL(a.href);
  play('blip'); toast('Backup exportado!', 'success');
}

function importTasks() {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const raw    = await file.text();
      const parsed = JSON.parse(raw);
      const tasks  = Array.isArray(parsed) ? parsed : (parsed.tasks || []);
      if (!Array.isArray(tasks)) { toast('Arquivo inválido.', 'error'); return; }
      const r = await POST('tasks/import', { tasks });
      if (r.ok) { play('streak'); toast(`${r.d.imported} tarefas importadas!`, 'success'); await reloadTasks(); }
      else toast('Erro na importação.', 'error');
    } catch { toast('JSON inválido ou corrompido.', 'error'); }
  };
  inp.click();
}

/* ── LOGO ────────────────────────────────────────────── */
const logoHtml = () => `<div class="logo" data-t="NEXA.">NEXA<span class="dot">.</span></div>`;

/* ── GATE (LOGIN) ────────────────────────────────────── */
let loginMode = 'in';
function gate() {
  clearInterval(adminPoll); me = null;
  $('#app').innerHTML = `
    <div class="gate">
      <div class="box">
        ${logoHtml()}
        <p class="tag-sub">Terminal de Produtividade Cyberpunk<br><span style="font-size:0.78rem">Acesso restrito por autenticação segura.</span></p>
        <div class="tabs">
          <button data-mode="in"  aria-pressed="${loginMode==='in'}">Entrar</button>
          <button data-mode="req" aria-pressed="${loginMode==='req'}">Solicitar acesso</button>
        </div>
        <form id="loginForm" novalidate>
          ${loginMode === 'req' ? '<label for="ln">Nome</label><input id="ln" autocomplete="name" maxlength="60" required placeholder="Seu nome completo">' : ''}
          <label for="le">E-mail</label>
          <input id="le" type="email" autocomplete="email" required placeholder="seu@email.com">
          <label for="lp">Senha${loginMode === 'req' ? ' (12+ chars, letras e números)' : ''}</label>
          <div class="pw-wrap">
            <input id="lp" type="password" autocomplete="${loginMode === 'req' ? 'new-password' : 'current-password'}" required placeholder="••••••••••••">
            <button type="button" class="pw-toggle" id="pwt">👁</button>
          </div>
          <p class="msg" id="lmsg" role="alert"></p>
          <button class="btn p w" type="submit">${loginMode === 'req' ? 'Enviar solicitação' : 'Conectar ao sistema'}</button>
        </form>
      </div>
    </div>
  `;

  $$('[data-mode]').forEach(b => b.onclick = () => { loginMode = b.dataset.mode; play('blip'); gate(); });
  $('#pwt').onclick = () => {
    const inp = $('#lp'), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#pwt').textContent = show ? '🙈' : '👁';
  };

  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#lmsg'); msg.className = 'msg'; msg.textContent = '';
    const payload = { email: $('#le').value, password: $('#lp').value };
    if (loginMode === 'req') payload.name = $('#ln').value;
    const r = await POST(loginMode === 'req' ? 'register' : 'login', payload);
    if (!r.ok) {
      msg.className = 'msg e'; msg.textContent = r.d.error || 'Credenciais inválidas.';
      play('trash'); $('.box').classList.remove('shake'); void $('.box').offsetWidth; $('.box').classList.add('shake');
      return;
    }
    if (loginMode === 'req') {
      msg.className = 'msg o'; msg.textContent = 'Solicitação enviada! Aguarde autorização.';
      $('#loginForm').reset(); return;
    }
    // Save token and user data
    localStorage.setItem('nexa_token', r.d.token);
    play('streak'); me = r.d; currentTab = 'main'; shell();
  };
}

/* ── SHELL ───────────────────────────────────────────── */
async function shell() {
  const isAdmin = me.role === 'admin';
  const navItems = [
    { id: 'main',  label: '⚡ Painel', icon: '⚡' },
    ...(isAdmin ? [{ id: 'admin', label: '🛡 Admin', icon: '🛡', badge: pendingCount }] : []),
  ];
  const navHtml = (cls) => navItems.map(n => `
    <button class="${cls}" data-tab="${n.id}" ${currentTab === n.id ? 'aria-current="page"' : ''}>
      ${n.icon} <span class="nav-label">${n.label}</span>
      ${n.badge ? `<span class="badge">${n.badge}</span>` : ''}
    </button>`).join('');

  $('#app').innerHTML = `
    <div class="shell">
      <aside class="side">
        ${logoHtml()}
        ${navHtml('side-btn')}
        <div class="side-sep"></div>
        <div class="side-section-label">Ferramentas</div>
        <button class="side-btn" id="sideSound">${soundEnabled ? '🔊 Som ativo' : '🔇 Mudo'}</button>
        <button class="side-btn" id="sideTheme">🎨 Tema</button>
        <button class="side-btn" id="sideExport">📥 Exportar</button>
        <button class="side-btn" id="sideImport">📤 Importar</button>
        <button class="side-btn" id="sideKeys">⌨ Atalhos</button>
        <div class="side-sep"></div>
        <div style="padding:0.5rem 0.9rem;font-size:0.82rem;color:var(--mut)">
          👤 <strong style="color:var(--ink)">${esc(me.email.split('@')[0])}</strong><br>
          <span style="font-size:0.75rem">${esc(me.email)}</span>
        </div>
        <button class="side-btn" id="sideOut" style="color:#ff7a8c">⏻ Sair</button>
      </aside>
      <main id="main"></main>
      <nav class="nav">${navHtml('nav-btn')}<button class="nav-btn" id="navOut">⏻</button></nav>
    </div>
  `;

  // tab switches
  $$('[data-tab]').forEach(b => b.onclick = () => { currentTab = b.dataset.tab; play('blip'); shell(); });

  // logout
  const handleLogout = async () => { 
    localStorage.removeItem('nexa_token'); 
    await POST('logout', {}); 
    play('trash'); 
    gate(); 
  };
  $('#sideOut').onclick = handleLogout;
  $('#navOut').onclick  = handleLogout;

  // side actions
  $('#sideSound').onclick = () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('nexa_sound', soundEnabled ? '1' : '0');
    $('#sideSound').textContent = soundEnabled ? '🔊 Som ativo' : '🔇 Mudo';
    if (soundEnabled) play('complete');
  };
  $('#sideTheme').onclick = () => {
    const themes = ['dark', 'light', 'midnight'];
    const cur  = localStorage.getItem('nexa_theme') || 'dark';
    const next = themes[(themes.indexOf(cur) + 1) % themes.length];
    applyTheme(next);
    toast(`Tema: ${next}`, 'success');
    POST('me/preferences', { theme: next });
  };
  $('#sideExport').onclick = () => exportTasks();
  $('#sideImport').onclick = () => importTasks();
  $('#sideKeys').onclick   = () => openShortcuts();

  if (isAdmin) {
    clearInterval(adminPoll);
    adminPoll = setInterval(pollAdmin, 15000);
  }

  if (currentTab === 'admin' && isAdmin) await adminView();
  else await setupDashboard();
}

/* ── DASHBOARD ───────────────────────────────────────── */
async function setupDashboard() {
  const hr       = new Date().getHours();
  const greeting = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';

  currentView = me.preferences?.defaultView || localStorage.getItem('nexa_view') || 'list';

  $('#main').innerHTML = `
    <div id="xpBanner"></div>

    <div class="action-dock">
      <div class="view-switch">
        <button type="button" class="view-btn ${currentView==='list'?'active':''}" id="vList">≡ Lista</button>
        <button type="button" class="view-btn ${currentView==='kanban'?'active':''}" id="vKanban">☷ Kanban</button>
      </div>
      <div class="quick-tools">
        <button class="btn s" id="btnFocus">⏱ Foco [F]</button>
        <button class="btn s" id="btnStandup">📋 Standup [S]</button>
        <button class="btn s" id="btnKeys">⌨ [?]</button>
      </div>
    </div>

    <div class="hero-panel">
      <div>
        <p class="eyebrow">Terminal de Produtividade</p>
        <h1>${greeting}, ${esc(me.name.split(' ')[0])} 👾</h1>
      </div>
      <div class="toolbar-card">
        <div class="search-wrap">
          <span class="search-icon">🔍</span>
          <input id="searchInput" value="${esc(taskQuery)}" placeholder="Buscar tarefa, tag ou categoria… [ / ]" autocomplete="off">
        </div>
        <div class="filter-row" id="filterRow">
          <button type="button" class="filter-btn ${taskFilter==='all'?'active':''}" data-filter="all">Tudo</button>
          <button type="button" class="filter-btn ${taskFilter==='open'?'active':''}" data-filter="open">Abertas <span id="fCountOpen"></span></button>
          <button type="button" class="filter-btn ${taskFilter==='urgent'?'active':''}" data-filter="urgent">Urgentes <span id="fCountUrgent"></span></button>
          <button type="button" class="filter-btn ${taskFilter==='doing'?'active':''}" data-filter="doing">Em foco</button>
          <button type="button" class="filter-btn ${taskFilter==='overdue'?'active':''}" data-filter="overdue">Atrasadas</button>
          <button type="button" class="filter-btn ${taskFilter==='done'?'active':''}" data-filter="done">Concluídas <span id="fCountDone"></span></button>
        </div>
      </div>
    </div>

    <div class="cards">
      <div class="card"><span class="card-value" id="mOpen" data-counter="0">0</span><div class="card-label">Pendentes</div></div>
      <div class="card"><span class="card-value" id="mDoing" data-counter="0">0</span><div class="card-label">Em foco</div></div>
      <div class="card"><span class="card-value" id="mUrgent" data-counter="0">0</span><div class="card-label">Urgentes</div></div>
      <div class="card"><span class="card-value" id="mDone" data-counter="0">0</span><div class="card-label">Concluídas</div></div>
    </div>

    <div class="add-form-card">
      <h3>+ Nova Tarefa</h3>
      <form id="addForm">
        <div class="add-row">
          <input id="nt" placeholder="Título da tarefa… (ou pressione N)" maxlength="200" autocomplete="off" required>
          <button class="btn p" type="submit">Adicionar</button>
        </div>
        <div class="form-meta">
          <select id="addPri" aria-label="Prioridade">${Object.entries(PRI_LABEL).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select>
          <input id="addCat" placeholder="Categoria" maxlength="32">
          <input id="addDue" type="date" aria-label="Prazo">
        </div>
      </form>
    </div>

    <div class="bulk-bar">
      <span class="summary" id="taskSummary"></span>
      <div style="display:flex;gap:0.5rem">
        <button type="button" class="btn s ghost" id="sortBtn">↕ Smart</button>
        <button type="button" class="btn s ghost" id="clearDone">🗑 Limpar concluídas</button>
      </div>
    </div>

    <div id="viewContainer"></div>
    <button class="fab" id="fab" aria-label="Nova tarefa rápida">+</button>
  `;

  // view toggle
  $('#vList').onclick   = () => { currentView = 'list';   localStorage.setItem('nexa_view','list');   $('#vList').classList.add('active');   $('#vKanban').classList.remove('active'); play('blip'); renderTasks(); };
  $('#vKanban').onclick = () => { currentView = 'kanban'; localStorage.setItem('nexa_view','kanban'); $('#vKanban').classList.add('active'); $('#vList').classList.remove('active');   play('blip'); renderTasks(); };

  $('#btnFocus').onclick   = () => openFocus(cachedTasks);
  $('#btnStandup').onclick = () => openStandup(cachedTasks);
  $('#btnKeys').onclick    = () => openShortcuts();

  // filters
  $$('[data-filter]').forEach(b => b.onclick = () => {
    taskFilter = b.dataset.filter;
    $$('[data-filter]').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); play('blip'); renderTasks();
  });

  // search — no debounce to keep responsive
  $('#searchInput').oninput = e => { taskQuery = e.target.value; renderTasks(); };

  // add form
  $('#addForm').onsubmit = async e => {
    e.preventDefault();
    const x = $('#nt').value.trim(); if (!x) return;
    const r = await POST('tasks', {
      x,
      priority: $('#addPri').value,
      category: $('#addCat').value.trim(),
      due: $('#addDue').value
    });
    if (!r.ok) { toast(r.d.error || 'Erro.', 'error'); return; }
    play('blip'); $('#nt').value = ''; await reloadTasks(); $('#nt').focus();
  };

  // sort
  const sortCycle = ['smart', 'priority', 'due', 'alpha'];
  const sortLabels = { smart: '↕ Smart', priority: '↕ Prioridade', due: '↕ Prazo', alpha: '↕ A-Z' };
  $('#sortBtn').onclick = () => {
    sortBy = sortCycle[(sortCycle.indexOf(sortBy) + 1) % sortCycle.length];
    $('#sortBtn').textContent = sortLabels[sortBy]; play('blip');
    cachedTasks.sort((a, b) => {
      const pOrd = { urgent:0, high:1, normal:2, low:3 };
      if (sortBy === 'priority') return (pOrd[a.p]??2) - (pOrd[b.p]??2);
      if (sortBy === 'due') { if (!a.due&&!b.due) return 0; if (!a.due) return 1; if (!b.due) return -1; return a.due.localeCompare(b.due); }
      if (sortBy === 'alpha') return a.x.localeCompare(b.x);
      // smart: done last, pinned first, priority, due, created
      if (a.d !== b.d) return a.d ? 1 : -1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const pa = pOrd[a.p]??2, pb = pOrd[b.p]??2; if (pa !== pb) return pa - pb;
      if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
      if (a.due && !b.due) return -1; if (!a.due && b.due) return 1;
      return b.created - a.created;
    });
    renderTasks();
  };

  // clear done
  $('#clearDone').onclick = async () => {
    const n = cachedTasks.filter(t => t.d).length;
    if (!n) { toast('Nenhuma tarefa concluída.'); return; }
    if (!await ask(`Limpar ${n} tarefa${n>1?'s':''} concluída${n>1?'s':''}?`)) return;
    play('trash');
    await POST('tasks/clear-done', {});
    await reloadTasks();
  };

  // FAB
  $('#fab').onclick = () => { const nt = $('#nt'); if (nt) { nt.focus(); nt.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };

  await reloadTasks();
}

/* ── ADMIN: POLL ─────────────────────────────────────── */
async function pollAdmin() {
  const r = await GET('admin/users'); if (!r.ok) return;
  const n = (r.d.users || []).filter(u => u.status === 'pending').length;
  if (n > pendingCount) { play('streak'); toast(`⚠ ${n} nova(s) solicitação(ões)!`); document.title = `(${n}) NEXA`; }
  else if (!n && !Focus.running) document.title = 'NEXA Daily';
  if (n !== pendingCount) { pendingCount = n; adminData = r.d; if (currentTab === 'admin') adminView(); else shell(); }
  else { pendingCount = n; adminData = r.d; }
}

/* ── ADMIN VIEW ──────────────────────────────────────── */
async function adminView() {
  const r = await GET('admin/users');
  if (!r.ok) { $('#main').innerHTML = '<div class="empty-state"><p>Acesso negado.</p></div>'; return; }
  adminData = r.d;
  const users = r.d.users || [], logs = r.d.logs || [];
  pendingCount = users.filter(u => u.status === 'pending').length;
  const pending  = users.filter(u => u.status === 'pending');
  const rest     = users.filter(u => u.status !== 'pending');
  const matchesAdmin = u => {
    const q = adminQuery.trim().toLowerCase();
    return (!q || [u.name, u.email, u.role].some(v => String(v || '').toLowerCase().includes(q))) &&
      (adminStatus === 'all' || u.status === adminStatus);
  };
  const visiblePending = pending.filter(matchesAdmin);
  const visibleUsers = rest.filter(matchesAdmin);
  const approved = users.filter(u => u.status === 'approved').length;
  const blocked  = users.filter(u => u.status === 'blocked').length;

  const evClass = ev => {
    const s = String(ev||'').toLowerCase();
    if (s.includes('recusad')||s.includes('fail')) return 'fail';
    if (s.includes('kill')) return 'kill';
    if (s.includes('block')) return 'block';
    if (s.includes('approv')||s.includes('approve')) return 'approve';
    if (s.includes('solicit')) return 'req';
    if (s.includes('login')) return 'login';
    return 'default';
  };
  const evLabel = ev => {
    const m = { 'Login':'AUTH_OK','Login recusado':'AUTH_FAIL','Admin: kill':'SESSION_KILL','Admin: block':'USER_BLOCK','Admin: unblock':'USER_UNBLOCK','Admin: approve':'ACCESS_GRANT','Solicitação de acesso':'ACCESS_REQ' };
    return m[ev] || String(ev||'').toUpperCase();
  };

  $('#main').innerHTML = `
    <div class="admin-header">
      <div>
        <p class="eyebrow" style="color:var(--cyan-b)">Security & Core Management</p>
        <h1>Administração</h1>
        <p class="admin-sub">Controle de acessos, sessões e auditoria de segurança.</p>
      </div>
      <button type="button" class="btn ghost" id="refreshAdmin">🔄 Atualizar</button>
    </div>

    <div class="security-strip">
      <div><span class="security-pulse"></span><strong>POSTURA DE SEGURANÇA</strong><small>Controle de acesso ativo · sessões revogáveis · auditoria local</small></div>
      <span class="security-score">${blocked ? 'ATENÇÃO' : 'OPERACIONAL'}</span>
    </div>

    <div class="admin-cards">
      ${[['Pendentes', pendingCount, pendingCount ? 'color:var(--gold)':''], ['Ativos', approved, ''], ['Bloqueados', blocked, blocked?'color:#ff7a8c':''], ['Total tarefas', r.d.totalTasks||0, ''], ['Sessões ativas', r.d.activeSessions||0, '']].map(([l,n,s]) => `
        <div class="admin-card"><b data-counter="${n}" style="${s}">${n}</b><span>${l}</span></div>`).join('')}
    </div>

    <div class="admin-tools">
      <input id="adminSearch" type="search" placeholder="Buscar por nome, e-mail ou papel" value="${esc(adminQuery)}">
      <select id="adminStatus" aria-label="Filtrar usuários por status">
        ${[['all','Todos os status'],['pending','Pendentes'],['approved','Ativos'],['blocked','Bloqueados']].map(([v,l]) => `<option value="${v}" ${adminStatus===v?'selected':''}>${l}</option>`).join('')}
      </select>
    </div>

    <div class="section-title">Solicitações de acesso${visiblePending.length ? ` · <span class="badge">${visiblePending.length}</span>` : ''}</div>
    ${visiblePending.length ? visiblePending.map(u => `
      <div class="req-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.7rem">
          <div>
            <strong style="font-size:1rem">${esc(u.name)}</strong>
            <p style="margin:0.2rem 0;font-size:0.85rem;color:var(--mut)">${esc(u.email)} · ${fmtDt(u.created)}</p>
          </div>
          <div class="acts">
            <button class="btn p s" data-admin-action="approve" data-uid="${u.id}" data-uname="${esc(u.name)}">✔ Liberar</button>
            <button class="btn d s" data-admin-action="deny"    data-uid="${u.id}" data-uname="${esc(u.name)}">✕ Negar</button>
          </div>
        </div>
      </div>`).join('') : `<div class="empty-state" style="margin-bottom:1.2rem"><p>Sem solicitações pendentes</p></div>`}

    <div class="section-title" style="margin-top:1.2rem">Usuários</div>
    <div class="tw">
      <table>
        <thead><tr><th>Usuário</th><th>Papel</th><th>Status</th><th>XP</th><th>Último acesso</th><th>Ações</th></tr></thead>
        <tbody>
          ${visibleUsers.map(u => {
            const initials = (u.name||'U').split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
            const isMe = u.id === me.id;
            const rank = getRank(u.xp||0);
            return `<tr>
              <td><div class="user-row"><div class="avatar">${esc(initials)}</div><div class="user-meta"><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></div></div></td>
              <td><span class="role-tag ${u.role}">${u.role === 'admin' ? '👑 Admin' : '👤 User'}</span></td>
              <td><span class="pill ${u.status}">${u.status === 'approved' ? '● Ativo' : u.status === 'blocked' ? '✕ Bloqueado' : u.status}</span></td>
              <td style="font-size:0.82rem;color:var(--mut)">${rank.title} · ${u.xp||0} XP</td>
              <td style="font-size:0.82rem">${u.last ? fmtDt(u.last) : '—'}</td>
              <td>${isMe ? '<span style="color:var(--mut);font-size:0.8rem">Você</span>' : `
                <div class="acts">
                  <button class="btn s ${u.status==='blocked'?'p':'d'}" data-admin-action="${u.status==='blocked'?'unblock':'block'}" data-uid="${u.id}" data-uname="${esc(u.name)}">${u.status==='blocked'?'🔓':'🔒'}</button>
                  <button class="btn s ghost" data-admin-action="kill" data-uid="${u.id}" data-uname="${esc(u.name)}" title="Encerrar sessões">⚡</button>
                  <button class="btn s ghost" data-admin-action="${u.role==='admin'?'demote':'promote'}" data-uid="${u.id}" data-uname="${esc(u.name)}" title="${u.role==='admin'?'Remover admin':'Promover a admin'}">${u.role==='admin'?'⇩':'⇧'}</button>
                </div>`}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-title" style="margin-top:1.5rem">Audit Log</div>
    <div class="audit-term">
      <div class="term-header">
        <div class="term-dots"><span class="term-dot r"></span><span class="term-dot y"></span><span class="term-dot g"></span></div>
        <div class="term-status"><span class="term-pulse"></span>AUDIT_LOG // SECURITY_DAEMON [${logs.length} EVENTOS]</div>
      </div>
      <div class="term-body">
        ${logs.map(l => `
          <div class="term-row">
            <span class="log-time">${fmtDt(l.t)}</span>
            <span class="log-badge ${evClass(l.ev)}">${esc(evLabel(l.ev))}</span>
            <span class="log-who">${esc(l.who||'sistema')}</span>
            <span class="log-ip">[${esc(l.ip||'127.0.0.1')}]</span>
          </div>`).join('') || '<div style="padding:1.5rem;text-align:center;color:var(--mut)">Sem eventos registrados.</div>'}
      </div>
    </div>
  `;

  const labels = { approve:'Liberar', deny:'Negar', block:'Bloquear', unblock:'Desbloquear', kill:'Encerrar sessões de', promote:'Promover a admin', demote:'Remover admin de' };
  $('#refreshAdmin').onclick = async () => { play('blip'); await adminView(); };
  $('#adminSearch').oninput = e => {
    adminQuery = e.target.value;
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(async () => {
      await adminView();
      const input = $('#adminSearch');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 180);
  };
  $('#adminStatus').onchange = e => { adminStatus = e.target.value; adminView(); };

  $$('[data-admin-action]').forEach(b => b.onclick = async () => {
    const action = b.dataset.adminAction, name = b.dataset.uname;
    if (!await ask(`${labels[action] || action} "${name}"?`)) return;
    play('blip');
    const x = await POST(`admin/users/${b.dataset.uid}/${action}`, {});
    if (x.ok) { play('complete'); toast('Ação executada!', 'success'); }
    else { play('trash'); toast(x.d.error || 'Erro.', 'error'); }
    await adminView();
  });

  countUp();
}

/* ── GLOBAL KEYBOARD SHORTCUTS ───────────────────────── */
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || $('.quick-capture')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;

  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'k') { e.preventDefault(); openQuickCapture(); return; }
  if (e.metaKey && key === 'k') { e.preventDefault(); openQuickCapture(); return; }

  if (key === 'n') { e.preventDefault(); const nt = $('#nt'); if (nt) { nt.focus(); nt.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
  else if (key === '/') { e.preventDefault(); const s = $('#searchInput'); if (s) { s.focus(); s.select(); } }
  else if (key === 'f') { e.preventDefault(); openFocus(cachedTasks); }
  else if (key === 'k') { e.preventDefault(); if (currentView === 'list') { currentView = 'kanban'; $('#vKanban')?.click(); } else { currentView = 'list'; $('#vList')?.click(); } }
  else if (key === 's') { e.preventDefault(); openStandup(cachedTasks); }
  else if (key === 'm') { e.preventDefault(); soundEnabled = !soundEnabled; localStorage.setItem('nexa_sound', soundEnabled ? '1' : '0'); toast(soundEnabled ? '🔊 Som ativado' : '🔇 Mudo'); if (soundEnabled) play('complete'); }
  else if (key === 't') { e.preventDefault(); const themes = ['dark','light','midnight']; const cur = localStorage.getItem('nexa_theme')||'dark'; const next = themes[(themes.indexOf(cur)+1)%themes.length]; applyTheme(next); toast(`Tema: ${next}`, 'success'); POST('me/preferences', {theme:next}); }
  else if (key === '?') { e.preventDefault(); openShortcuts(); }
});

/* ── INIT ────────────────────────────────────────────── */
(async () => {
  const r = await GET('me');
  if (r.ok && r.d.id) {
    me = r.d;
    if (me.preferences?.theme) applyTheme(me.preferences.theme);
    await shell();
    if (me.role === 'admin') pollAdmin();
  } else {
    gate();
  }
})();
