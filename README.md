# Kamailio SBC con editor visual de flujos de llamadas

SBC basado en **Kamailio** optimizado para enrutar tráfico SIP, junto con un
**Flow Editor** web que permite **ver y editar la lógica de enrutamiento de
llamadas de forma visual** (nodos y conexiones tipo diagrama de flujo) y
desplegarla en Kamailio con un clic, además de monitorear las **llamadas
activas** en tiempo real.

```
                        ┌──────────────────────────────┐
   Navegador ──8088──▶  │  Flow Editor (Node.js)       │
                        │  · editor visual de nodos    │
                        │  · compilador flujo → cfg    │──── flow-routing.cfg ──┐
                        │  · monitor de llamadas       │   (volumen compartido) │
                        └──────────────┬───────────────┘                        ▼
                                       │ JSON-RPC (http :5080)   ┌──────────────────────────┐
   Teléfonos / PBX ──5060 udp/tcp───────────────────────────────▶│  Kamailio SBC            │
   Carriers                            └────────────────────────▶│  · anti-flood + baneo    │
                                                                 │  · NAT / rtpengine (opc) │
                                                                 │  · dispatcher + failover │
                                                                 │  · dialog (llamadas)     │
                                                                 │  · route[FLOW] generado  │
                                                                 └──────────────────────────┘
```

## Inicio rápido

```bash
docker compose up -d --build
```

- **Editor visual:** http://localhost:8088
- **SIP:** puerto `5060` (UDP y TCP)

El editor arranca con un flujo de ejemplo (`default`): bloquea números
premium `905`, enruta internacional `00` (quitando el prefijo) al grupo de
carriers 1 con balanceo round-robin y failover, y el resto al grupo 2 (PBX).

## Cómo funciona el ciclo visual → Kamailio

1. En el editor armas el flujo con nodos (condiciones, acciones, destinos)
   y los conectas arrastrando desde los puntos de salida (●) a la entrada
   del siguiente nodo.
2. **⚙ Ver config** muestra la configuración Kamailio que genera tu grafo
   (bloques `route[FLOW_N_*]`), sin tocar nada.
3. **🚀 Desplegar** valida el flujo (ciclos, parámetros, conexiones),
   lo compila y escribe `flow-routing.cfg` en un volumen compartido.
4. El contenedor de Kamailio detecta el cambio, **valida la configuración
   con `kamailio -c`** y solo si es correcta reinicia con la nueva lógica
   (si no lo es, sigue corriendo la anterior y lo registra en el log).

La lógica generada se engancha en `route(FLOW)` dentro de
`kamailio/kamailio.cfg`, que ya se encarga del trabajo "de plomería":
sanidad, anti-flood, NAT, retransmisiones, in-dialog, record-route, etc.

## Nodos disponibles

| Grupo | Nodo | Genera en Kamailio |
|---|---|---|
| Inicio | ▶ Inicio | punto de entrada (único) |
| Condición | Prefijo destino | `$rU =~ "^..."` (sí/no) |
| Condición | Regex destino | `$rU =~ "regex"` |
| Condición | IP de origen | `$si == "x.x.x.x"` |
| Condición | Método SIP | `is_method("INVITE\|MESSAGE")` |
| Condición | Franja horaria | comparación sobre `$timef(%H)` |
| Condición | Cabecera SIP | `is_present_hf` / `$hdr(X) =~` |
| Acción | Quitar dígitos | `strip(n)` |
| Acción | Añadir prefijo | `prefix("...")` |
| Acción | Cambiar usuario/dominio | `$rU = ...` / `$rd = ...` |
| Acción | Añadir cabecera | `append_hf(...)` |
| Acción | Registrar en log | `xlog(...)` |
| Destino | ⚖ Balanceador | `ds_select_dst(grupo, alg)` + failover automático |
| Destino | 📤 Reenviar a host | `$du = "sip:host:puerto"` |
| Destino | ⛔ Rechazar | `send_reply(código, motivo)` |

Si una rama no llega a ningún destino terminal, la llamada cae en
`route[FLOW_NO_MATCH]` y se responde `404 Not Found`.

El nodo **Balanceador** usa los grupos definidos en
`kamailio/dispatcher.list` (sondea destinos con OPTIONS y, ante timeout o
5xx, reintenta con el siguiente destino del grupo vía
`failure_route[FLOW_DISPATCH_FAILOVER]`).

## Simulador de llamadas 🧪

El botón **"🧪 Probar llamada"** abre un panel donde ingresas un número
destino, IP de origen, método, hora y cabeceras de prueba. Al simular:

