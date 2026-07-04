/**
 * Self-contained HTML template for the MCP Apps stats dashboard, served from
 * the ui://omnifocus/stats-dashboard.html resource and rendered by MCP Apps
 * hosts in a sandboxed iframe alongside the get_stats_dashboard tool result.
 *
 * Kept as a TS string constant (rather than an .html asset) so the template
 * ships inside the tsup bundle with no extra build step, and typecheck /
 * vitest / bun test all see it without loader configuration.
 *
 * The iframe side hand-rolls the MCP Apps postMessage JSON-RPC handshake
 * (spec 2026-01-26) instead of bundling the official App class from
 * "@modelcontextprotocol/ext-apps": that class transitively pulls in zod v4
 * and the MCP SDK protocol machinery (~302 KB minified), which would blow the
 * size budget for an inlined, CSP-restricted template. The subset implemented
 * here — ui/initialize, ui/notifications/initialized, tool-result and
 * host-context-changed notifications, ping/resource-teardown replies — is the
 * complete surface this read-only dashboard needs.
 *
 * NOTE: this string is embedded as a template literal, so its contents must
 * never contain a backtick or the sequence "${" — the inline script uses
 * string concatenation instead of template literals for that reason.
 */
export const STATS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OmniFocus stats</title>
<style>
  :root {
    --bg: transparent;
    --card: #f5f5f4;
    --card-border: rgba(0, 0, 0, 0.07);
    --text: #1c1917;
    --muted: #78716c;
    --accent: #6366f1;
    --bar: #6366f1;
    --bar-track: rgba(99, 102, 241, 0.12);
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
      --bar: #818cf8;
      --bar-track: rgba(129, 140, 248, 0.16);
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
    --bar: #818cf8;
    --bar-track: rgba(129, 140, 248, 0.16);
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
    align-items: baseline;
    gap: 8px;
  }
  h1 small { font-weight: 400; color: var(--muted); font-size: 11px; }
  h2 {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 8px 10px;
    min-width: 0;
  }
  .card .num {
    font-size: 20px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .card .lbl { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .card .sub { color: var(--muted); font-size: 10px; margin-top: 2px; }
  .num.ok { color: var(--ok); }
  .num.warn { color: var(--warn); }
  .num.bad { color: var(--bad); }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 8px;
  }
  .panel {
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 10px 12px;
    min-width: 0;
  }
  .panel svg { display: block; width: 100%; height: auto; }
  .empty { color: var(--muted); font-size: 12px; padding: 12px 0; }
  .error {
    background: var(--card);
    border: 1px solid var(--bad);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--bad);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .skel {
    background: var(--skel);
    border-radius: 4px;
    height: 20px;
  }
  .skel.short { width: 60%; height: 12px; margin-top: 6px; }
  .skel.tall { height: 120px; }
  @media (prefers-reduced-motion: no-preference) {
    .skel { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  }
</style>
</head>
<body>
<main id="root" aria-busy="true"></main>
<script>
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var root = document.getElementById('root');

  // ---------- rendering helpers (DOM-built; no innerHTML with data) ----------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function num(value) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(n) ? n : null;
  }

  function fmt(value) {
    var n = num(value);
    return n === null ? '–' : n.toLocaleString();
  }

  function card(label, value, opts) {
    var box = el('div', 'card');
    var numEl = el('div', 'num' + (opts && opts.tone ? ' ' + opts.tone : ''), value);
    box.appendChild(numEl);
    box.appendChild(el('div', 'lbl', label));
    if (opts && opts.sub) box.appendChild(el('div', 'sub', opts.sub));
    return box;
  }

  // ---------- skeleton ----------

  function renderSkeleton() {
    root.setAttribute('aria-busy', 'true');
    root.textContent = '';
    root.appendChild(el('h1', null, 'OmniFocus stats'));
    var cards = el('div', 'cards');
    for (var i = 0; i < 8; i++) {
      var c = el('div', 'card');
      c.appendChild(el('div', 'skel'));
      c.appendChild(el('div', 'skel short'));
      cards.appendChild(c);
    }
    root.appendChild(cards);
    var charts = el('div', 'charts');
    for (var j = 0; j < 2; j++) {
      var p = el('div', 'panel');
      p.appendChild(el('div', 'skel short'));
      p.appendChild(el('div', 'skel tall'));
      charts.appendChild(p);
    }
    root.appendChild(charts);
  }

  // ---------- charts ----------

  function statusBarChart(projects) {
    var groups = [
      { label: 'Active', value: num(projects.activeProjects) || 0, color: 'var(--ok)' },
      { label: 'On hold', value: num(projects.onHoldProjects) || 0, color: 'var(--warn)' },
      { label: 'Done', value: num(projects.doneProjects) || 0, color: 'var(--accent)' },
      { label: 'Dropped', value: num(projects.droppedProjects) || 0, color: 'var(--muted)' }
    ];
    var width = 320;
    var height = 150;
    var baseline = height - 24;
    var chartTop = 18;
    var max = 1;
    groups.forEach(function (g) { if (g.value > max) max = g.value; });
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': 'Projects by status'
    });
    var slot = width / groups.length;
    var barWidth = 44;
    groups.forEach(function (g, i) {
      var barHeight = Math.round((g.value / max) * (baseline - chartTop));
      if (g.value > 0 && barHeight < 2) barHeight = 2;
      var x = Math.round(i * slot + (slot - barWidth) / 2);
      var y = baseline - barHeight;
      svg.appendChild(svgEl('rect', {
        x: x, y: chartTop, width: barWidth, height: baseline - chartTop,
        rx: 4, fill: 'var(--bar-track)'
      }));
      if (barHeight > 0) {
        svg.appendChild(svgEl('rect', {
          x: x, y: y, width: barWidth, height: barHeight, rx: 4, fill: g.color
        }));
      }
      var count = svgEl('text', {
        x: x + barWidth / 2, y: y - 5, 'text-anchor': 'middle',
        'font-size': '11', 'font-weight': '600', fill: 'var(--text)'
      });
      count.textContent = fmt(g.value);
      svg.appendChild(count);
      var label = svgEl('text', {
        x: x + barWidth / 2, y: baseline + 15, 'text-anchor': 'middle',
        'font-size': '10', fill: 'var(--muted)'
      });
      label.textContent = g.label;
      svg.appendChild(label);
    });
    return svg;
  }

  function tagBarChart(tags) {
    var rows = [];
    (Array.isArray(tags) ? tags : []).forEach(function (t) {
      if (!t) return;
      var count = num(t.taskCount);
      var name = t.name == null ? '' : String(t.name);
      if (count !== null && name) rows.push({ name: name, count: count });
    });
    rows.sort(function (a, b) { return b.count - a.count; });
    rows = rows.slice(0, 10);
    if (rows.length === 0) return el('div', 'empty', 'No tagged tasks yet.');
    var rowHeight = 21;
    var width = 320;
    var labelWidth = 108;
    var countWidth = 34;
    var barMax = width - labelWidth - countWidth;
    var height = rows.length * rowHeight;
    var max = rows[0].count || 1;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': 'Top tags by task count'
    });
    rows.forEach(function (row, i) {
      var y = i * rowHeight;
      var mid = y + rowHeight / 2;
      var label = svgEl('text', {
        x: labelWidth - 8, y: mid + 3.5, 'text-anchor': 'end',
        'font-size': '11', fill: 'var(--text)'
      });
      var display = row.name.length > 16 ? row.name.slice(0, 15) + '\\u2026' : row.name;
      label.textContent = display;
      var full = svgEl('title', {});
      full.textContent = row.name;
      label.appendChild(full);
      svg.appendChild(label);
      svg.appendChild(svgEl('rect', {
        x: labelWidth, y: y + 4, width: barMax, height: rowHeight - 8,
        rx: 3, fill: 'var(--bar-track)'
      }));
      var w = Math.max(2, Math.round((row.count / max) * barMax));
      svg.appendChild(svgEl('rect', {
        x: labelWidth, y: y + 4, width: w, height: rowHeight - 8,
        rx: 3, fill: 'var(--bar)'
      }));
      var count = svgEl('text', {
        x: labelWidth + w + 5, y: mid + 3.5, 'font-size': '10',
        fill: 'var(--muted)', 'font-variant-numeric': 'tabular-nums'
      });
      count.textContent = fmt(row.count);
      svg.appendChild(count);
    });
    return svg;
  }

  // ---------- main render ----------

  function renderData(data) {
    var tasks = (data && data.tasks) || {};
    var projects = (data && data.projects) || {};
    var tags = (data && data.tags) || {};
    root.setAttribute('aria-busy', 'false');
    root.textContent = '';

    var heading = el('h1', null, 'OmniFocus stats');
    heading.appendChild(el('small', null, 'tasks, projects and tags at a glance'));
    root.appendChild(heading);

    var overdue = num(tasks.overdueActiveTasks);
    var flagged = num(tasks.flaggedTasks);
    var rate = num(tasks.completionRate);
    var cards = el('div', 'cards');
    cards.appendChild(card('Total tasks', fmt(tasks.totalTasks)));
    cards.appendChild(card('Available', fmt(tasks.activeTasks)));
    cards.appendChild(card('Completed', fmt(tasks.completedTasks), { tone: 'ok' }));
    cards.appendChild(card('Flagged', fmt(tasks.flaggedTasks), {
      tone: flagged !== null && flagged > 0 ? 'warn' : undefined
    }));
    cards.appendChild(card('Overdue', fmt(tasks.overdueActiveTasks), {
      tone: overdue !== null && overdue > 0 ? 'bad' : 'ok'
    }));
    cards.appendChild(card('Completion', rate === null ? '–' : fmt(rate) + '%'));
    cards.appendChild(card('Projects', fmt(projects.totalProjects), {
      sub: fmt(projects.activeProjects) + ' active · ' + fmt(projects.onHoldProjects) + ' on hold'
    }));
    cards.appendChild(card('Tags', fmt(tags.totalTags), {
      sub: fmt(tags.tagsWithTasks) + ' in use'
    }));
    root.appendChild(cards);

    var charts = el('div', 'charts');
    var projectPanel = el('div', 'panel');
    projectPanel.appendChild(el('h2', null, 'Projects by status'));
    projectPanel.appendChild(statusBarChart(projects));
    charts.appendChild(projectPanel);
    var tagPanel = el('div', 'panel');
    tagPanel.appendChild(el('h2', null, 'Top tags'));
    tagPanel.appendChild(tagBarChart(tags.mostUsedTags));
    charts.appendChild(tagPanel);
    root.appendChild(charts);
  }

  function renderError(message) {
    root.setAttribute('aria-busy', 'false');
    root.textContent = '';
    root.appendChild(el('h1', null, 'OmniFocus stats'));
    root.appendChild(el('div', 'error', message));
  }

  // ---------- theme ----------

  function applyHostContext(ctx) {
    if (ctx && (ctx.theme === 'dark' || ctx.theme === 'light')) {
      document.documentElement.setAttribute('data-theme', ctx.theme);
    }
  }

  // ---------- minimal MCP Apps client (postMessage JSON-RPC 2.0) ----------

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

  function onToolResult(result) {
    if (!result) return;
    if (result.isError) {
      var detail = 'The stats tools reported an error.';
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
        renderError('No data received from the stats dashboard tool.');
        reportSize();
        return;
      }
    }
    renderData(data);
    reportSize();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      var handler = pending[msg.id];
      if (handler) {
        delete pending[msg.id];
        if (msg.error) handler.reject(msg.error);
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
    appInfo: { name: 'omnifocus-stats-dashboard', version: '1.0.0' },
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
