/**
 * Self-contained HTML template for the MCP Apps triage list, served from the
 * ui://omnifocus/triage.html resource and rendered by MCP Apps hosts in a
 * sandboxed iframe alongside the triage_tasks tool result.
 *
 * Unlike the read-only stats dashboard, this app talks BACK to the server:
 * row interactions (complete, flag, defer) issue app -> host JSON-RPC
 * requests with method "tools/call" targeting the ordinary update_task tool,
 * so the triage_tasks tool itself stays read-only. Request/response
 * correlation reuses the same incrementing-id + promise-map bridge the stats
 * dashboard hand-rolls; see stats-dashboard.ts for why the official App class
 * is not bundled (size budget under a strict CSP).
 *
 * All mutations are optimistic: the row updates immediately, each control is
 * disabled while its call is in flight (max one in-flight action per task),
 * and a failed call reverts the row and surfaces an inline toast.
 *
 * NOTE: this string is embedded as a template literal, so its contents must
 * never contain a backtick or the sequence "$" + "{" — the inline script uses
 * string concatenation instead of template literals for that reason.
 */
export const TRIAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniFocus triage</title>
<style>
  :root {
    --bg: transparent;
    --card: #f5f5f4;
    --card-border: rgba(0, 0, 0, 0.07);
    --text: #1c1917;
    --muted: #78716c;
    --accent: #6366f1;
    --chip: rgba(99, 102, 241, 0.1);
    --ok: #16a34a;
    --warn: #d97706;
    --bad: #dc2626;
    --skel: rgba(0, 0, 0, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --card: #26242b;
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #e7e5e4;
      --muted: #a8a29e;
      --accent: #818cf8;
      --chip: rgba(129, 140, 248, 0.16);
      --ok: #4ade80;
      --warn: #fbbf24;
      --bad: #f87171;
      --skel: rgba(255, 255, 255, 0.1);
    }
  }
  :root[data-theme="dark"] {
    --card: #26242b;
    --card-border: rgba(255, 255, 255, 0.08);
    --text: #e7e5e4;
    --muted: #a8a29e;
    --accent: #818cf8;
    --chip: rgba(129, 140, 248, 0.16);
    --ok: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --skel: rgba(255, 255, 255, 0.1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h1 .count { font-weight: 400; color: var(--muted); font-size: 12px; }
  .filter-chip {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--chip);
    border-radius: 99px;
    padding: 2px 8px;
  }
  .list {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-top: 1px solid var(--card-border);
    min-width: 0;
  }
  .row:first-child { border-top: none; }
  .row .main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 6px;
  }
  .row .name { overflow-wrap: anywhere; }
  .row.done .name { text-decoration: line-through; color: var(--muted); }
  .chip {
    font-size: 10px;
    border-radius: 99px;
    padding: 1px 7px;
    white-space: nowrap;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip.project { background: var(--chip); color: var(--accent); }
  .chip.tag { background: var(--skel); color: var(--muted); }
  .chip.deferred { background: var(--skel); color: var(--muted); font-style: italic; }
  .due {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .due.overdue { color: var(--bad); font-weight: 600; }
  input[type="checkbox"] {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
    margin: 0;
    flex: none;
  }
  .star {
    background: none;
    border: none;
    padding: 0 2px;
    font-size: 15px;
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    flex: none;
  }
  .star.on { color: var(--warn); }
  .btn {
    font: inherit;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--card-border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
    flex: none;
  }
  .btn:hover:not(:disabled), .star:hover:not(:disabled) { color: var(--text); }
  .star.on:hover:not(:disabled) { color: var(--warn); }
  button:disabled, input:disabled { opacity: 0.45; cursor: default; }
  .row.leaving { opacity: 0; }
  @media (prefers-reduced-motion: no-preference) {
    .row { transition: opacity 0.35s ease; }
  }
  .empty { color: var(--muted); font-size: 12px; padding: 14px 12px; }
  .error {
    background: var(--card);
    border: 1px solid var(--bad);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--bad);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  #toast {
    position: fixed;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    max-width: 90%;
    background: var(--card);
    border: 1px solid var(--bad);
    color: var(--bad);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 12px;
    opacity: 0;
    pointer-events: none;
    overflow-wrap: anywhere;
  }
  #toast.show { opacity: 1; }
  @media (prefers-reduced-motion: no-preference) {
    #toast { transition: opacity 0.2s ease; }
  }
  .skel { background: var(--skel); border-radius: 4px; height: 14px; }
  .skel.w40 { width: 40%; }
  .skel.w20 { width: 20%; }
  @media (prefers-reduced-motion: no-preference) {
    .skel { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  }
</style>
</head>
<body>
<main id="root" aria-busy="true"></main>
<div id="toast" role="alert" aria-live="assertive"></div>
<script>
(function () {
  'use strict';

  var root = document.getElementById('root');
  var toastEl = document.getElementById('toast');
  var motionOk = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  var DAY_MS = 86400000;

  // Widget state, populated from the triage_tasks tool result.
  var state = { filter: '', total: 0, tasks: [] };

  // ---------- rendering helpers (DOM-built; no innerHTML with data) ----------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // Find a rendered row by task id without a CSS selector (ids may contain
  // characters that would need escaping in an attribute selector).
  function findRowEl(id) {
    var rows = root.querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-task-id') === id) return rows[i];
    }
    return null;
  }

  function fmtDue(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  var toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 4000);
  }

  // ---------- skeleton / error / empty ----------

  function renderSkeleton() {
    root.setAttribute('aria-busy', 'true');
    root.textContent = '';
    var heading = el('h1', null, 'Triage');
    heading.appendChild(el('span', 'count', 'loading\\u2026'));
    root.appendChild(heading);
    var list = el('div', 'list');
    for (var i = 0; i < 5; i++) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'skel w40'));
      row.appendChild(el('div', 'skel w20'));
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  function renderError(message) {
    root.setAttribute('aria-busy', 'false');
    root.textContent = '';
    root.appendChild(el('h1', null, 'Triage'));
    root.appendChild(el('div', 'error', message));
  }

  // ---------- row actions (optimistic; one in-flight call per task) ----------

  function callUpdateTask(task, args) {
    var payload = { idOrName: task.id };
    for (var key in args) payload[key] = args[key];
    return request('tools/call', { name: 'update_task', arguments: payload })
      .then(function (result) {
        if (result && result.isError) {
          var detail = 'update_task failed';
          try {
            var body = JSON.parse(result.content[0].text);
            if (body && body.error && body.error.detail) detail = body.error.detail;
          } catch (_e) { /* keep generic message */ }
          throw new Error(detail);
        }
        return result;
      });
  }

  // Whether a task still belongs in the active filter given its current
  // (optimistic) state. Completion is handled separately (always leaves); this
  // covers the mutations that can push a row out of its filter: unflagging on
  // the "flagged" filter, and deferring into the future on "actionable".
  function matchesFilter(task) {
    if (task.completed) return false;
    switch (state.filter) {
      case 'flagged':
        return !!task.flagged;
      case 'actionable':
        // A future defer date makes the task non-actionable until then.
        return !(task.deferredTo && new Date(task.deferredTo).getTime() > Date.now());
      default:
        // inbox / search membership is unaffected by flag or defer edits.
        return true;
    }
  }

  // Fade a row out, then drop it from the list. Decrements the running total so
  // the header's "N of total" stays honest as rows leave (see renderApp).
  function retireRow(task) {
    task.leaving = true;
    function drop() {
      task.removed = true;
      if (state.total > 0) state.total -= 1;
      renderApp();
    }
    if (!motionOk) {
      drop();
      return;
    }
    // The row currently in the DOM was painted at opacity 1. Force a reflow,
    // then add .leaving on the next frame so the CSS opacity transition runs
    // instead of the row snapping to 0.
    var row = findRowEl(task.id);
    if (!row) {
      drop();
      return;
    }
    void row.getBoundingClientRect();
    requestAnimationFrame(function () {
      row.classList.add('leaving');
      setTimeout(drop, 380);
    });
  }

  // Re-evaluate a row after a successful non-completion mutation: if it no
  // longer matches the active filter, retire it; otherwise just re-render.
  function settleRow(task) {
    task.pending = null;
    if (matchesFilter(task)) renderApp();
    else retireRow(task);
  }

  function completeTask(task) {
    if (task.pending) return;
    task.pending = 'complete';
    task.completed = true;
    renderApp();
    callUpdateTask(task, { completed: true }).then(function () {
      task.pending = null;
      // Fade the row out after the call resolves, then drop it from the list.
      retireRow(task);
    }).catch(function (err) {
      task.pending = null;
      task.completed = false;
      renderApp();
      toast('Could not complete "' + task.name + '": ' + err.message);
    });
  }

  function toggleFlag(task) {
    if (task.pending) return;
    var next = !task.flagged;
    task.pending = 'flag';
    task.flagged = next;
    renderApp();
    callUpdateTask(task, { flagged: next }).then(function () {
      settleRow(task);
    }).catch(function (err) {
      task.pending = null;
      task.flagged = !next;
      renderApp();
      toast('Could not update flag on "' + task.name + '": ' + err.message);
    });
  }

  function deferTask(task, days) {
    if (task.pending) return;
    var iso = new Date(Date.now() + days * DAY_MS).toISOString();
    task.pending = 'defer';
    task.deferredTo = iso;
    renderApp();
    callUpdateTask(task, { defer: iso }).then(function () {
      settleRow(task);
    }).catch(function (err) {
      task.pending = null;
      task.deferredTo = null;
      renderApp();
      toast('Could not defer "' + task.name + '": ' + err.message);
    });
  }

  // ---------- main render ----------

  function buildRow(task) {
    // Deliberately built WITHOUT the .leaving class even while leaving: the row
    // must first paint at opacity 1 so adding .leaving on a later frame drives
    // the opacity transition. retireRow adds the class post-render.
    var row = el('div', 'row' + (task.completed ? ' done' : ''));
    row.setAttribute('data-task-id', task.id);
    var busy = !!task.pending;

    var check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = task.completed;
    check.disabled = busy || task.completed;
    check.setAttribute('aria-label', 'Complete "' + task.name + '"');
    check.addEventListener('change', function () { completeTask(task); });
    row.appendChild(check);

    var main = el('div', 'main');
    main.appendChild(el('span', 'name', task.name));
    if (task.project) main.appendChild(el('span', 'chip project', task.project));
    task.tags.forEach(function (tag) {
      main.appendChild(el('span', 'chip tag', tag));
    });
    if (task.deferredTo) {
      main.appendChild(el('span', 'chip deferred', 'deferred \\u2192 ' + fmtDue(task.deferredTo)));
    }
    row.appendChild(main);

    if (task.due) {
      var overdue = new Date(task.due).getTime() < Date.now();
      var due = el('span', 'due' + (overdue ? ' overdue' : ''), fmtDue(task.due));
      due.title = task.due;
      row.appendChild(due);
    }

    var star = el('button', 'star' + (task.flagged ? ' on' : ''), task.flagged ? '\\u2605' : '\\u2606');
    star.type = 'button';
    star.disabled = busy;
    star.setAttribute('aria-pressed', task.flagged ? 'true' : 'false');
    star.setAttribute('aria-label', (task.flagged ? 'Unflag' : 'Flag') + ' "' + task.name + '"');
    star.addEventListener('click', function () { toggleFlag(task); });
    row.appendChild(star);

    [{ label: '+1d', days: 1 }, { label: '+1w', days: 7 }].forEach(function (opt) {
      var btn = el('button', 'btn defer-' + opt.label.slice(1), opt.label);
      btn.type = 'button';
      btn.disabled = busy;
      btn.setAttribute('aria-label', 'Defer "' + task.name + '" by ' + (opt.days === 1 ? 'one day' : 'one week'));
      btn.addEventListener('click', function () { deferTask(task, opt.days); });
      row.appendChild(btn);
    });

    return row;
  }

  function renderApp() {
    root.setAttribute('aria-busy', 'false');
    root.textContent = '';
    var visible = state.tasks.filter(function (t) { return !t.removed; });

    var heading = el('h1', null, 'Triage');
    heading.appendChild(el('span', 'count', visible.length + ' of ' + state.total + ' tasks'));
    if (state.filter) heading.appendChild(el('span', 'filter-chip', state.filter));
    root.appendChild(heading);

    if (visible.length === 0) {
      var empty = el('div', 'list');
      empty.appendChild(el('div', 'empty', 'Nothing to triage \\u2014 no tasks match this filter.'));
      root.appendChild(empty);
      reportSize();
      return;
    }

    var list = el('div', 'list');
    visible.forEach(function (task) { list.appendChild(buildRow(task)); });
    root.appendChild(list);
    reportSize();
  }

  function onToolResult(result) {
    if (!result) return;
    if (result.isError) {
      var detail = 'The triage_tasks tool reported an error.';
      try {
        var body = JSON.parse(result.content[0].text);
        if (body && body.error && body.error.detail) detail = body.error.detail;
      } catch (_e) { /* keep generic message */ }
      renderError(detail);
      reportSize();
      return;
    }
    var data = result.structuredContent;
    if (!data) {
      // Fallback for hosts that only forward the text content block.
      try {
        data = JSON.parse(result.content[0].text);
      } catch (_e) {
        renderError('No data received from the triage_tasks tool.');
        reportSize();
        return;
      }
    }
    state.filter = data.filter == null ? '' : String(data.filter);
    state.total = typeof data.total === 'number' ? data.total : (data.tasks || []).length;
    state.tasks = (Array.isArray(data.tasks) ? data.tasks : []).map(function (t) {
      return {
        id: String(t.id),
        name: t.name == null ? '' : String(t.name),
        project: t.project == null ? null : String(t.project),
        tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
        due: t.effectiveDue || t.due || null,
        flagged: !!t.flagged,
        completed: !!t.completed,
        deferredTo: null,
        pending: null,
        leaving: false,
        removed: false
      };
    });
    renderApp();
  }

  // ---------- theme ----------

  function applyHostContext(ctx) {
    if (ctx && (ctx.theme === 'dark' || ctx.theme === 'light')) {
      document.documentElement.setAttribute('data-theme', ctx.theme);
    }
  }

  // ---------- minimal MCP Apps client (postMessage JSON-RPC 2.0) ----------
  // Same hand-rolled bridge as the stats dashboard, plus outbound
  // "tools/call" requests correlated through the pending-promise map.

  var pending = {};
  var nextId = 1;

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }

  function notify(method, params) {
    post({ jsonrpc: '2.0', method: method, params: params || {} });
  }

  function reportSize() {
    notify('ui/notifications/size-changed', {
      height: Math.ceil(document.documentElement.getBoundingClientRect().height)
    });
  }

  window.addEventListener('message', function (event) {
    // Only trust messages from our embedding host. The host origin is opaque
    // (srcdoc/sandboxed iframes report a null/"*" origin) so an origin check is
    // unreliable, but the source window is not spoofable: reject anything that
    // did not come from window.parent. This matters because the widget issues
    // update_task MUTATIONS in response to host messages.
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      var handler = pending[msg.id];
      if (handler) {
        delete pending[msg.id];
        if (msg.error) handler.reject(new Error(msg.error.message || 'Request failed'));
        else handler.resolve(msg.result);
      }
      return;
    }
    // Notifications from the host.
    if (msg.id === undefined) {
      if (msg.method === 'ui/notifications/tool-result') onToolResult(msg.params);
      else if (msg.method === 'ui/notifications/host-context-changed') applyHostContext(msg.params);
      return;
    }
    // Requests from the host.
    if (msg.method === 'ping' || msg.method === 'ui/resource-teardown') {
      post({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      post({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found: ' + msg.method }
      });
    }
  });

  renderSkeleton();

  request('ui/initialize', {
    appInfo: { name: 'omnifocus-triage', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26'
  }).then(function (result) {
    if (result && result.hostContext) applyHostContext(result.hostContext);
    notify('ui/notifications/initialized', {});
    reportSize();
  }).catch(function () {
    // Host rejected the handshake; leave the skeleton with a hint.
    renderError('Could not connect to the host application.');
  });
})();
</script>
</body>
</html>
`;
