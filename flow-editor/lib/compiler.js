'use strict';

/**
 * Compilador: traduce un flujo visual (JSON de nodos y conexiones)
 * a bloques route[...] de Kamailio.
 *
 * Tipos de nodo soportados:
 *   start                                  -> punto de entrada (unico)
 *   condition: prefix|regex|srcip|method|time|header  (salidas true/false)
 *   action:    strip|prepend|set_user|set_domain|add_header|log  (salida out)
 *   dispatcher (terminal)                  -> ds_select_dst + failover
 *   forward    (terminal)                  -> $du fijo + RELAY
 *   reject     (terminal)                  -> send_reply + exit
 */

const DISPATCHER_ALGORITHMS = new Set(['0', '1', '2', '3', '4', '6', '7', '8', '9', '10', '11', '12']);
const TRANSPORTS = new Set(['udp', 'tcp', 'tls']);

function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9_]/g, '_');
}

// Las cadenas insertadas en el cfg no pueden contener comillas,
// barras invertidas ni saltos de linea.
function cfgString(value, field, errors) {
  const s = String(value == null ? '' : value);
  if (/["\\\r\n]/.test(s)) {
    errors.push(`${field}: no se permiten comillas, '\\' ni saltos de linea`);
    return '';
  }
  return s;
}

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function intInRange(value, min, max, field, errors) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${field}: debe ser un entero entre ${min} y ${max}`);
    return min;
  }
  return n;
}

function compile(flow) {
  const errors = [];
  const warnings = [];

  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { cfg: null, errors: ['flujo invalido: faltan nodes/edges'], warnings };
  }

  const nodes = new Map();
  for (const n of flow.nodes) {
    if (!n.id) { errors.push('nodo sin id'); continue; }
    if (nodes.has(n.id)) errors.push(`id de nodo duplicado: ${n.id}`);
    nodes.set(n.id, n);
  }

  const starts = flow.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) {
    errors.push(`el flujo debe tener exactamente un nodo Inicio (tiene ${starts.length})`);
  }

  // Indice de conexiones: from+puerto -> destino (solo una por puerto)
  const next = new Map();
  for (const e of flow.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      errors.push(`conexion con nodo inexistente: ${e.from} -> ${e.to}`);
      continue;
    }
    const port = e.fromPort || 'out';
    const key = `${e.from}::${port}`;
    if (next.has(key)) {
      errors.push(`el puerto '${port}' del nodo '${label(nodes.get(e.from))}' tiene mas de una conexion`);
    }
    next.set(key, e.to);
  }

  if (errors.length) return { cfg: null, errors, warnings };

  const start = starts[0];

  // Deteccion de ciclos y de nodos alcanzables (DFS desde Inicio)
  const reachable = new Set();
  const inStack = new Set();
  let cycle = null;
  (function dfs(id) {
    if (cycle) return;
    if (inStack.has(id)) { cycle = id; return; }
    if (reachable.has(id)) return;
    reachable.add(id);
    inStack.add(id);
    for (const port of outPorts(nodes.get(id))) {
      const to = next.get(`${id}::${port}`);
      if (to) dfs(to);
    }
    inStack.delete(id);
  })(start.id);

  if (cycle) {
    errors.push(`el flujo contiene un ciclo (pasa por '${label(nodes.get(cycle))}'); los ciclos no estan permitidos`);
    return { cfg: null, errors, warnings };
  }

  for (const n of flow.nodes) {
    if (!reachable.has(n.id)) {
      warnings.push(`el nodo '${label(n)}' no esta conectado al flujo y sera ignorado`);
    }
  }

  // --- Emision de codigo ---
  const out = [];
  const routeName = (id) => `FLOW_N_${sanitizeId(id)}`;
  const gotoOr = (id, port) => {
    const to = next.get(`${id}::${port}`);
    return to ? `\troute(${routeName(to)});\n` : '';
  };

  out.push('# ============================================================');
  out.push('#  GENERADO AUTOMATICAMENTE POR FLOW EDITOR - NO EDITAR A MANO');
  out.push(`#  Flujo: ${sanitizeId(flow.name || 'default')}`);
  out.push(`#  Generado: ${new Date().toISOString()}`);
  out.push('# ============================================================');
  out.push('');
  out.push('route[FLOW] {');
  out.push(`\txdbg("flow[${sanitizeId(flow.name || 'default')}]: $rm $fU -> $rU desde $si\\n");`);
  out.push(`\troute(${routeName(start.id)});`);
  out.push('\troute(FLOW_NO_MATCH);');
  out.push('}');
  out.push('');
  out.push('# Ningun nodo terminal alcanzado: rechazar');
  out.push('route[FLOW_NO_MATCH] {');
  out.push('\tsend_reply("404", "Not Found");');
  out.push('\texit;');
  out.push('}');

  for (const n of flow.nodes) {
    if (!reachable.has(n.id)) continue;
    const body = emitNode(n, gotoOr, errors);
    out.push('');
    out.push(`# [${describe(n)}] ${label(n)}`);
    out.push(`route[${routeName(n.id)}] {`);
    out.push(body.replace(/\n$/, ''));
    out.push('}');
  }

  if (errors.length) return { cfg: null, errors, warnings };
  return { cfg: out.join('\n') + '\n', errors: [], warnings };
}

