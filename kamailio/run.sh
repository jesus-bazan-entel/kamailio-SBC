#!/bin/sh
# =====================================================================
#  Entrypoint del contenedor Kamailio
#  - Siembra el flujo por defecto si no existe
#  - Arranca Kamailio en primer plano
#  - Vigila flow/flow-routing.cfg: cuando el Flow Editor despliega
#    una nueva version, valida la config y reinicia Kamailio
# =====================================================================
set -u

CFG=/etc/kamailio/kamailio.cfg
FLOW_DIR=/etc/kamailio/flow
FLOW=$FLOW_DIR/flow-routing.cfg
SHM_MEM=${SHM_MEM:-256}
PKG_MEM=${PKG_MEM:-16}
WATCH_INTERVAL=${WATCH_INTERVAL:-5}

mkdir -p /run/kamailio "$FLOW_DIR"
if [ ! -f "$FLOW" ]; then
    echo "[run.sh] sembrando flujo por defecto en $FLOW"
    cp /etc/kamailio/flow-routing.default.cfg "$FLOW"
fi

checksum() { md5sum "$FLOW" 2>/dev/null | cut -d' ' -f1; }

start_kamailio() {
    kamailio -DD -E -m "$SHM_MEM" -M "$PKG_MEM" -f "$CFG" &
    KAM_PID=$!
    echo "[run.sh] kamailio iniciado (pid $KAM_PID)"
}

stop_kamailio() {
    if kill -0 "$KAM_PID" 2>/dev/null; then
        kill "$KAM_PID"
        wait "$KAM_PID" 2>/dev/null
    fi
}

trap 'echo "[run.sh] señal recibida, parando"; stop_kamailio; exit 0' INT TERM

if ! kamailio -c -f "$CFG" > /tmp/kamcheck.log 2>&1; then
    echo "[run.sh] ERROR: configuracion invalida al arrancar:"
    cat /tmp/kamcheck.log
    exit 1
fi

start_kamailio
LAST=$(checksum)

while true; do
    sleep "$WATCH_INTERVAL"

    # Si kamailio murio, reintentar arranque
    if ! kill -0 "$KAM_PID" 2>/dev/null; then
        echo "[run.sh] kamailio no esta corriendo, reiniciando..."
        start_kamailio
        continue
    fi

    NOW=$(checksum)
    if [ "$NOW" != "$LAST" ]; then
        echo "[run.sh] cambio detectado en flow-routing.cfg, validando..."
        if kamailio -c -f "$CFG" > /tmp/kamcheck.log 2>&1; then
            echo "[run.sh] configuracion valida, reiniciando kamailio"
            stop_kamailio
            start_kamailio
        else
            echo "[run.sh] ERROR: el nuevo flujo NO es valido, se mantiene el anterior en ejecucion:"
            cat /tmp/kamcheck.log
        fi
        LAST=$NOW
    fi
done
