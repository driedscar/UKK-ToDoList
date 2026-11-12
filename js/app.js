(() => {
  'use strict';

  /* =========================================================
     CONSTANTS
     ========================================================= */
  const KEY = 'doit.v3';
  const COLORS = ['#d7f23a', '#f6df6b', '#f2b3dd', '#b9c8ea', '#b9d08a', '#f7b98a', '#cdb8f0'];
  const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
  const PRIO = { low: 'Low', mid: 'Medium', high: 'High' };
  const mq = window.matchMedia('(max-width: 819px)');

  /* =========================================================
     DATE HELPERS (all dates are local "YYYY-MM-DD" strings)
     ========================================================= */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const dow = (d) => (d.getDay() + 6) % 7; // Monday = 0
  const monthStart = (s) => s.slice(0, 8) + '01';
  const weekStart = (s) => addDays(s, -dow(parse(s)));
  const fmtShort = (s) => parse(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fmtLong = (s) => parse(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  function relDay(s) {
    const T = today();
    if (s === T) return 'Today';
    if (s === addDays(T, 1)) return 'Tomorrow';
    if (s === addDays(T, -1)) return 'Yesterday';
    return fmtShort(s);
  }

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  };

  /* =========================================================
     STATE
     ========================================================= */
  let state = load();
  const initialSnap = JSON.stringify(state);
  const ui = {
    query: '', prio: 'all',
    selected: today(), cursor: monthStart(today()),
    agendaDays: 7, expanded: new Set(),
  };

  function seed() {
    // Start with a completely blank workspace. No demo folders, tasks, or activity history.
    return {
      folders: [],
      tasks: [],
      log: {},
      theme: 'light',
      current: 'all',
      view: 'agenda',
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.folders) && Array.isArray(s.tasks)) return Object.assign({ log: {}, theme: 'light', current: 'all', view: 'agenda' }, s);
    } catch (_) {}
    return seed();
  }
  /* =========================================================
     DATABASE LAYER — MySQL doit_db lewat api/index.php
     GET  → ambil seluruh state dari database
     POST → dorong seluruh state; database disamakan dengan app
     ========================================================= */
  const API_CANDIDATES = ['', 'http://localhost:8080', 'http://localhost'];
  let apiBase = null;                 // null = mode offline (localStorage saja)
  let apiWarned = false;
  let syncTimer = null, syncBusy = false, syncQueued = false, lastSynced = '';

  async function resolveApi() {
    for (const base of API_CANDIDATES) {
      try {
        const r = await fetch(base + '/api/index.php', { headers: { Accept: 'application/json' } });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.ok) { apiBase = base; return j; }
      } catch (_) {}
    }
    return null;
  }

  // id dari database berupa angka; app ini bekerja dengan string (dataset DOM) — disamakan di sini.
  function normalizeIds(s) {
    s.folders.forEach((f) => { f.id = String(f.id); });
    s.tasks.forEach((t) => {
      t.id = String(t.id);
      t.folderId = t.folderId == null ? '' : String(t.folderId);
      (t.subtasks || []).forEach((x) => { x.id = String(x.id); });
    });
    if (s.current !== 'all') s.current = String(s.current);
    return s;
  }

  // "log" (jumlah task selesai per hari) diturunkan dari doneOn tiap task.
  function deriveLog() {
    state.log = {};
    for (const t of state.tasks) if (t.doneOn) state.log[t.doneOn] = (state.log[t.doneOn] || 0) + 1;
  }

  function warnOffline() {
    if (apiWarned) return;
    apiWarned = true;
    toast('Database tidak terjangkau — perubahan hanya tersimpan lokal');
  }

  async function runSync() {
    if (apiBase === null) return;
    if (syncBusy) { syncQueued = true; return; }
    const snap = JSON.stringify(state);
    if (snap === lastSynced) return;                     // tidak ada perubahan baru
    syncBusy = true;
    try {
      const r = await fetch(apiBase + '/api/index.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: snap,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.ok && j.state && JSON.stringify(state) === snap) {
        state = normalizeIds(j.state);                   // pakai id resmi dari database
        deriveLog();
        lastSynced = JSON.stringify(state);
        render();
      }
    } catch (_) {
      warnOffline();
    } finally {
      syncBusy = false;
      if (syncQueued) { syncQueued = false; runSync(); }
    }
  }

  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}  // cache offline
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 350);                                    // dorong ke MySQL
  };

  const folderOf = (id) => state.folders.find((f) => f.id === id);
  const taskOf = (id) => state.tasks.find((t) => t.id === id);
  const defaultFolderId = () => (folderOf(state.current) ? state.current : state.folders[0] && state.folders[0].id);

  function setStatus(t, s) {
    if (t.status === s) return;
    const T = today();
    if (s === 'done') {
      t.doneOn = T; state.log[T] = (state.log[T] || 0) + 1;
    } else if (t.status === 'done') {
      const d = t.doneOn || T;
      if (state.log[d] > 0) state.log[d]--;
      t.doneOn = '';
    }
    t.status = s;
  }

  function visibleTasks() {
    const q = ui.query.trim().toLowerCase();
    return state.tasks.filter((t) => {
      if (state.current !== 'all' && t.folderId !== state.current) return false;
      if (ui.prio !== 'all' && t.priority !== ui.prio) return false;
      if (q) {
        const hay = (t.title + ' ' + (t.note || '') + ' ' + (t.subtasks || []).map((s) => s.text).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* =========================================================
     DOM
     ========================================================= */
  const $ = (s, r = document) => r.querySelector(s);
  const el = {
    mini: $('#miniCal'), folders: $('#folders'), weekStrip: $('#weekStrip'),
    greeting: $('#greeting'), subGreeting: $('#subGreeting'),
    search: $('#search'), prioFilter: $('#prioFilter'),
    quickForm: $('#quickAdd'), quickInput: $('#quickInput'),
    folderBar: $('#folderBar'), fbDot: $('#fbDot'), fbName: $('#fbName'),
    vAgenda: $('#viewAgenda'), vBoard: $('#viewBoard'), vMonth: $('#viewMonth'),
    toast: $('#toast'),
    // task dialog
    taskDialog: $('#taskDialog'), taskForm: $('#taskForm'), taskDialogTitle: $('#taskDialogTitle'),
    fTitle: $('#fTitle'), fNote: $('#fNote'), fDate: $('#fDate'), fTime: $('#fTime'),
    fPriority: $('#fPriority'), fStatus: $('#fStatus'), fFolder: $('#fFolder'),
    subList: $('#subList'), subInput: $('#subInput'), deleteTaskBtn: $('#deleteTaskBtn'),
    // folder dialog
    folderDialog: $('#folderDialog'), folderForm: $('#folderForm'),
    folderName: $('#folderName'), swatches: $('#swatches'), folderDialogTitle: $('#folderDialogTitle'),
    // reset confirmation
    resetDialog: $('#resetDialog'),
    // insights
    ringFg: $('#ringFg'), ringNum: $('#ringNum'), ringMsg: $('#ringMsg'),
    tStreak: $('#tStreak'), tOverdue: $('#tOverdue'), tWeek: $('#tWeek'), tOpen: $('#tOpen'),
    bars: $('#bars'), heat: $('#heat'), deltaBadge: $('#deltaBadge'), upNext: $('#upNext'),
  };

  /* =========================================================
     RENDER: left panel
     ========================================================= */
  function renderMini() {
    const c = parse(ui.cursor);
    const y = c.getFullYear(), m = c.getMonth();
    const first = new Date(y, m, 1);
    const start = addDays(ymd(first), -dow(first));
    const T = today();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const dt = parse(d);
      const dots = state.tasks
        .filter((t) => t.date === d && t.status !== 'done').slice(0, 3)
        .map((t) => `<i style="background:${(folderOf(t.folderId) || {}).color || '#999'}"></i>`).join('');
      cells += `<button type="button" class="mc ${dt.getMonth() !== m ? 'out' : ''} ${d === T ? 'today' : ''} ${d === ui.selected ? 'sel' : ''}" data-pick-date="${d}" data-drop-date="${d}" aria-label="${fmtLong(d)}"><span>${dt.getDate()}</span><em>${dots}</em></button>`;
    }
    el.mini.innerHTML = `
      <div class="mini-head">
        <b>${c.toLocaleDateString('en-US', { month: 'long' })} <span>${y}</span></b>
        <div><button type="button" data-nav="-1" aria-label="Previous month">‹</button><button type="button" data-nav="today" aria-label="Today">•</button><button type="button" data-nav="1" aria-label="Next month">›</button></div>
      </div>
      <div class="mini-dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="mini-grid">${cells}</div>`;
  }

  function renderFolders() {
    const open = (fid) => state.tasks.filter((t) => t.status !== 'done' && (fid === 'all' || t.folderId === fid)).length;
    const item = (id, name, color, drop) => `
      <button type="button" class="folder ${state.current === id ? 'active' : ''}" data-folder="${id}" ${drop ? `data-drop-folder="${id}"` : ''} style="--c:${color}">
        <span class="dot"></span><span class="name">${esc(name)}</span><span class="count">${open(id)}</span>
      </button>`;
    el.folders.innerHTML = item('all', 'All tasks', '#d7f23a', false) + state.folders.map((f) => item(f.id, f.name, f.color, true)).join('');
    const opts = state.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    el.fFolder.innerHTML = opts;
  }

  /* =========================================================
     RENDER: top area
     ========================================================= */
  function renderTop() {
    const T = today();
    const h = new Date().getHours();
    el.greeting.textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const left = state.tasks.filter((t) => t.date === T && t.status !== 'done').length;
    const over = state.tasks.filter((t) => t.date && t.date < T && t.status !== 'done').length;
    el.subGreeting.textContent = `${left} task${left === 1 ? '' : 's'} left today${over ? ` · ${over} overdue` : ''}`;
    el.quickInput.placeholder = `Quick add to ${fmtLong(ui.selected)}…`;

    // week strip (mobile)
    const ws = weekStart(ui.selected);
    let strip = `<button type="button" class="arrow" data-pick-date="${addDays(ui.selected, -7)}" aria-label="Previous week">‹</button>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const dots = state.tasks.filter((t) => t.date === d && t.status !== 'done').slice(0, 3)
        .map((t) => `<i style="background:${(folderOf(t.folderId) || {}).color || '#999'}"></i>`).join('');
      strip += `<button type="button" class="wk ${d === ui.selected ? 'sel' : ''} ${d === T ? 'today' : ''}" data-pick-date="${d}" data-drop-date="${d}"><small>${parse(d).toLocaleDateString('en-US', { weekday: 'short' })}</small><b>${parse(d).getDate()}</b><em>${dots}</em></button>`;
    }
    strip += `<button type="button" class="arrow" data-pick-date="${addDays(ui.selected, 7)}" aria-label="Next week">›</button>`;
    el.weekStrip.innerHTML = strip;

    // folder bar
    const cur = folderOf(state.current);
    el.folderBar.hidden = !cur;
    if (cur) { el.fbName.textContent = cur.name; el.fbDot.style.background = cur.color; }

    // tab states
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  }

  /* =========================================================
     TASK CARD
     ========================================================= */
  function card(t, o = {}) {
    const f = folderOf(t.folderId);
    const subs = t.subtasks || [];
    const sd = subs.filter((s) => s.done).length;
    const late = t.status !== 'done' && t.date && t.date < today();
    const open = ui.expanded.has(t.id);
    return `
    <li class="task st-${t.status}" data-id="${t.id}" style="--c:${f ? f.color : '#cfcfc0'}">
      <button type="button" class="handle" aria-label="Drag to move" title="Drag to move">⋮⋮</button>
      <button type="button" class="check" data-action="toggle" aria-label="Toggle done">${ICON.check}</button>
      <div class="t-body">
        <div class="t-top">
          ${t.time ? `<span class="t-time">${t.time}</span>` : ''}
          <p class="t-title">${esc(t.title)}</p>
        </div>
        ${t.note ? `<p class="t-note">${esc(t.note)}</p>` : ''}
        <div class="t-meta">
          ${f ? `<span class="tag folder">${esc(f.name)}</span>` : ''}
          <span class="tag p-${t.priority}">${PRIO[t.priority]}</span>
          ${t.status === 'doing' ? '<span class="tag doing">In progress</span>' : ''}
          ${o.date && t.date ? `<span class="tag due ${late ? 'late' : ''}">${relDay(t.date)}</span>` : ''}
          ${subs.length ? `<button type="button" class="tag subs-chip" data-action="subs">${sd}/${subs.length} subtasks</button>` : ''}
        </div>
        ${subs.length && open ? `<ul class="subs">${subs.map((s) => `<li class="${s.done ? 'done' : ''}"><button type="button" class="sub-check" data-action="subtoggle" data-sub="${s.id}" aria-label="Toggle subtask">${ICON.check}</button><span>${esc(s.text)}</span></li>`).join('')}</ul>` : ''}
      </div>
      <div class="t-actions">
        <button type="button" data-action="edit" aria-label="Edit">${ICON.edit}</button>
        <button type="button" data-action="delete" aria-label="Delete">${ICON.del}</button>
      </div>
    </li>`;
  }

  /* =========================================================
     VIEWS
     ========================================================= */
  function renderAgenda(list) {
    const T = today();
    const overdue = list.filter((t) => t.status !== 'done' && t.date && t.date < T);
    const unsched = list.filter((t) => !t.date);
    let html = '';
    if (overdue.length) {
      html += `<section class="overdue-box"><div class="sec-head"><h2>Overdue</h2><span class="pill-n">${overdue.length}</span></div><ul class="tasks">${overdue.map((t) => card(t, { date: true })).join('')}</ul></section>`;
    }
    for (let i = 0; i < ui.agendaDays; i++) {
      const d = addDays(ui.selected, i);
      const dt = parse(d);
      const items = list.filter((t) => t.date === d);
      html += `
      <section class="day ${d === T ? 'today' : ''}" data-drop-date="${d}">
        <div class="day-head">
          <span class="day-num">${pad(dt.getDate())}</span>
          <div class="day-meta"><b>${dt.toLocaleDateString('en-US', { weekday: 'short' })}</b><small>${dt.toLocaleDateString('en-US', { month: 'short' })}${items.length ? ` · ${items.length} task${items.length > 1 ? 's' : ''}` : ''}</small></div>
        </div>
        <div class="day-body">
          ${items.length ? `<ul class="tasks">${items.map((t) => card(t)).join('')}</ul>` : '<div class="day-empty">Nothing planned yet</div>'}
          <button type="button" class="add-here" data-add-date="${d}">+ Add task</button>
        </div>
      </section>`;
    }
    html += `<button type="button" class="more-days" data-action="more-days">Show next 7 days</button>`;
    html += `
      <section class="unsched" data-drop-date="">
        <div class="sec-head"><h2>Unscheduled</h2><span class="pill-n">${unsched.length}</span></div>
        ${unsched.length ? `<ul class="tasks">${unsched.map((t) => card(t)).join('')}</ul>` : '<div class="day-empty">No loose tasks. Drop one here to remove its date.</div>'}
      </section>`;
    el.vAgenda.innerHTML = html;
  }

  function renderBoard(list) {
    el.vBoard.innerHTML = `<div class="board">` + ['todo', 'doing', 'done'].map((s) => {
      const items = list.filter((t) => t.status === s);
      return `<section class="col col-${s}" data-drop-status="${s}">
        <div class="col-head"><span class="col-dot"></span><h2>${STATUS[s]}</h2><span class="pill-n">${items.length}</span></div>
        ${items.length ? `<ul class="tasks">${items.map((t) => card(t, { date: true })).join('')}</ul>` : '<div class="day-empty">Drop tasks here</div>'}
      </section>`;
    }).join('') + `</div>`;
  }

  function renderMonth(list) {
    const c = parse(ui.cursor);
    const y = c.getFullYear(), m = c.getMonth();
    const first = new Date(y, m, 1);
    const start = addDays(ymd(first), -dow(first));
    const T = today();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const dt = parse(d);
      const items = list.filter((t) => t.date === d);
      const shown = items.slice(0, 3);
      cells += `
      <div class="cell ${dt.getMonth() !== m ? 'out' : ''} ${d === T ? 'today' : ''} ${d === ui.selected ? 'sel' : ''}" data-goto-date="${d}" data-drop-date="${d}">
        <span class="cell-num">${dt.getDate()}</span>
        <div class="cell-items">
          ${shown.map((t) => `<div class="pill ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}" style="--c:${(folderOf(t.folderId) || {}).color || '#cfcfc0'}" title="${esc(t.title)}"><span class="pill-t">${t.time ? t.time + ' ' : ''}${esc(t.title)}</span></div>`).join('')}
          ${items.length > 3 ? `<span class="more">+${items.length - 3} more</span>` : ''}
        </div>
      </div>`;
    }
    el.vMonth.innerHTML = `
      <div class="month-head">
        <h2>${c.toLocaleDateString('en-US', { month: 'long' })} <span>${y}</span></h2>
        <div><button type="button" data-nav="-1" aria-label="Previous month">‹</button><button type="button" data-nav="today">Today</button><button type="button" data-nav="1" aria-label="Next month">›</button></div>
      </div>
      <div class="month-dow">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="month-grid">${cells}</div>`;
  }

  /* =========================================================
     INSIGHTS
     ========================================================= */
  function renderInsights() {
    const T = today();
    const sumLog = (from, to) => { let s = 0; for (let i = from; i <= to; i++) s += state.log[addDays(T, -i)] || 0; return s; };

    // ring
    const todays = state.tasks.filter((t) => t.date === T);
    const done = todays.filter((t) => t.status === 'done').length;
    el.ringNum.textContent = `${done}/${todays.length}`;
    el.ringFg.setAttribute('stroke-dasharray', `${todays.length ? (done / todays.length) * 100 : 0} 100`);
    el.ringMsg.textContent = !todays.length ? 'Nothing scheduled today. Plan something!'
      : done === todays.length ? 'Everything done. Nice work ✦'
      : `${todays.length - done} to go — you've got this.`;

    // tiles
    let streak = 0, d = T;
    if (!(state.log[d] > 0)) d = addDays(d, -1);
    while (state.log[d] > 0) { streak++; d = addDays(d, -1); }
    el.tStreak.textContent = streak;
    el.tOverdue.textContent = state.tasks.filter((t) => t.status !== 'done' && t.date && t.date < T).length;
    const week = sumLog(0, 6), prev = sumLog(7, 13);
    el.tWeek.textContent = week;
    el.tOpen.textContent = state.tasks.filter((t) => t.status !== 'done').length;

    // delta badge
    let delta;
    if (prev === 0) delta = week > 0 ? `+${week}` : '—';
    else { const p = Math.round(((week - prev) / prev) * 100); delta = `${p >= 0 ? '+' : ''}${p}%`; }
    el.deltaBadge.textContent = delta;
    el.deltaBadge.classList.toggle('down', week < prev);

    // bars (last 7 days)
    const days = [];
    for (let i = 6; i >= 0; i--) { const dd = addDays(T, -i); days.push({ d: dd, n: state.log[dd] || 0, today: i === 0 }); }
    const max = Math.max(1, ...days.map((x) => x.n));
    el.bars.innerHTML = days.map((x) => `
      <div class="bar-col ${x.today ? 'today' : ''}" title="${fmtShort(x.d)} · ${x.n} done">
        <em>${x.n}</em><div class="b" style="height:${Math.max(6, (x.n / max) * 80)}%"></div>
        <small>${parse(x.d).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}</small>
      </div>`).join('');

    // heatmap (14 weeks)
    const start = addDays(weekStart(T), -13 * 7);
    let cells = '';
    for (let i = 0; i < 14 * 7; i++) {
      const dd = addDays(start, i);
      const n = state.log[dd] || 0;
      const lvl = n >= 4 ? 4 : n;
      cells += `<i class="hm l${lvl} ${dd > T ? 'future' : ''} ${dd === T ? 'now' : ''}" title="${fmtShort(dd)} · ${n} done"></i>`;
    }
    el.heat.innerHTML = cells;

    // up next
    const next = state.tasks.filter((t) => t.status !== 'done' && t.date)
      .sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99'))).slice(0, 5);
    el.upNext.innerHTML = next.length ? next.map((t) => {
      const late = t.date < T;
      return `<li data-open="${t.id}" style="--c:${(folderOf(t.folderId) || {}).color || '#ccc'}"><b>${esc(t.title)}</b><small class="${late ? 'late' : ''}">${relDay(t.date)}${t.time ? ' · ' + t.time : ''}</small></li>`;
    }).join('') : '<li class="none">You\'re all caught up ✦</li>';
  }

  /* =========================================================
     MASTER RENDER
     ========================================================= */
  function render() {
    document.documentElement.dataset.theme = state.theme;
    const view = state.view === 'stats' && !mq.matches ? 'agenda' : state.view;
    document.body.dataset.screen = view;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

    renderMini(); renderFolders(); renderTop();
    const list = visibleTasks();
    if (view === 'agenda') renderAgenda(list);
    else if (view === 'board') renderBoard(list);
    else if (view === 'month') renderMonth(list);
    renderInsights();
    save();
  }
  mq.addEventListener('change', render);

  /* =========================================================
     TOAST
     ========================================================= */
  let toastTimer;
  function toast(msg, undoFn) {
    clearTimeout(toastTimer);
    el.toast.innerHTML = `<span>${esc(msg)}</span>`;
    if (undoFn) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.onclick = () => { undoFn(); el.toast.hidden = true; };
      el.toast.appendChild(b);
    }
    el.toast.hidden = false;
    toastTimer = setTimeout(() => (el.toast.hidden = true), 4000);
  }

  /* =========================================================
     NAVIGATION HELPERS
     ========================================================= */
  function selectDate(d, goAgenda) {
    ui.selected = d; ui.cursor = monthStart(d); ui.agendaDays = 7;
    if (goAgenda || state.view === 'board' || state.view === 'stats') state.view = 'agenda';
  }
  function shiftMonth(n) {
    const c = parse(ui.cursor); c.setMonth(c.getMonth() + n); ui.cursor = monthStart(ymd(c));
  }

  /* =========================================================
     TASK CRUD
     ========================================================= */
  function removeTask(t) {
    const idx = state.tasks.indexOf(t);
    state.tasks.splice(idx, 1);
    render();
    toast('Task deleted', () => { state.tasks.splice(idx, 0, t); render(); });
  }

  // quick add with mini syntax: "Call mom 18:30 !high #personal"
  function parseQuick(text) {
    let title = text, time = '', priority = 'mid', folderId = defaultFolderId();
    title = title.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, (m, h, mi) => { time = pad(h) + ':' + mi; return ''; });
    title = title.replace(/!(high|med|mid|low|h|m|l)\b/i, (m, p) => {
      p = p.toLowerCase();
      priority = p[0] === 'h' ? 'high' : p[0] === 'l' ? 'low' : 'mid';
      return '';
    });
    title = title.replace(/#([\w-]+)/, (m, name) => {
      const n = name.toLowerCase();
      const f = state.folders.find((x) => x.name.toLowerCase().replace(/\s+/g, '-') === n) || state.folders.find((x) => x.name.toLowerCase().startsWith(n));
      if (f) { folderId = f.id; return ''; }
      return m;
    });
    return { title: title.replace(/\s+/g, ' ').trim(), time, priority, folderId };
  }

  el.quickForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = el.quickInput.value.trim();
    if (!raw) return;
    if (!state.folders.length) { toast('Create a folder first'); return; }
    const p = parseQuick(raw);
    if (!p.title) return;
    state.tasks.push({
      id: uid(), title: p.title, note: '', date: ui.selected, time: p.time, priority: p.priority,
      folderId: p.folderId, status: 'todo', subtasks: [], doneOn: '',
    });
    el.quickInput.value = '';
    render();
    toast(`Added to ${relDay(ui.selected)}`);
    el.quickInput.focus();
  });

  /* ---- task dialog ---- */
  let editingId = null;
  let draftSubs = [];

  function renderSubDraft() {
    el.subList.innerHTML = draftSubs.map((s) => `
      <li class="${s.done ? 'done' : ''}" data-sub="${s.id}">
        <button type="button" class="sub-check" data-subtoggle aria-label="Toggle">${ICON.check}</button>
        <span>${esc(s.text)}</span>
        <button type="button" class="x" data-subremove aria-label="Remove">×</button>
      </li>`).join('');
  }

  function fillDialog(t) {
    el.fTitle.value = t.title; el.fNote.value = t.note || '';
    el.fDate.value = t.date || ''; el.fTime.value = t.time || '';
    el.fPriority.value = t.priority; el.fStatus.value = t.status;
    el.fFolder.value = t.folderId;
    draftSubs = (t.subtasks || []).map((s) => ({ ...s }));
    renderSubDraft();
    el.subInput.value = '';
  }

  function openNew(preset = {}) {
    if (!state.folders.length) {
      toast('Create a folder first');
      openFolderDialog('add');
      return;
    }
    editingId = null;
    el.taskDialogTitle.textContent = 'New task';
    el.deleteTaskBtn.hidden = true;
    fillDialog({
      title: '', note: '', date: preset.date !== undefined ? preset.date : ui.selected, time: '',
      priority: 'mid', status: 'todo', folderId: defaultFolderId(), subtasks: [],
    });
    el.taskDialog.showModal();
    el.fTitle.focus();
  }

  function openTask(id) {
    const t = taskOf(id);
    if (!t) return;
    editingId = id;
    el.taskDialogTitle.textContent = 'Edit task';
    el.deleteTaskBtn.hidden = false;
    fillDialog(t);
    el.taskDialog.showModal();
  }

  function addDraftSub() {
    const text = el.subInput.value.trim();
    if (!text) return;
    draftSubs.push({ id: uid(), text, done: false });
    el.subInput.value = '';
    renderSubDraft();
    el.subInput.focus();
  }
  $('#subAddBtn').addEventListener('click', addDraftSub);
  el.subInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDraftSub(); } });
  el.subList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const s = draftSubs.find((x) => x.id === li.dataset.sub);
    if (e.target.closest('[data-subtoggle]')) s.done = !s.done;
    else if (e.target.closest('[data-subremove]')) draftSubs = draftSubs.filter((x) => x !== s);
    else return;
    renderSubDraft();
  });

  el.taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = el.fTitle.value.trim();
    if (!title) return;
    if (!el.fFolder.value) { toast('Choose or create a folder first'); return; }
    const data = {
      title, note: el.fNote.value.trim(), date: el.fDate.value, time: el.fTime.value,
      priority: el.fPriority.value, folderId: el.fFolder.value,
      subtasks: draftSubs.map((s) => ({ ...s })),
    };
    const status = el.fStatus.value;
    if (editingId) {
      const t = taskOf(editingId);
      Object.assign(t, data);
      setStatus(t, status);
    } else {
      const t = { id: uid(), status: 'todo', doneOn: '', ...data };
      state.tasks.push(t);
      setStatus(t, status);
    }
    el.taskDialog.close();
    render();
  });

  el.deleteTaskBtn.addEventListener('click', () => {
    const t = taskOf(editingId);
    el.taskDialog.close();
    if (t) removeTask(t);
  });

  /* ---- folder dialog ---- */
  let folderMode = 'add';
  let pickedColor = COLORS[0];

  function renderSwatches() {
    el.swatches.innerHTML = COLORS.map((c) => `<button type="button" class="swatch ${c === pickedColor ? 'selected' : ''}" data-color="${c}" style="--c:${c}" aria-label="Color ${c}"></button>`).join('');
  }
  el.swatches.addEventListener('click', (e) => {
    const s = e.target.closest('[data-color]');
    if (!s) return;
    pickedColor = s.dataset.color; renderSwatches();
  });

  function openFolderDialog(mode) {
    folderMode = mode;
    const cur = folderOf(state.current);
    if (mode === 'edit' && cur) {
      el.folderDialogTitle.textContent = 'Edit folder';
      el.folderName.value = cur.name; pickedColor = cur.color;
    } else {
      el.folderDialogTitle.textContent = 'New folder';
      el.folderName.value = ''; pickedColor = COLORS[state.folders.length % COLORS.length];
    }
    renderSwatches();
    el.folderDialog.showModal();
    el.folderName.focus();
  }

  el.folderForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.folderName.value.trim();
    if (!name) return;
    if (folderMode === 'edit') {
      const f = folderOf(state.current);
      if (f) { f.name = name; f.color = pickedColor; }
    } else {
      const f = { id: uid(), name, color: pickedColor };
      state.folders.push(f); state.current = f.id;
    }
    el.folderDialog.close(); render();
  });

  $('#deleteFolderBtn').addEventListener('click', () => {
    const f = folderOf(state.current);
    if (!f) return;
    if (state.folders.length === 1) { toast('You need at least one folder'); return; }
    const n = state.tasks.filter((t) => t.folderId === f.id).length;
    if (!confirm(`Delete folder "${f.name}"${n ? ` and its ${n} task${n > 1 ? 's' : ''}` : ''}?`)) return;
    const backup = JSON.parse(JSON.stringify(state));
    state.tasks = state.tasks.filter((t) => t.folderId !== f.id);
    state.folders = state.folders.filter((x) => x.id !== f.id);
    state.current = 'all';
    render();
    toast('Folder deleted', () => { state = backup; render(); });
  });

  // close dialogs: Cancel buttons + click on backdrop
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });

  /* =========================================================
     GLOBAL CLICK HANDLING (event delegation)
     ========================================================= */
  let suppressClick = false;

  document.addEventListener('click', (e) => {
    const t = e.target;

    const act = t.closest('[data-action]');
    if (act) {
      const name = act.dataset.action;
      if (name === 'more-days') { ui.agendaDays += 7; render(); return; }
      const li = act.closest('.task');
      const task = li && taskOf(li.dataset.id);
      if (!task) return;
      if (name === 'toggle') setStatus(task, task.status === 'done' ? 'todo' : 'done');
      else if (name === 'edit') { openTask(task.id); return; }
      else if (name === 'delete') { removeTask(task); return; }
      else if (name === 'subs') { ui.expanded.has(task.id) ? ui.expanded.delete(task.id) : ui.expanded.add(task.id); }
      else if (name === 'subtoggle') { const s = task.subtasks.find((x) => x.id === act.dataset.sub); if (s) s.done = !s.done; }
      render();
      return;
    }

    const pill = t.closest('.pill');
    if (pill) { if (!suppressClick) openTask(pill.dataset.id); return; }

    const nav = t.closest('[data-nav]');
    if (nav) {
      if (nav.dataset.nav === 'today') { selectDate(today(), false); } else shiftMonth(Number(nav.dataset.nav));
      render(); return;
    }

    const pick = t.closest('[data-pick-date]');
    if (pick) { selectDate(pick.dataset.pickDate, false); render(); return; }

    const go = t.closest('[data-goto-date]');
    if (go) { selectDate(go.dataset.gotoDate, true); render(); return; }

    const add = t.closest('[data-add-date]');
    if (add) { openNew({ date: add.dataset.addDate }); return; }

    const fol = t.closest('[data-folder]');
    if (fol) { state.current = fol.dataset.folder; render(); return; }

    const vw = t.closest('[data-view]');
    if (vw) { state.view = vw.dataset.view; render(); window.scrollTo({ top: 0 }); return; }

    const op = t.closest('[data-open]');
    if (op) { openTask(op.dataset.open); return; }
  });

  $('#newBtn').addEventListener('click', () => openNew());
  $('#fab').addEventListener('click', () => openNew());
  $('#addFolderBtn').addEventListener('click', () => openFolderDialog('add'));
  $('#editFolderBtn').addEventListener('click', () => openFolderDialog('edit'));
  $('#themeBtn').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; render(); });
  $('#resetBtn').addEventListener('click', () => {
    el.resetDialog.showModal();
  });
  $('#confirmResetBtn').addEventListener('click', () => {
    el.resetDialog.close();
    localStorage.removeItem(KEY);
    state = seed();
    ui.selected = today(); ui.cursor = monthStart(today()); ui.agendaDays = 7;
    render();
  });
  el.search.addEventListener('input', () => { ui.query = el.search.value; render(); });
  el.prioFilter.addEventListener('change', () => { ui.prio = el.prioFilter.value; render(); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); el.search.focus(); }
    else if (e.key === 'n') { e.preventDefault(); openNew(); }
    else if (e.key === 't') { selectDate(today(), false); render(); }
  });

  /* =========================================================
     DRAG & DROP (mouse + touch, via pointer events)
     Sources : .handle on a task card, or a .pill in the month grid
     Targets : [data-drop-folder] [data-drop-date] [data-drop-status] and other cards (reorder)
     ========================================================= */
  function targetAt(x, y, dragId) {
    const under = document.elementFromPoint(x, y);
    if (!under) return null;
    const f = under.closest('[data-drop-folder]');
    if (f) return { kind: 'folder', el: f, id: f.dataset.dropFolder };
    const cardEl = under.closest('.task');
    if (cardEl) {
      if (cardEl.dataset.id === dragId) return null;
      const r = cardEl.getBoundingClientRect();
      return {
        kind: 'card', el: cardEl, id: cardEl.dataset.id, after: y > r.top + r.height / 2,
        zone: cardEl.closest('[data-drop-date],[data-drop-status]'),
      };
    }
    const zone = under.closest('[data-drop-date],[data-drop-status]');
    if (zone) return { kind: 'zone', el: zone, zone };
    return null;
  }

  function applyDrop(id, target) {
    const t = taskOf(id);
    if (!t || !target) return;
    if (target.kind === 'folder') {
      t.folderId = target.id;
      toast(`Moved to ${folderOf(target.id).name}`);
      return;
    }
    const z = target.zone;
    if (z) {
      if ('dropDate' in z.dataset) {
        t.date = z.dataset.dropDate;
        toast(t.date ? `Moved to ${relDay(t.date)}` : 'Date removed');
      } else if ('dropStatus' in z.dataset) {
        setStatus(t, z.dataset.dropStatus);
        toast(`Moved to ${STATUS[z.dataset.dropStatus]}`);
      }
    }
    state.tasks = state.tasks.filter((x) => x !== t);
    if (target.kind === 'card') {
      let idx = state.tasks.findIndex((x) => x.id === target.id);
      if (target.after) idx++;
      state.tasks.splice(idx, 0, t);
    } else {
      state.tasks.push(t);
    }
  }

  document.addEventListener('pointerdown', (e) => {
    const src = e.target.closest('.handle, .pill');
    if (!src) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const isHandle = src.classList.contains('handle');
    const dragEl = isHandle ? src.closest('.task') : src;
    const id = dragEl.dataset.id;
    const startX = e.clientX, startY = e.clientY;
    let started = false, ghost = null, offX = 0, offY = 0, target = null;
    if (isHandle) e.preventDefault();

    const clearMarks = () => document.querySelectorAll('.drop-before,.drop-after,.drop-over')
      .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-over'));

    const begin = () => {
      started = true;
      const r = dragEl.getBoundingClientRect();
      offX = startX - r.left; offY = startY - r.top;
      ghost = dragEl.cloneNode(true);
      ghost.classList.add('ghost');
      ghost.style.width = r.width + 'px';
      ghost.style.left = r.left + 'px';
      ghost.style.top = r.top + 'px';
      document.body.appendChild(ghost);
      dragEl.classList.add('dragging');
      document.body.classList.add('is-dragging');
    };

    const onMove = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        begin();
      }
      ghost.style.left = ev.clientX - offX + 'px';
      ghost.style.top = ev.clientY - offY + 'px';

      // auto-scroll page and board
      const edge = 70;
      if (ev.clientY < edge) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 14);
      const board = document.querySelector('.board');
      if (board && mq.matches) {
        if (ev.clientX < 40) board.scrollBy(-14, 0);
        else if (ev.clientX > window.innerWidth - 40) board.scrollBy(14, 0);
      }

      clearMarks();
      target = targetAt(ev.clientX, ev.clientY, id);
      if (!target) return;
      if (target.kind === 'card') target.el.classList.add(target.after ? 'drop-after' : 'drop-before');
      else target.el.classList.add('drop-over');
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!started) return;
      ghost.remove(); clearMarks();
      dragEl.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      suppressClick = true; setTimeout(() => (suppressClick = false), 80);
      applyDrop(id, target);
      render();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  /* =========================================================
     INIT
     ========================================================= */
  // Safety net: never let a stray form submission navigate/reload the page.
  document.addEventListener('submit', (e) => e.preventDefault());

  if (state.current !== 'all' && !folderOf(state.current)) state.current = 'all';
  render();

  // Backup sekali isi localStorage lama (sebelum tersambung ke database).
  function backupLocalOnce() {
    try {
      if (localStorage.getItem(KEY + '.pre-db')) return;
      if (state.folders.length || state.tasks.length) {
        localStorage.setItem(KEY + '.pre-db', JSON.stringify(state));
      }
    } catch (_) {}
  }

  // Sambungkan ke database saat halaman dibuka.
  (async () => {
    const j = await resolveApi();
    if (!j || !j.state) { warnOffline(); return; }
    const fresh = normalizeIds(j.state);
    const localEmpty = !state.folders.length && !state.tasks.length;
    const serverEmpty = !fresh.folders.length && !fresh.tasks.length;
    const localTouched = JSON.stringify(state) !== initialSnap;

    if (localEmpty || (!localTouched && !serverEmpty)) {
      // ambil data dari database (database = sumber kebenaran)
      backupLocalOnce();
      state = fresh;
      deriveLog();
      lastSynced = JSON.stringify(state);
      if (state.current !== 'all' && !folderOf(state.current)) state.current = 'all';
      render();
    } else {
      // ada data lokal yang belum ada di database → dorong ke database
      runSync();
    }
  })();
})();
