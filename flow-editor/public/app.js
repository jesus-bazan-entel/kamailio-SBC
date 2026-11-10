'use strict';

/* =====================================================================
 *  Kamailio Flow Editor - frontend
 *  Editor de nodos drag-and-drop que compila a rutas de Kamailio.
 * ===================================================================== */

// ---------- catalogo de nodos ----------

const EDGE_COLORS = { out: '#4ea1ff', true: '#3ecf8e', false: '#ff6b6b' };

const NODE_DEFS = [
  {
    group: 'Inicio',
    items: [
      { type: 'start', label: 'Inicio', icon: '▶', fields: [], once: true },
    ],
  },
  {
    group: 'Condiciones',
    items: [
      {
        type: 'condition', subtype: 'prefix', label: 'Prefijo destino', icon: '🔢',
        fields: [{ key: 'value', label: 'El número marcado empieza por', def: '00' }],
        summary: (p) => `$rU empieza por "${p.value || '?'}"`,
      },
      {
        type: 'condition', subtype: 'regex', label: 'Regex destino', icon: '✳',
        fields: [{ key: 'value', label: 'Expresión regular sobre $rU', def: '^51[0-9]{9}$' }],
        summary: (p) => `$rU =~ ${p.value || '?'}`,
      },
      {
        type: 'condition', subtype: 'srcip', label: 'IP de origen', icon: '🌐',
        fields: [{ key: 'value', label: 'IP de origen exacta', def: '10.0.0.1' }],
        summary: (p) => `origen = ${p.value || '?'}`,
      },
      {
        type: 'condition', subtype: 'method', label: 'Método SIP', icon: '📨',
        fields: [{ key: 'value', label: 'Método (ej. INVITE|MESSAGE)', def: 'INVITE' }],
        summary: (p) => `método ${p.value || '?'}`,
      },
      {
        type: 'condition', subtype: 'time', label: 'Franja horaria', icon: '🕒',
        fields: [
          { key: 'from', label: 'Desde la hora (0-23)', def: 8, type: 'number' },
          { key: 'to', label: 'Hasta la hora (1-24)', def: 20, type: 'number' },
        ],
        summary: (p) => `entre ${p.from ?? '?'}:00 y ${p.to ?? '?'}:00`,
      },
      {
        type: 'condition', subtype: 'header', label: 'Cabecera SIP', icon: '🏷',
        fields: [
          { key: 'name', label: 'Nombre de cabecera', def: 'X-Cliente' },
          { key: 'value', label: 'Valor (regex, vacío = solo presencia)', def: '' },
        ],
        summary: (p) => `${p.name || '?'}: ${p.value || '(presente)'}`,
      },
    ],
  },
  {
    group: 'Acciones',
    items: [
      {
        type: 'action', subtype: 'strip', label: 'Quitar dígitos', icon: '✂',
        fields: [{ key: 'count', label: 'Dígitos a quitar del inicio', def: 2, type: 'number' }],
        summary: (p) => `strip(${p.count ?? '?'})`,
      },
      {
        type: 'action', subtype: 'prepend', label: 'Añadir prefijo', icon: '➕',
        fields: [{ key: 'value', label: 'Prefijo a anteponer', def: '51' }],
        summary: (p) => `prefijo "${p.value || '?'}"`,
      },
      {
        type: 'action', subtype: 'set_user', label: 'Cambiar usuario', icon: '👤',
        fields: [{ key: 'value', label: 'Nuevo usuario destino ($rU)', def: '' }],
        summary: (p) => `$rU = "${p.value || '?'}"`,
      },
      {
        type: 'action', subtype: 'set_domain', label: 'Cambiar dominio', icon: '🏠',
        fields: [{ key: 'value', label: 'Nuevo dominio destino ($rd)', def: '' }],
        summary: (p) => `$rd = "${p.value || '?'}"`,
      },
      {
        type: 'action', subtype: 'add_header', label: 'Añadir cabecera', icon: '📎',
        fields: [
          { key: 'name', label: 'Nombre de cabecera', def: 'X-Ruta' },
          { key: 'value', label: 'Valor', def: 'flow' },
        ],
        summary: (p) => `${p.name || '?'}: ${p.value || ''}`,
      },
      {
        type: 'action', subtype: 'log', label: 'Registrar en log', icon: '📝',
        fields: [{ key: 'value', label: 'Mensaje', def: 'paso por nodo' }],
        summary: (p) => `log: ${p.value || ''}`,
      },
    ],
  },
  {
    group: 'Destinos (terminales)',
    items: [
      {
        type: 'dispatcher', label: 'Balanceador', icon: '⚖',
        fields: [
          { key: 'setid', label: 'Grupo (dispatcher.list)', def: 1, type: 'number' },
          {
            key: 'algorithm', label: 'Algoritmo', def: '4', type: 'select',
            options: [
              ['4', 'Round-robin'], ['0', 'Hash Call-ID'], ['1', 'Hash From'],
              ['2', 'Hash To'], ['3', 'Hash R-URI'], ['6', 'Aleatorio'],
              ['8', 'Primero disponible'], ['9', 'Por peso (weight)'],
              ['10', 'Por uso (least loaded)'], ['11', 'Peso relativo (rweight)'],
              ['12', 'Paralelo (forking)'],
            ],
          },
        ],
        summary: (p) => `grupo ${p.setid ?? '?'} · alg ${p.algorithm ?? '4'}`,
      },
      {
        type: 'forward', label: 'Reenviar a host', icon: '📤',
        fields: [
          { key: 'host', label: 'Host o IP', def: '10.0.0.10' },
          { key: 'port', label: 'Puerto', def: 5060, type: 'number' },
          {
            key: 'transport', label: 'Transporte', def: 'udp', type: 'select',
            options: [['udp', 'UDP'], ['tcp', 'TCP'], ['tls', 'TLS']],
          },
        ],
        summary: (p) => `sip:${p.host || '?'}:${p.port || 5060}`,
      },
      {
        type: 'reject', label: 'Rechazar', icon: '⛔',
        fields: [
          { key: 'code', label: 'Código SIP (300-699)', def: 403, type: 'number' },
          { key: 'reason', label: 'Motivo', def: 'Forbidden' },
        ],
        summary: (p) => `${p.code || 403} ${p.reason || ''}`,
      },
    ],
  },
];

