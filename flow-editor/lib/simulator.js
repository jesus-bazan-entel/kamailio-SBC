'use strict';

/**
 * Simulador: recorre el flujo visual con una llamada de prueba y
 * devuelve el camino exacto (nodos y conexiones) que tomaria, con el
 * detalle de cada decision. Replica la semantica del compilador
 * (lib/compiler.js) sin necesidad de Kamailio.
 *
 * Entrada de prueba:
 *   { rU, si, method, hour, headers: { Nombre: valor } }
 */

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simulate(flow, input) {
  const errors = [];
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { errors: ['flujo invalido: faltan nodes/edges'] };
  }

  const req = {
    rU: String(input?.rU ?? ''),
    rd: String(input?.rd ?? ''),
    si: String(input?.si ?? ''),
    method: String(input?.method || 'INVITE').toUpperCase(),
    hour: Number.isInteger(input?.hour) ? input.hour : new Date().getHours(),
    headers: Object.assign({}, input?.headers || {}),
  };

  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const start = flow.nodes.find((n) => n.type === 'start');
  if (!start) return { errors: ['el flujo no tiene nodo Inicio'] };

  const next = new Map();
  for (const e of flow.edges) {
    next.set(`${e.from}::${e.fromPort || 'out'}`, e.to);
  }

  const steps = [];
  const edgesTaken = [];
  const visited = new Set();
  let result = null;
  let current = start.id;

  const follow = (fromId, port) => {
    const to = next.get(`${fromId}::${port}`);
    if (to) edgesTaken.push({ from: fromId, fromPort: port, to });
    return to || null;
  };

  while (current) {
    if (visited.has(current)) {
      errors.push('ciclo detectado durante la simulacion');
      break;
    }
    visited.add(current);

    const n = nodes.get(current);
    if (!n) { errors.push(`nodo inexistente: ${current}`); break; }
    const p = n.params || {};
    const name = n.label || n.id;

    switch (n.type) {
      case 'start':
        steps.push({ nodeId: n.id, detail: `Llamada entrante: ${req.method} hacia "${req.rU}" desde ${req.si || '(IP no indicada)'}` });
        current = follow(n.id, 'out');
        break;

      case 'condition': {
        const { match, detail } = evalCondition(n, p, req);
        steps.push({ nodeId: n.id, detail: `${name}: ${detail} → ${match ? 'SÍ' : 'NO'}`, branch: match ? 'true' : 'false' });
        current = follow(n.id, match ? 'true' : 'false');
        break;
      }

      case 'action': {
        const detail = applyAction(n, p, req);
        steps.push({ nodeId: n.id, detail: `${name}: ${detail}` });
        current = follow(n.id, 'out');
        break;
      }

      case 'dispatcher':
        steps.push({ nodeId: n.id, detail: `${name}: balancear al grupo ${p.setid} (algoritmo ${p.algorithm ?? '4'}) con failover automático` });
        result = {
          kind: 'dispatcher',
          text: `Enviada al balanceador — grupo ${p.setid} de dispatcher.list`,
        };
        current = null;
        break;

      case 'forward': {
        const tr = (p.transport || 'udp').toLowerCase();
        const uri = `sip:${p.host}:${p.port || 5060}${tr === 'udp' ? '' : `;transport=${tr}`}`;
        steps.push({ nodeId: n.id, detail: `${name}: reenviar a ${uri}` });
        result = { kind: 'forward', text: `Reenviada a ${uri}` };
        current = null;
        break;
      }

      case 'reject':
        steps.push({ nodeId: n.id, detail: `${name}: responder ${p.code || 403} ${p.reason || 'Forbidden'}` });
        result = { kind: 'reject', text: `Rechazada con ${p.code || 403} ${p.reason || 'Forbidden'}` };
        current = null;
        break;

      default:
        errors.push(`tipo de nodo desconocido: ${n.type}`);
        current = null;
    }
  }

  if (!result && !errors.length) {
    result = { kind: 'no_match', text: 'Ningún destino alcanzado → 404 Not Found (FLOW_NO_MATCH)' };
  }

  return {
    errors,
    steps,
    edges: edgesTaken,
    result,
    finalRequest: { rU: req.rU, rd: req.rd, headers: req.headers },
  };
}

function evalCondition(n, p, req) {
  switch (n.subtype) {
    case 'prefix': {
      const re = new RegExp('^' + escapeRegexLiteral(String(p.value ?? '')));
      return { match: re.test(req.rU), detail: `¿"${req.rU}" empieza por "${p.value}"?` };
    }
    case 'regex': {
      let match = false;
      try { match = new RegExp(String(p.value ?? '')).test(req.rU); } catch { /* regex invalida */ }
      return { match, detail: `¿"${req.rU}" cumple /${p.value}/?` };
    }
    case 'srcip':
      return { match: req.si === String(p.value ?? '').trim(), detail: `¿IP origen ${req.si || '(vacía)'} == ${p.value}?` };
    case 'method': {
      const list = String(p.value || 'INVITE').toUpperCase().split('|');
      return { match: list.includes(req.method), detail: `¿método ${req.method} ∈ {${list.join(', ')}}?` };
    }
    case 'time': {
      const from = Number(p.from), to = Number(p.to);
      return { match: req.hour >= from && req.hour < to, detail: `¿hora ${req.hour}:00 entre ${from}:00 y ${to}:00?` };
    }
    case 'header': {
      const name = String(p.name || '').trim();
      const val = req.headers[name];
      if (!String(p.value ?? '')) {
        return { match: val !== undefined, detail: `¿cabecera ${name} presente?` };
      }
      let match = false;
      try { match = val !== undefined && new RegExp(String(p.value)).test(String(val)); } catch { /* regex invalida */ }
      return { match, detail: `¿${name}: "${val ?? '(ausente)'}" cumple /${p.value}/?` };
    }
    default:
      return { match: false, detail: `subtipo desconocido '${n.subtype}'` };
  }
}

function applyAction(n, p, req) {
  switch (n.subtype) {
    case 'strip': {
      const before = req.rU;
      req.rU = req.rU.slice(Number(p.count) || 0);
      return `quitar ${p.count} dígitos: "${before}" → "${req.rU}"`;
    }
    case 'prepend': {
      req.rU = String(p.value ?? '') + req.rU;
      return `anteponer "${p.value}" → "${req.rU}"`;
    }
    case 'set_user': {
      req.rU = String(p.value ?? '');
      return `usuario destino = "${req.rU}"`;
    }
    case 'set_domain': {
      req.rd = String(p.value ?? '');
      return `dominio destino = "${req.rd}"`;
    }
    case 'add_header':
      req.headers[String(p.name || '')] = String(p.value ?? '');
      return `añadir cabecera ${p.name}: ${p.value}`;
    case 'log':
      return `log: ${p.value || ''}`;
    default:
      return `acción desconocida '${n.subtype}'`;
  }
}

module.exports = { simulate };