function label(n) {
  return (n && (n.label || n.id)) || '?';
}

function describe(n) {
  if (n.type === 'start') return 'inicio';
  if (n.type === 'condition') return `condicion/${n.subtype || '?'}`;
  if (n.type === 'action') return `accion/${n.subtype || '?'}`;
  if (n.type === 'dispatcher') return 'balanceador';
  if (n.type === 'forward') return 'reenviar';
  if (n.type === 'reject') return 'rechazar';
  return n.type;
}

function outPorts(n) {
  if (!n) return [];
  if (n.type === 'condition') return ['true', 'false'];
  if (n.type === 'start' || n.type === 'action') return ['out'];
  return []; // terminales
}

function emitNode(n, gotoOr, errors) {
  const p = n.params || {};
  const where = `nodo '${label(n)}'`;

  switch (n.type) {
    case 'start':
      // un bloque route[] no puede quedar vacio (solo comentarios): return;
      return gotoOr(n.id, 'out') || '\t# sin conexion de salida\n\treturn;\n';

    case 'condition': {
      const expr = conditionExpr(n, p, where, errors);
      const t = gotoOr(n.id, 'true');
      const f = gotoOr(n.id, 'false');
      if (!t && !f) return '\t# condicion sin ramas conectadas\n\treturn;\n';
      if (t && f) return `\tif (${expr}) {\n\t\t${t.trim()}\n\t} else {\n\t\t${f.trim()}\n\t}\n`;
      if (t) return `\tif (${expr}) {\n\t\t${t.trim()}\n\t}\n`;
      return `\tif (!(${expr})) {\n\t\t${f.trim()}\n\t}\n`;
    }

    case 'action': {
      const lines = actionLines(n, p, where, errors);
      return lines.map((l) => `\t${l}\n`).join('') + gotoOr(n.id, 'out');
    }

    case 'dispatcher': {
      const setid = intInRange(p.setid, 0, 9999, `${where}: grupo`, errors);
      const alg = String(p.algorithm == null ? '4' : p.algorithm);
      if (!DISPATCHER_ALGORITHMS.has(alg)) {
        errors.push(`${where}: algoritmo de balanceo invalido (${alg})`);
      }
      return (
        `\tif (!ds_select_dst("${setid}", "${alg}")) {\n` +
        '\t\tsend_reply("503", "Service Unavailable");\n' +
        '\t\texit;\n' +
        '\t}\n' +
        '\tt_on_failure("FLOW_DISPATCH_FAILOVER");\n' +
        '\troute(RELAY);\n' +
        '\texit;\n'
      );
    }

    case 'forward': {
      const host = cfgString(p.host, `${where}: host`, errors).trim();
      if (!host || /[\s;>]/.test(host)) {
        errors.push(`${where}: host invalido`);
      }
      const port = intInRange(p.port == null || p.port === '' ? 5060 : p.port, 1, 65535, `${where}: puerto`, errors);
      const transport = String(p.transport || 'udp').toLowerCase();
      if (!TRANSPORTS.has(transport)) {
        errors.push(`${where}: transporte invalido (${transport})`);
      }
      const tparam = transport === 'udp' ? '' : `;transport=${transport}`;
      return (
        `\t$du = "sip:${host}:${port}${tparam}";\n` +
        '\troute(RELAY);\n' +
        '\texit;\n'
      );
    }

    case 'reject': {
      const code = intInRange(p.code == null || p.code === '' ? 403 : p.code, 300, 699, `${where}: codigo`, errors);
      const reason = cfgString(p.reason || 'Forbidden', `${where}: motivo`, errors);
      return `\tsend_reply("${code}", "${reason}");\n\texit;\n`;
    }

    default:
      errors.push(`${where}: tipo de nodo desconocido '${n.type}'`);
      return '\t# tipo desconocido\n\treturn;\n';
  }
}