function defFor(node) {
  for (const g of NODE_DEFS) {
    for (const d of g.items) {
      if (d.type === node.type && (d.subtype || null) === (node.subtype || null)) return d;
    }
  }
  return null;
}

function outPorts(node) {
  if (node.type === 'condition') return ['true', 'false'];
  if (node.type === 'start' || node.type === 'action') return ['out'];
  return [];
}

// ---------- estado ----------

let flow = { name: 'default', nodes: [], edges: [] };
let selectedNode = null;
let selectedEdge = null;
let dragging = null;     // { id, dx, dy }
let connecting = null;   // { from, port }
let dirty = false;
let simHighlight = null; // { nodes:Set, edges:Set, end }

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const nodesEl = $('nodes');
const edgesEl = $('edges');

// ---------- utilidades ----------

function toast(msg, kind = '', ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function canvasPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function nodeById(id) {
  return flow.nodes.find((n) => n.id === id);
}

function markDirty() {
  dirty = true;
  $('btn-save').textContent = '💾 Guardar *';
}

function clearDirty() {
  dirty = false;
  $('btn-save').textContent = '💾 Guardar';
}

// ---------- render ----------

function render() {
  nodesEl.innerHTML = '';
  for (const n of flow.nodes) {
    const def = defFor(n) || { icon: '❓', label: n.type, fields: [] };
    const el = document.createElement('div');
    let simCls = '';
    if (simHighlight && simHighlight.nodes.has(n.id)) {
      simCls = simHighlight.end === n.id ? ' sim-end' : ' sim-path';
    }
    el.className = `node t-${n.type}` + (selectedNode === n.id ? ' selected' : '') + simCls;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.dataset.id = n.id;

    const head = document.createElement('div');
    head.className = 'node-head';
    head.textContent = `${def.icon} ${n.label || def.label}`;
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'node-body';
    body.textContent = def.summary ? def.summary(n.params || {}) : '';
    el.appendChild(body);

    if (n.type !== 'start') {
      const pin = document.createElement('div');
      pin.className = 'port in';
      pin.dataset.node = n.id;
      el.appendChild(pin);
    }

    const ports = outPorts(n);
    ports.forEach((p, i) => {
      const top = ports.length === 1 ? 50 : 32 + i * 36;
      const pout = document.createElement('div');
      pout.className = 'port out';
      pout.style.top = `${top}%`;
      pout.style.transform = 'translateY(-50%)';
      pout.style.borderColor = EDGE_COLORS[p] || EDGE_COLORS.out;
      pout.dataset.node = n.id;
      pout.dataset.port = p;
      el.appendChild(pout);
      if (ports.length > 1) {
        const lbl = document.createElement('div');
        lbl.className = 'port-label';
        lbl.style.top = `${top}%`;
        lbl.textContent = p === 'true' ? 'sí' : 'no';
        el.appendChild(lbl);
      }
    });

    nodesEl.appendChild(el);
  }
  renderEdges();
  renderProps();
}

function portPos(nodeId, port) {
  const sel = port
    ? `.node[data-id="${CSS.escape(nodeId)}"] .port.out[data-port="${CSS.escape(port)}"]`
    : `.node[data-id="${CSS.escape(nodeId)}"] .port.in`;
  const el = nodesEl.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
}

function edgePath(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderEdges() {
  edgesEl.innerHTML = '';
  flow.edges.forEach((e, idx) => {
    const a = portPos(e.from, e.fromPort || 'out');
    const b = portPos(e.to, null);
    if (!a || !b) return;
    const d = edgePath(a, b);

    const edgeKey = `${e.from}::${e.fromPort || 'out'}::${e.to}`;
    const simCls = simHighlight && simHighlight.edges.has(edgeKey) ? ' sim-path' : '';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge' + (selectedEdge === idx ? ' selected' : '') + simCls);
    path.setAttribute('stroke', EDGE_COLORS[e.fromPort || 'out'] || EDGE_COLORS.out);
    edgesEl.appendChild(path);

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.idx = idx;
    edgesEl.appendChild(hit);
  });
}

function renderTempEdge(toPoint) {
  edgesEl.querySelectorAll('path.temp').forEach((p) => p.remove());
  if (!connecting || !toPoint) return;
  const a = portPos(connecting.from, connecting.port);
  if (!a) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', edgePath(a, toPoint));
  path.setAttribute('class', 'temp');
  edgesEl.appendChild(path);
}

// ---------- panel de propiedades ----------

function renderProps() {
  const body = $('props-body');
  const actions = $('props-actions');
  actions.innerHTML = '';

  if (selectedEdge != null) {
    const e = flow.edges[selectedEdge];
    body.className = '';
    body.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'props-empty';
    const from = nodeById(e.from); const to = nodeById(e.to);
    info.textContent = `Conexión: ${from?.label || e.from} [${e.fromPort || 'out'}] → ${to?.label || e.to}`;
    body.appendChild(info);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '🗑 Eliminar conexión (Supr)';
    del.onclick = deleteSelection;
    actions.appendChild(del);
    return;
  }

  const n = selectedNode && nodeById(selectedNode);
  if (!n) {
    body.className = 'props-empty';
    body.textContent = 'Selecciona un nodo para editar sus parámetros.';
    return;
  }

  const def = defFor(n) || { fields: [] };
  body.className = '';
  body.innerHTML = '';

  const mkField = (labelText, inputEl) => {
    const wrap = document.createElement('div');
    wrap.className = 'prop-field';
    const lab = document.createElement('label');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(inputEl);
    body.appendChild(wrap);
  };

  const nameInput = document.createElement('input');
  nameInput.value = n.label || '';
  nameInput.oninput = () => { n.label = nameInput.value; markDirty(); renderNodeOnly(n); };
  mkField('Nombre del nodo', nameInput);

  for (const f of def.fields) {
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [val, text] of f.options) {
        const o = document.createElement('option');
        o.value = val; o.textContent = text;
        input.appendChild(o);
      }
      input.value = String(n.params?.[f.key] ?? f.def);
    } else {
      input = document.createElement('input');
      if (f.type === 'number') input.type = 'number';
      input.value = n.params?.[f.key] ?? f.def;
    }
    input.oninput = () => {
      n.params = n.params || {};
      n.params[f.key] = f.type === 'number' ? Number(input.value) : input.value;
      markDirty();
      renderNodeOnly(n);
    };
    mkField(f.label, input);
  }

  if (n.type !== 'start') {
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '🗑 Eliminar nodo (Supr)';
    del.onclick = deleteSelection;
    actions.appendChild(del);
  }
}

