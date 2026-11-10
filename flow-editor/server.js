'use strict';

/**
 * Flow Editor - backend
 *
 *  - CRUD de flujos (JSON) en ./flows
 *  - Compilacion de flujo -> configuracion de rutas Kamailio
 *  - Despliegue: escribe flow-routing.cfg en el volumen compartido;
 *    el contenedor de Kamailio detecta el cambio, valida y reinicia
 *  - Proxy JSON-RPC hacia Kamailio (estado, llamadas activas,
 *    destinos del dispatcher)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { compile } = require('./lib/compiler');
const { simulate } = require('./lib/simulator');

const PORT = Number(process.env.PORT || 8088);
const FLOWS_DIR = process.env.FLOWS_DIR || path.join(__dirname, 'flows');
const FLOW_CFG_PATH = process.env.FLOW_CFG_PATH || '/shared/flow-routing.cfg';
const KAMAILIO_RPC_URL = process.env.KAMAILIO_RPC_URL || 'http://kamailio:5080/RPC';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

fs.mkdirSync(FLOWS_DIR, { recursive: true });

const FLOW_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
function flowPath(name) {
  if (!FLOW_NAME_RE.test(name)) return null;
  return path.join(FLOWS_DIR, `${name}.json`);
}

// ---------- CRUD de flujos ----------

app.get('/api/flows', (req, res) => {
  const names = fs.readdirSync(FLOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  res.json({ flows: names });
});

app.get('/api/flows/:name', (req, res) => {
  const file = flowPath(req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'flujo no encontrado' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.put('/api/flows/:name', (req, res) => {
  const file = flowPath(req.params.name);
  if (!file) return res.status(400).json({ error: 'nombre de flujo invalido (usa letras, numeros, - y _)' });
  const flow = req.body;
  flow.name = req.params.name;
  fs.writeFileSync(file, JSON.stringify(flow, null, 2));
  res.json({ ok: true });
});

app.delete('/api/flows/:name', (req, res) => {
  const file = flowPath(req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'flujo no encontrado' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ---------- Compilacion y despliegue ----------

app.post('/api/compile', (req, res) => {
  const result = compile(req.body);
  res.status(result.errors.length ? 422 : 200).json(result);
});

// Simula una llamada de prueba sobre un flujo (sin tocar Kamailio)
app.post('/api/simulate', (req, res) => {
  const { flow, input } = req.body || {};
  const result = simulate(flow, input || {});
  res.status(result.errors && result.errors.length ? 422 : 200).json(result);
});

app.post('/api/deploy/:name', (req, res) => {
  const file = flowPath(req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'flujo no encontrado' });
  const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = compile(flow);
  if (result.errors.length) return res.status(422).json(result);
  try {
    fs.mkdirSync(path.dirname(FLOW_CFG_PATH), { recursive: true });
    fs.writeFileSync(FLOW_CFG_PATH, result.cfg);
  } catch (e) {
    return res.status(500).json({ error: `no se pudo escribir ${FLOW_CFG_PATH}: ${e.message}` });
  }
  res.json({
    ok: true,
    warnings: result.warnings,
    path: FLOW_CFG_PATH,
    note: 'Kamailio detectara el cambio, validara la configuracion y se reiniciara en unos segundos.',
  });
});

// ---------- Proxy JSON-RPC hacia Kamailio ----------

let rpcId = 0;
async function kamailioRpc(method, params = []) {
  const body = { jsonrpc: '2.0', method, params, id: ++rpcId };
  const resp = await fetch(KAMAILIO_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'error RPC');
  return data.result;
}

app.get('/api/kamailio/status', async (req, res) => {
  try {
    const [uptime, stats] = await Promise.all([
      kamailioRpc('core.uptime'),
      kamailioRpc('stats.get_statistics', ['dialog:', 'tm:']).catch(() => null),
    ]);
    res.json({ online: true, uptime, stats });
  } catch (e) {
    res.json({ online: false, error: e.message });
  }
});

app.get('/api/kamailio/calls', async (req, res) => {
  try {
    const result = await kamailioRpc('dlg.list');
    const list = Array.isArray(result) ? result : [];
    const STATES = { 1: 'iniciando', 2: 'temprana', 3: 'confirmada', 4: 'activa', 5: 'finalizando' };
    const now = Math.floor(Date.now() / 1000);
    const calls = list.map((d) => ({
      callid: d['call-id'] || d.call_id || '',
      from: d.from_uri || '',
      to: d.to_uri || '',
      state: STATES[d.state] || String(d.state),
      duration: d.start_ts ? Math.max(0, now - d.start_ts) : null,
    }));
    res.json({ online: true, calls });
  } catch (e) {
    res.json({ online: false, error: e.message, calls: [] });
  }
});

app.get('/api/kamailio/dispatcher', async (req, res) => {
  try {
    const result = await kamailioRpc('dispatcher.list');
    // Estructura tipica: { RECORDS: [ { SET: { ID, TARGETS: [ { DEST: {...} } ] } } ] }
    const gateways = [];
    const records = result && result.RECORDS;
    if (Array.isArray(records)) {
      for (const rec of records) {
        const set = rec.SET || {};
        const targets = set.TARGETS || [];
        for (const t of targets) {
          const d = t.DEST || {};
          const flags = String(d.FLAGS || '');
          let state = 'desconocido';
          if (flags.startsWith('A')) state = 'activo';
          else if (flags.startsWith('I')) state = 'inactivo';
          else if (flags.startsWith('T')) state = 'probando';
          else if (flags.startsWith('D')) state = 'deshabilitado';
          gateways.push({
            set: set.ID,
            uri: d.URI || '',
            state,
            flags,
            priority: d.PRIORITY,
            latency: d.LATENCY && d.LATENCY.AVG != null ? Math.round(d.LATENCY.AVG * 100) / 100 : null,
          });
        }
      }
    }
    res.json({ online: true, gateways });
  } catch (e) {
    res.json({ online: false, error: e.message, gateways: [] });
  }
});

// ---------- Arranque ----------

// Si el volumen compartido no tiene aun un flujo desplegado y existe el
// flujo "default", sembrarlo para que Kamailio arranque con algo valido.
try {
  const def = flowPath('default');
  if (def && fs.existsSync(def) && !fs.existsSync(FLOW_CFG_PATH)) {
    const result = compile(JSON.parse(fs.readFileSync(def, 'utf8')));
    if (!result.errors.length) {
      fs.mkdirSync(path.dirname(FLOW_CFG_PATH), { recursive: true });
      fs.writeFileSync(FLOW_CFG_PATH, result.cfg);
      console.log(`flujo 'default' desplegado inicialmente en ${FLOW_CFG_PATH}`);
    }
  }
} catch (e) {
  console.warn(`no se pudo sembrar el flujo inicial: ${e.message}`);
}

app.listen(PORT, () => {
  console.log(`Flow Editor escuchando en http://0.0.0.0:${PORT}`);
  console.log(`RPC Kamailio: ${KAMAILIO_RPC_URL}`);
  console.log(`Despliegue en: ${FLOW_CFG_PATH}`);
});