- El **camino que tomaría la llamada se ilumina en el grafo** (nodos en
  verde, conexiones animadas, nodo final en naranja).
- Se muestra el **detalle paso a paso** de cada decisión ("¿empieza por
  00? → SÍ", "quitar 2 dígitos: 0049… → 49…") y el resultado final
  (balanceada, reenviada, rechazada o 404 sin ruta).
- La simulación replica exactamente la semántica del compilador, sin
  tocar Kamailio, así puedes verificar la lógica **antes de desplegar**.

## Monitoreo en vivo

El panel inferior consulta cada 5 s el RPC de Kamailio y muestra:

- **Llamadas activas** (`dlg.list` del módulo dialog): origen, destino,
  estado (temprana / activa / finalizando) y duración.
- **Gateways del dispatcher** (`dispatcher.list`): estado de cada
  destino según el sondeo OPTIONS (activo / probando / inactivo) con su
  grupo y prioridad.

La barra superior indica si Kamailio está en línea y su uptime.

## Optimizaciones incluidas en `kamailio.cfg`

- **Anti-flood:** `pike` + baneo temporal de IPs en `htable` (5 min) y
  corte de scanners conocidos (sipvicious, friendly-scanner, …).
- **Sanidad:** `sanity_check`, Max-Forwards, absorción de retransmisiones
  con `t_check_trans()`.
- **TCP afinado:** async, keepalive, 8192 conexiones, `tcp_accept_no_cl`.
- **DNS:** caché interna, failover y balanceo SRV.
- **Timers tm agresivos** (`fr_timer=4s`) para failover rápido de carriers.
- **NAT:** `force_rport`, alias de contacto, keepalives OPTIONS;
  **rtpengine opcional** (descomentar `WITH_RTPENGINE`).
- **Hardening:** sin firmas de servidor, RPC HTTP restringido a redes
  privadas y sin publicar fuera de la red de Docker.
- Memoria dimensionada por variables de entorno (`SHM_MEM`, `PKG_MEM`).

## Estructura del repositorio

```
├── docker-compose.yml
├── kamailio/
│   ├── Dockerfile                  # Debian + repo oficial deb.kamailio.org (5.8)
│   ├── kamailio.cfg                # config SBC optimizada
│   ├── kamailio-local.cfg          # overrides por entorno (listen, advertise…)
│   ├── dispatcher.list             # grupos de destinos para el balanceador
│   ├── flow-routing.default.cfg    # flujo inicial (semilla)
│   └── run.sh                      # entrypoint: arranque + recarga del flujo
└── flow-editor/
    ├── server.js                   # API REST + proxy RPC + despliegue
    ├── lib/compiler.js             # compilador grafo → rutas Kamailio
    ├── lib/simulator.js            # simulador de llamadas sobre el grafo
    ├── flows/default.json          # flujo de ejemplo
    ├── test/                       # pruebas de compilador y simulador (npm test)
    └── public/                     # editor visual (HTML/CSS/JS sin frameworks)
```

## Configuración por entorno

| Variable (servicio) | Por defecto | Descripción |
|---|---|---|
| `SHM_MEM` (kamailio) | 256 | memoria compartida en MB |
| `PKG_MEM` (kamailio) | 16 | memoria por proceso en MB |
| `WATCH_INTERVAL` (kamailio) | 5 | segundos entre chequeos del flujo |
| `KAMAILIO_RPC_URL` (editor) | `http://kamailio:5080/RPC` | endpoint RPC |
| `FLOW_CFG_PATH` (editor) | `/shared/flow-routing.cfg` | destino del despliegue |

Para añadir sockets o anunciar IP pública detrás de NAT, edita
`kamailio/kamailio-local.cfg`. Para los destinos del balanceador, edita
`kamailio/dispatcher.list` y ejecuta `kamcmd dispatcher.reload` dentro del
contenedor (o reconstruye).

## Seguridad

- **No expongas** el puerto 5080 (RPC) ni el 8088 (editor) a internet; el
  editor no tiene autenticación propia: colócalo detrás de una VPN o de un
  reverse proxy con autenticación.
- El compilador valida todos los parámetros de los nodos (sin comillas ni
  saltos de línea, regex verificadas, rangos numéricos) para impedir
  inyección de configuración, y rechaza grafos con ciclos.
- El reinicio tras un despliegue solo ocurre si `kamailio -c` valida la
  nueva configuración.

## Desarrollo

```bash
cd flow-editor
npm install
npm test        # pruebas del compilador
npm start       # editor en http://localhost:8088 (sin Kamailio: el panel
                # de llamadas mostrará "sin conexión", el resto funciona)
```