// refresco ligero del cuerpo del nodo sin perder el foco del formulario
function renderNodeOnly(n) {
  const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
  if (!el) return;
  const def = defFor(n) || {};
  el.querySelector('.node-head').textContent = `${def.icon || '❓'} ${n.label || def.label || n.type}`;
  el.querySelector('.node-body').textContent = def.summary ? def.summary(n.params || {}) : '';
}

// ---------- edicion ----------

let nodeSeq = 1;
function addNode(def) {
  if (def.once && flow.nodes.some((n) => n.type === def.type)) {
    toast('El flujo ya tiene un nodo Inicio', 'error');
    return;
  }
  let id;
  do { id = `n${Date.now().toString(36)}_${nodeSeq++}`; } while (nodeById(id));
  const params = {};
  for (const f of def.fields) params[f.key] = f.def;
  const vp = $('viewport');
  flow.nodes.push({
    id,
    type: def.type,
    subtype: def.subtype,
    label: def.label,
    x: vp.scrollLeft + 120 + Math.random() * 80,
    y: vp.scrollTop + 120 + Math.random() * 80,
    params,
  });
  selectedNode = id;
  selectedEdge = null;
  markDirty();
  render();
}

function clearSimHighlight() {
  if (!simHighlight) return;
  simHighlight = null;
  $('sim-result').className = '';
  $('sim-result').textContent = '';
  $('sim-steps').innerHTML = '';
  render();
}

