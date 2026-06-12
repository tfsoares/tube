// ─── State ──────────────────────────────────────────────────────────────────
let captures = [];
let selectedIndex = -1;

// ─── Wails runtime helpers ──────────────────────────────────────────────────
const App = window['go']?.['main']?.['App'];
let Ready = false;

function init() {
  if (!App) { setTimeout(init, 100); return; }
  Ready = true;

  // Listen for events from Go
  window['runtime']?.EventsOn?.('traffic', (entry) => {
    captures.unshift(entry);
    if (captures.length > 200) captures.length = 200;
    renderTraffic();
  });

  window['runtime']?.EventsOn?.('routes-changed', (routes) => {
    renderRoutes(routes);
  });

  window['runtime']?.EventsOn?.('tunnel-changed', (status) => {
    renderTunnels(status);
  });

  refresh();
}

// ─── Refresh ────────────────────────────────────────────────────────────────
async function refresh() {
  if (!Ready) return;
  try {
    const status = await App.GetStatus();
    if (status) {
      document.getElementById('status-text').textContent = 'Engine: connected';
      document.getElementById('status-traffic').textContent = status.trafficCount + ' requests';
      if (status.routes) renderRoutes(status.routes);
      if (status.tunnel) renderTunnels(status.tunnel);

      // Load traffic
      const traffic = await App.GetTraffic();
      if (traffic) {
        captures = traffic.reverse();
        renderTraffic();
      }
    }
  } catch (e) {
    document.getElementById('status-text').textContent = 'Engine: disconnected';
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────
function renderRoutes(routes) {
  const el = document.getElementById('routes-list');
  if (!routes || routes.length === 0) {
    el.innerHTML = '<div class="empty-state">No active routes</div>';
    return;
  }
  el.innerHTML = routes.map(r =>
    `<div class="route-item"><span class="list-item" style="flex:1;margin:0;padding:2px 0"><span class="dot"></span><span class="url">${esc(r.localUrl || 'https://' + r.hostname)}</span></span><button class="remove-btn" onclick="removeRoute('${esc(r.hostname)}')" title="Remove">✕</button></div>`
  ).join('');
}

async function startApp() {
  if (!Ready) return;
  const name = document.getElementById('app-name').value.trim();
  const cmd = document.getElementById('app-cmd').value.trim();
  if (!name || !cmd) return;
  try {
    await App.StartApp(name, cmd);
    document.getElementById('app-name').value = '';
    document.getElementById('app-cmd').value = '';
    setTimeout(refresh, 500);
  } catch (e) {
    console.error('startApp error:', e);
  }
}

async function removeRoute(hostname) {
  if (!Ready) return;
  try {
    await App.RemoveRoute(hostname);
    setTimeout(refresh, 500);
  } catch (e) {
    console.error('removeRoute error:', e);
  }
}

// ─── Traffic table ──────────────────────────────────────────────────────────
function renderTraffic() {
  const tbody = document.getElementById('traffic-tbody');
  const empty = document.getElementById('traffic-empty');

  if (captures.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  const recent = captures.slice(0, 100);

  tbody.innerHTML = recent.map((c, i) => {
    const method = c.method || 'GET';
    const statusClass = statusCat(c.statusCode);
    return `
      <tr class="${i === selectedIndex ? 'selected' : ''}" onclick="selectCapture(${i})">
        <td><span class="method-badge method-${method}">${esc(method)}</span></td>
        <td>${esc(c.path || '/')}</td>
        <td class="${statusClass}">${c.statusCode || '…'}</td>
        <td>${c.duration ? c.duration + 'ms' : '…'}</td>
      </tr>`;
  }).join('');
}

function selectCapture(i) {
  selectedIndex = i;
  renderTraffic();
  renderDetail(captures[i]);
}

function renderDetail(c) {
  const el = document.getElementById('detail-panel');
  if (!c) {
    el.innerHTML = '<div class="empty-state">Select a request to inspect</div>';
    return;
  }
  el.innerHTML = `
    <div class="detail-row"><span class="detail-key">Method:</span><span class="detail-val">${esc(c.method || 'GET')} ${esc(c.path || '/')}</span></div>
    <div class="detail-row"><span class="detail-key">Host:</span><span class="detail-val">${esc(c.host || '')}</span></div>
    <div class="detail-row"><span class="detail-key">Status:</span><span class="detail-val">${c.statusCode || '…'}</span></div>
    <div class="detail-row"><span class="detail-key">Duration:</span><span class="detail-val">${c.duration ? c.duration + 'ms' : '…'}</span></div>
    ${c.requestBody ? `<div class="detail-body"><strong>Request:</strong>\n${esc(c.requestBody)}</div>` : ''}
    ${c.responseBody ? `<div class="detail-body"><strong>Response:</strong>\n${esc(c.responseBody)}</div>` : ''}
  `;
}

async function clearTraffic() {
  captures = [];
  selectedIndex = -1;
  renderTraffic();
  renderDetail(null);
  if (Ready) {
    try { await App.ClearTraffic(); } catch {}
  }
}

// ─── Tunnels ────────────────────────────────────────────────────────────────
const tunnelState = { ngrok: false, tailscale: false, funnel: false };

function renderTunnels(status) {
  const el = document.getElementById('tunnels-list');
  const urls = status.URLs || {};

  const items = [];
  if (status.Ngrok) items.push(`<div class="list-item"><span class="dot" style="background:#40c057"></span>ngrok<span class="spacer"></span></div>${urls.ngrok ? '<div class="tunnel-url">' + esc(urls.ngrok) + '</div>' : ''}`);
  if (status.Tailscale) items.push(`<div class="list-item"><span class="dot" style="background:#40c057"></span>tailscale<span class="spacer"></span></div>${urls.tailscale ? '<div class="tunnel-url">' + esc(urls.tailscale) + '</div>' : ''}`);
  if (status.Funnel) items.push(`<div class="list-item"><span class="dot" style="background:#40c057"></span>cloudflare<span class="spacer"></span></div>${urls.funnel ? '<div class="tunnel-url">' + esc(urls.funnel) + '</div>' : ''}`);

  if (items.length === 0) {
    el.innerHTML = '<div class="empty-state">No active tunnels</div>';
  } else {
    el.innerHTML = items.join('');
  }

  // Update button states
  tunnelState.ngrok = status.Ngrok;
  tunnelState.tailscale = status.Tailscale;
  tunnelState.funnel = status.Funnel;
  updateTunnelButtons();
}

function updateTunnelButtons() {
  for (const t of ['ngrok', 'tailscale', 'funnel']) {
    const btn = document.getElementById('btn-' + t);
    if (btn) {
      btn.classList.toggle('active', tunnelState[t]);
    }
  }
}

async function toggleTunnel(typ) {
  if (!Ready) return;
  try {
    if (tunnelState[typ]) {
      await App.StopTunnel(typ);
    } else {
      await App.StartTunnel(typ);
    }
  } catch (e) {
    console.error('tunnel error:', e);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusCat(code) {
  const c = code || 0;
  if (c >= 200 && c < 300) return 'status-2xx';
  if (c >= 300 && c < 400) return 'status-3xx';
  if (c >= 400 && c < 500) return 'status-4xx';
  if (c >= 500) return 'status-5xx';
  return '';
}

// ─── Init ───────────────────────────────────────────────────────────────────
init();
