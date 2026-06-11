'use strict';

/* Pruebas basicas del compilador flujo -> Kamailio cfg */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compile } = require('../lib/compiler');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✖ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

test('compila el flujo de ejemplo (default.json) sin errores', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '../flows/default.json'), 'utf8'));
  const r = compile(flow);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.cfg.includes('route[FLOW]'));
  assert.ok(r.cfg.includes('route[FLOW_NO_MATCH]'));
  assert.ok(r.cfg.includes('$rU =~ "^905"'));
  assert.ok(r.cfg.includes('strip(2);'));
  assert.ok(r.cfg.includes('ds_select_dst("1", "4")'));
  assert.ok(r.cfg.includes('t_on_failure("FLOW_DISPATCH_FAILOVER")'));
});

test('rechaza un flujo sin nodo Inicio', () => {
  const r = compile({ name: 'x', nodes: [], edges: [] });
  assert.ok(r.errors.some((e) => e.includes('Inicio')));
});

test('rechaza flujos con ciclos', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'a', type: 'action', subtype: 'strip', params: { count: 1 } },
      { id: 'b', type: 'action', subtype: 'strip', params: { count: 1 } },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'a' },
      { from: 'a', fromPort: 'out', to: 'b' },
      { from: 'b', fromPort: 'out', to: 'a' },
    ],
  });
  assert.ok(r.errors.some((e) => e.includes('ciclo')));
});

test('rechaza inyeccion de comillas en parametros', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'rj', type: 'reject', params: { code: 403, reason: 'a"); exit; #' } },
    ],
    edges: [{ from: 's', fromPort: 'out', to: 'rj' }],
  });
  assert.ok(r.errors.length > 0);
  assert.strictEqual(r.cfg, null);
});

test('dos conexiones en el mismo puerto es error', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'a', type: 'reject', params: {} },
      { id: 'b', type: 'reject', params: {} },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'a' },
      { from: 's', fromPort: 'out', to: 'b' },
    ],
  });
  assert.ok(r.errors.some((e) => e.includes('mas de una conexion')));
});

test('nodo no conectado genera advertencia y se omite', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'a', type: 'reject', params: {} },
      { id: 'huerfano', type: 'reject', label: 'huerfano', params: {} },
    ],
    edges: [{ from: 's', fromPort: 'out', to: 'a' }],
  });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('huerfano')));
  assert.ok(!r.cfg.includes('FLOW_N_huerfano'));
});

test('condicion con una sola rama conectada', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'c', type: 'condition', subtype: 'prefix', params: { value: '00' } },
      { id: 'rj', type: 'reject', params: {} },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'c' },
      { from: 'c', fromPort: 'false', to: 'rj' },
    ],
  });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.cfg.includes('if (!($rU =~ "^00"))'));
});

test('forward genera $du correcto con transporte tcp', () => {
  const r = compile({
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'f', type: 'forward', params: { host: 'pbx.interna.local', port: 5070, transport: 'tcp' } },
    ],
    edges: [{ from: 's', fromPort: 'out', to: 'f' }],
  });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.cfg.includes('$du = "sip:pbx.interna.local:5070;transport=tcp";'));
});

console.log(`\n${passed} pruebas pasaron${process.exitCode ? ' (con fallos)' : ''}`);