function deleteSelection() {
  clearSimHighlight();
  if (selectedEdge != null) {
    flow.edges.splice(selectedEdge, 1);
    selectedEdge = null;
    markDirty();
    render();
    return;
  }
  const n = selectedNode && nodeById(selectedNode);
  if (!n) return;
  if (n.type === 'start') { toast('El nodo Inicio no se puede eliminar', 'error'); return; }
  flow.nodes = flow.nodes.filter((x) => x.id !== n.id);
  flow.edges = flow.edges.filter((e) => e.from !== n.id && e.to !== n.id);
  selectedNode = null;
  markDirty();
  render();
}

function addEdge(from, fromPort, to) {
  if (from === to) return;
  clearSimHighlight();
  // un solo cable por puerto de salida: reemplazar el existente
  flow.edges = flow.edges.filter((e) => !(e.from === from && (e.fromPort || 'out') === fromPort));
  flow.edges.push({ from, fromPort, to });
  markDirty();
  render();
}

// ---------- eventos de raton ----------

nodesEl.addEventListener('mousedown', (ev) => {
  const port = ev.target.closest('.port.out');
  if (port) {
    connecting = { from: port.dataset.node, port: port.dataset.port };
    ev.preventDefault();
    return;
  }
  const nodeEl = ev.target.closest('.node');
  if (!nodeEl) return;
  selectedNode = nodeEl.dataset.id;
  selectedEdge = null;
  const n = nodeById(selectedNode);
  const p = canvasPoint(ev);
  dragging = { id: n.id, dx: p.x - n.x, dy: p.y - n.y };
  render();
});

document.addEventListener('mousemove', (ev) => {
  if (dragging) {
    const n = nodeById(dragging.id);
    const p = canvasPoint(ev);
    n.x = Math.max(0, p.x - dragging.dx);
    n.y = Math.max(0, p.y - dragging.dy);
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
    if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
    renderEdges();
    markDirty();
  } else if (connecting) {
    renderTempEdge(canvasPoint(ev));
  }
});

document.addEventListener('mouseup', (ev) => {
  if (connecting) {
    const pin = ev.target.closest('.port.in');
    if (pin) addEdge(connecting.from, connecting.port, pin.dataset.node);
    connecting = null;
    edgesEl.querySelectorAll('path.temp').forEach((p) => p.remove());
  }
  dragging = null;
});

edgesEl.addEventListener('mousedown', (ev) => {
  const hit = ev.target.closest('.edge-hit');
  if (!hit) return;
  selectedEdge = Number(hit.dataset.idx);
  selectedNode = null;
  render();
});

canvas.addEventListener('mousedown', (ev) => {
  if (ev.target === canvas || ev.target === edgesEl) {
    selectedNode = null;
    selectedEdge = null;
    render();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  ev.preventDefault();
  deleteSelection();
});

// ---------- API ----------

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok && !data.errors) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