function conditionExpr(n, p, where, errors) {
  switch (n.subtype) {
    case 'prefix': {
      const v = cfgString(p.value, `${where}: prefijo`, errors);
      if (!v) errors.push(`${where}: el prefijo no puede estar vacio`);
      return `$rU =~ "^${escapeRegexLiteral(v)}"`;
    }
    case 'regex': {
      const v = cfgString(p.value, `${where}: expresion`, errors);
      if (!v) errors.push(`${where}: la expresion no puede estar vacia`);
      try { new RegExp(v); } catch (e) { errors.push(`${where}: regex invalida (${e.message})`); }
      return `$rU =~ "${v}"`;
    }
    case 'srcip': {
      const v = cfgString(p.value, `${where}: IP`, errors).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
        errors.push(`${where}: IP de origen invalida (${v || 'vacia'})`);
      }
      return `$si == "${v}"`;
    }
    case 'method': {
      const v = cfgString(p.value || 'INVITE', `${where}: metodo`, errors).toUpperCase().trim();
      if (!/^[A-Z]+(\|[A-Z]+)*$/.test(v)) {
        errors.push(`${where}: metodo invalido (usa p.ej. INVITE o INVITE|MESSAGE)`);
      }
      return `is_method("${v}")`;
    }
    case 'time': {
      const from = intInRange(p.from, 0, 23, `${where}: hora desde`, errors);
      const to = intInRange(p.to, 0, 24, `${where}: hora hasta`, errors);
      return `$(timef(%H){s.int}) >= ${from} && $(timef(%H){s.int}) < ${to}`;
    }
    case 'header': {
      const name = cfgString(p.name, `${where}: cabecera`, errors).trim();
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
        errors.push(`${where}: nombre de cabecera invalido`);
      }
      const v = cfgString(p.value, `${where}: valor`, errors);
      if (!v) return `is_present_hf("${name}")`;
      return `$hdr(${name}) =~ "${v}"`;
    }
    default:
      errors.push(`${where}: subtipo de condicion desconocido '${n.subtype}'`);
      return 'false';
  }
}

function actionLines(n, p, where, errors) {
  switch (n.subtype) {
    case 'strip': {
      const c = intInRange(p.count, 1, 30, `${where}: digitos`, errors);
      return [`strip(${c});`];
    }
    case 'prepend': {
      const v = cfgString(p.value, `${where}: prefijo`, errors);
      if (!/^[0-9+*#]+$/.test(v)) errors.push(`${where}: el prefijo debe ser digitos/+/*/#`);
      return [`prefix("${v}");`];
    }
    case 'set_user': {
      const v = cfgString(p.value, `${where}: usuario`, errors);
      if (!v) errors.push(`${where}: el usuario no puede estar vacio`);
      return [`$rU = "${v}";`];
    }
    case 'set_domain': {
      const v = cfgString(p.value, `${where}: dominio`, errors).trim();
      if (!v || /[\s;>]/.test(v)) errors.push(`${where}: dominio invalido`);
      return [`$rd = "${v}";`];
    }
    case 'add_header': {
      const name = cfgString(p.name, `${where}: cabecera`, errors).trim();
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) errors.push(`${where}: nombre de cabecera invalido`);
      const v = cfgString(p.value, `${where}: valor`, errors);
      return [`append_hf("${name}: ${v}\\r\\n");`];
    }
    case 'log': {
      const v = cfgString(p.value || 'paso por nodo', `${where}: mensaje`, errors);
      return [`xlog("L_INFO", "flow: ${v} [$rm $fU -> $rU callid=$ci]\\n");`];
    }
    default:
      errors.push(`${where}: subtipo de accion desconocido '${n.subtype}'`);
      return ['# accion desconocida'];
  }
}

module.exports = { compile };
