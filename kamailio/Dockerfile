# =====================================================================
#  Kamailio SBC - imagen basada en Debian + repositorio oficial
# =====================================================================
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.kamailio.org/kamailiodebkey.gpg \
       | gpg --dearmor -o /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 bookworm main" \
       > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        kamailio \
        kamailio-extra-modules \
        kamailio-json-modules \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY kamailio.cfg kamailio-local.cfg dispatcher.list flow-routing.default.cfg /etc/kamailio/
COPY run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh && mkdir -p /etc/kamailio/flow

# SIP udp/tcp + RPC http
EXPOSE 5060/udp 5060/tcp 5080/tcp

ENTRYPOINT ["/usr/local/bin/run.sh"]