async function loadFlowList(selectName) {
  const data = await api('GET', '/api/flows');
  const sel = $('flow-select');
  sel.innerHTML = '';
  const names = data.flows.length ? data.flows : ['default'];
  for (const name of names) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
  sel.value = selectName && names.includes(selectName) ? selectName : names[0];
}

async function loadFlow(name) {
  try {
    flow = await api('GET', `/api/flows/${name}`);
  } catch {
    flow = {
      name,
      nodes: [{ id: 'start', type: 'start', label: 'Inicio', x: 80, y: 200, params: {} }],
      edges: [],
    };
  }
  flow.nodes = flow.nodes || [];
  flow.edges = flow.edges || [];
  selectedNode = null;
  selectedEdge = null;
  simHighlight = null;
  clearDirty();
  render();
}

async function saveFlow() {
  await api('PUT', `/api/flows/${flow.name}`, flow);
  clearDirty();
  toast(`Flujo "${flow.name}" guardado`, 'ok');
}

function showErrors(result) {
  const lines = [...(result.errors || []).map((e) => `✖ ${e}`), ...(result.warnings || []).map((w) => `⚠ ${w}`)];
  $('modal-title').textContent = 'Problemas en el flujo';
  $('modal-content').textContent = lines.join('\n');
  $('modal').classList.remove('hidden');
}

// ---------- botones ----------

$('flow-select').onchange = async (ev) => {
  if (dirty && !confirm('Hay cambios sin guardar. ¿Descartar?')) {
    ev.target.value = flow.name;
    return;
  }
  await loadFlow(ev.target.value);
};

$('btn-new').onclick = async () => {
  const name = prompt('Nombre del nuevo flujo (letras, números, - y _):');
  if (!name) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { toast('Nombre inválido', 'error'); return; }
  flow = {
    name,
    nodes: [{ id: 'start', type: 'start', label: 'Inicio', x: 80, y: 200, params: {} }],
    edges: [],
  };
  await api('PUT', `/api/flows/${name}`, flow);
  await loadFlowList(name);
  await loadFlow(name);
  toast(`Flujo "${name}" creado`, 'ok');
};

$('btn-save').onclick = () => saveFlow().catch((e) => toast(e.message, 'error'));

$('btn-preview').onclick = async () => {
  const result = await api('POST', '/api/compile', flow);
  if (result.errors && result.errors.length) { showErrors(result); return; }
  $('modal-title').textContent = 'Configuración Kamailio generada';
  $('modal-content').textContent =
    (result.warnings || []).map((w) => `# ⚠ ${w}\n`).join('') + result.cfg;
  $('modal').classList.remove('hidden');
};

$('btn-deploy').onclick = async () => {
  const result = await api('POST', '/api/compile', flow);
  if (result.errors && result.errors.length) { showErrors(result); return; }
  if (!confirm(`Desplegar el flujo "${flow.name}" en Kamailio?\nSe guardará y Kamailio se reiniciará con la nueva lógica.`)) return;
  try {
    await saveFlow();
    const dep = await api('POST', `/api/deploy/${flow.name}`);
    if (dep.errors && dep.errors.length) { showErrors(dep); return; }
    toast('🚀 Desplegado. Kamailio aplicará el cambio en unos segundos.', 'ok', 6000);
  } catch (e) {
    toast(`Error al desplegar: ${e.message}`, 'error');
  }
};

$('modal-close').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (ev) => { if (ev.target.id === 'modal') $('modal').classList.add('hidden'); };

// ---------- paleta ----------

(function buildPalette() {
  const wrap = $('palette-items');
  for (const g of NODE_DEFS) {
    const h = document.createElement('div');
    h.className = 'palette-group';
    h.textContent = g.group;
    wrap.appendChild(h);
    for (const def of g.items) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.textContent = `${def.icon} ${def.label}`;
      item.onclick = () => addNode(def);
      wrap.appendChild(item);
    }
  }
})();

// ---------- simulador de llamadas ----------

$('btn-simulate').onclick = () => {
  const panel = $('sim-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    $('sim-hour').value = new Date().getHours();
  }
};

$('sim-clear').onclick = clearSimHighlight;

