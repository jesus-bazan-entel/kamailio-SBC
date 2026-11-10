'use strict';

/* Pruebas del simulador de llamadas */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { simulate } = require('../lib/simulator');

const defaultFlow = JSON.parse(fs.readFileSync(path.join(__dirname, '../flows/default.json'), 'utf8'));

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

test('numero premium 905xxx se rechaza con 403', () => {
  const r = simulate(defaultFlow, { rU: '905123456', si: '10.0.0.5' });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.result.kind, 'reject');
  assert.ok(r.steps.some((s) => s.nodeId === 'r_block'));
  // camino: start -> c_premium(true) -> r_block
  assert.deepStrictEqual(r.edges.map((e) => `${e.from}:${e.fromPort}`), ['start:out', 'c_premium:true']);
});

test('internacional 0049... pierde el 00 y va a carriers (grupo 1)', () => {
  const r = simulate(defaultFlow, { rU: '004930123456' });
  assert.strictEqual(r.result.kind, 'dispatcher');
  assert.strictEqual(r.finalRequest.rU, '4930123456'); // strip(2) aplicado
  assert.ok(r.steps.some((s) => s.nodeId === 'd_carriers'));
});

test('numero local va a la PBX (grupo 2) sin modificarse', () => {
  const r = simulate(defaultFlow, { rU: '2345678' });
  assert.strictEqual(r.result.kind, 'dispatcher');
  assert.strictEqual(r.finalRequest.rU, '2345678');
  assert.ok(r.steps.some((s) => s.nodeId === 'd_local'));
});

test('rama sin destino termina en no_match (404)', () => {
  const flow = {
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'c', type: 'condition', subtype: 'prefix', params: { value: '1' } },
      { id: 'rj', type: 'reject', params: { code: 403, reason: 'x' } },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'c' },
      { from: 'c', fromPort: 'true', to: 'rj' },
      // rama false sin conectar
    ],
  };
  const r = simulate(flow, { rU: '999' });
  assert.strictEqual(r.result.kind, 'no_match');
});

test('condiciones de hora, metodo, IP y cabecera', () => {
  const flow = {
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'h', type: 'condition', subtype: 'time', params: { from: 8, to: 20 } },
      { id: 'm', type: 'condition', subtype: 'method', params: { value: 'INVITE|MESSAGE' } },
      { id: 'ip', type: 'condition', subtype: 'srcip', params: { value: '10.1.1.1' } },
      { id: 'hd', type: 'condition', subtype: 'header', params: { name: 'X-Cliente', value: 'vip' } },
      { id: 'ok', type: 'forward', params: { host: 'pbx', port: 5060, transport: 'udp' } },
      { id: 'no', type: 'reject', params: { code: 403, reason: 'no' } },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'h' },
      { from: 'h', fromPort: 'true', to: 'm' },
      { from: 'h', fromPort: 'false', to: 'no' },
      { from: 'm', fromPort: 'true', to: 'ip' },
      { from: 'ip', fromPort: 'true', to: 'hd' },
      { from: 'hd', fromPort: 'true', to: 'ok' },
      { from: 'hd', fromPort: 'false', to: 'no' },
    ],
  };
  const ok = simulate(flow, {
    rU: '100', si: '10.1.1.1', method: 'INVITE', hour: 12,
    headers: { 'X-Cliente': 'vip-oro' },
  });
  assert.strictEqual(ok.result.kind, 'forward');
  assert.ok(ok.result.text.includes('sip:pbx:5060'));

  const fuera = simulate(flow, { rU: '100', si: '10.1.1.1', method: 'INVITE', hour: 22, headers: { 'X-Cliente': 'vip' } });
  assert.strictEqual(fuera.result.kind, 'reject');
});

test('acciones encadenadas modifican la peticion', () => {
  const flow = {
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'a1', type: 'action', subtype: 'strip', params: { count: 1 } },
      { id: 'a2', type: 'action', subtype: 'prepend', params: { value: '51' } },
      { id: 'a3', type: 'action', subtype: 'add_header', params: { name: 'X-Ruta', value: 'flow' } },
      { id: 'f', type: 'forward', params: { host: 'gw', port: 5060 } },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'a1' },
      { from: 'a1', fromPort: 'out', to: 'a2' },
      { from: 'a2', fromPort: 'out', to: 'a3' },
      { from: 'a3', fromPort: 'out', to: 'f' },
    ],
  };
  const r = simulate(flow, { rU: '0987' });
  assert.strictEqual(r.finalRequest.rU, '51987');
  assert.strictEqual(r.finalRequest.headers['X-Ruta'], 'flow');
});

test('ciclo se reporta como error sin colgarse', () => {
  const flow = {
    name: 'x',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'a', type: 'action', subtype: 'strip', params: { count: 1 } },
    ],
    edges: [
      { from: 's', fromPort: 'out', to: 'a' },
      { from: 'a', fromPort: 'out', to: 'a' },
    ],
  };
  const r = simulate(flow, { rU: '123456' });
  assert.ok(r.errors.some((e) => e.includes('ciclo')));
});

console.log(`\n${passed} pruebas pasaron${process.exitCode ? ' (con fallos)' : ''}`);