$('sim-run').onclick = async () => {
  const headers = {};
  for (const line of $('sim-headers').value.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (m) headers[m[1]] = m[2];
  }
  const input = {
    rU: $('sim-ru').value.trim(),
    si: $('sim-si').value.trim(),
    method: $('sim-method').value,
    hour: Number($('sim-hour').value),
    headers,
  };
  try {
    const r = await api('POST', '/api/simulate', { flow, input });
    if (r.errors && r.errors.length) {
      toast(r.errors.join(' · '), 'error');
      return;
    }
    simHighlight = {
      nodes: new Set(r.steps.map((s) => s.nodeId)),
      edges: new Set(r.edges.map((e) => `${e.from}::${e.fromPort}::${e.to}`)),
      end: r.steps.length ? r.steps[r.steps.length - 1].nodeId : null,
    };
    const resEl = $('sim-result');
    resEl.textContent = `${r.result.text}` +
      (r.finalRequest.rU !== input.rU ? ` · destino final: "${r.finalRequest.rU}"` : '');
    resEl.className = `show r-${r.result.kind}`;
    const stepsEl = $('sim-steps');
    stepsEl.innerHTML = '';
    for (const s of r.steps) {
      const li = document.createElement('li');
      const node = nodeById(s.nodeId);
      const b = document.createElement('b');
      b.textContent = (node && node.label) || s.nodeId;
      li.appendChild(b);
      li.appendChild(document.createTextNode(` — ${s.detail.replace(/^[^:]*: /, '')}`));
      stepsEl.appendChild(li);
    }
    render();
  } catch (e) {
    toast(`Error al simular: ${e.message}`, 'error');
  }
};

// ---------- monitor de Kamailio ----------

function fmtDuration(s) {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}h ` : '') + (m ? `${m}m ` : '') + `${sec}s`;
}

async function pollKamailio() {
  try {
    const st = await api('GET', '/api/kamailio/status');
    const el = $('kam-status');
    if (st.online) {
      const up = st.uptime && (st.uptime.uptime ?? st.uptime.Uptime);
      el.textContent = `Kamailio: en línea${up != null ? ` · uptime ${fmtDuration(up)}` : ''}`;
      el.className = 'status online';
    } else {
      el.textContent = 'Kamailio: sin conexión';
      el.className = 'status offline';
    }

    const data = await api('GET', '/api/kamailio/calls');
    const tbody = $('calls-body');
    $('calls-count').textContent = data.online ? `(${data.calls.length})` : '';
    if (!data.online || !data.calls.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">${data.online ? 'no hay llamadas activas' : 'Kamailio no disponible'}</td></tr>`;
    } else {
      tbody.innerHTML = '';
      for (const c of data.calls) {
        const tr = document.createElement('tr');
        for (const val of [c.callid, c.from, c.to]) {
          const td = document.createElement('td');
          td.textContent = val;
          tr.appendChild(td);
        }
        const tdState = document.createElement('td');
        tdState.textContent = c.state;
        tdState.className = `state-${c.state}`;
        tr.appendChild(tdState);
        const tdDur = document.createElement('td');
        tdDur.textContent = fmtDuration(c.duration);
        tr.appendChild(tdDur);
        tbody.appendChild(tr);
      }
    }
  } catch {
    $('kam-status').textContent = 'Kamailio: sin conexión';
    $('kam-status').className = 'status offline';
  }
  try {
    const gw = await api('GET', '/api/kamailio/dispatcher');
    const gbody = $('gw-body');
    if (!gw.online || !gw.gateways.length) {
      gbody.innerHTML = `<tr><td colspan="4" class="muted">${gw.online ? 'sin destinos configurados' : 'Kamailio no disponible'}</td></tr>`;
      return;
    }
    gbody.innerHTML = '';
    for (const g of gw.gateways) {
      const tr = document.createElement('tr');
      const cells = [String(g.set ?? ''), g.uri, g.state, String(g.priority ?? '')];
      cells.forEach((val, i) => {
        const td = document.createElement('td');
        td.textContent = val;
        if (i === 2) td.className = `state-${g.state}`;
        tr.appendChild(td);
      });
      gbody.appendChild(tr);
    }
  } catch {
    $('kam-status').textContent = 'Kamailio: sin conexión';
    $('kam-status').className = 'status offline';
  }
}

// ---------- inicio ----------

window.addEventListener('beforeunload', (ev) => {
  if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
});

(async function init() {
  await loadFlowList();
  await loadFlow($('flow-select').value);
  pollKamailio();
  setInterval(pollKamailio, 5000);
})();
