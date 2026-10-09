#!/usr/bin/env bash
# Prueba de humo del libro contable. Uso: BASE=http://localhost:8080 KEY=<api key> bash test/smoke.sh
set -u
BASE=${BASE:-http://localhost:8080}; KEY=${KEY:?KEY requerida}
H=(-s -H "x-api-key: $KEY" -H 'content-type: application/json')
ok=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "✔ $1"; ok=$((ok+1)); else echo "✘ $1 — esperado $3, obtenido $2"; fail=$((fail+1)); fi; }
req() { curl "${H[@]}" -o /tmp/r.json -w '%{http_code}' "$@"; }
R=$RANDOM$RANDOM

check "listar activos" "$(req $BASE/v1/assets)" 200
check "crear cliente A sin Idempotency-Key → 400" "$(req -X POST $BASE/v1/clients -d '{"name":"Fondo A"}')" 400
check "crear cliente A" "$(req -X POST -H "idempotency-key: cliA-$R" $BASE/v1/clients -d '{"name":"Fondo A","kind":"fund","assets":["USDC-ETH-SEPOLIA"]}')" 201
A=$(jq -r '.accounts[0].id' /tmp/r.json); CA=$(jq -r .id /tmp/r.json)
check "reintento crear cliente A → misma respuesta" "$(req -X POST -H "idempotency-key: cliA-$R" $BASE/v1/clients -d '{"name":"Fondo A","kind":"fund","assets":["USDC-ETH-SEPOLIA"]}')" 201
check "  …mismo id" "$(jq -r .id /tmp/r.json)" "$CA"
check "misma llave, otro cuerpo → 422" "$(req -X POST -H "idempotency-key: cliA-$R" $BASE/v1/clients -d '{"name":"Otro"}')" 422
check "crear cliente B" "$(req -X POST -H "idempotency-key: cliB-$R" $BASE/v1/clients -d '{"name":"Tesorería B","assets":["USDC-ETH-SEPOLIA"]}')" 201
B=$(jq -r '.accounts[0].id' /tmp/r.json)

DEP='{"kind":"deposit","external_ref":"0xabc'$R'","postings":[{"account":"system:USDC-ETH-SEPOLIA:custody","direction":"debit","amount":"1000000000"},{"account":"'$A'","direction":"credit","amount":"1000000000"}]}'
check "depósito 1,000 USDC a A" "$(req -X POST -H "idempotency-key: dep-$R" $BASE/v1/entries -d "$DEP")" 201
check "reintento depósito (no duplica)" "$(req -X POST -H "idempotency-key: dep-$R" $BASE/v1/entries -d "$DEP")" 201
req $BASE/v1/accounts/$A >/dev/null; check "saldo A = 1000000000" "$(jq -r .balance /tmp/r.json)" 1000000000

check "asiento descuadrado → 422" "$(req -X POST -H "idempotency-key: bad-$R" $BASE/v1/entries -d '{"kind":"adjustment","postings":[{"account":"'$A'","direction":"debit","amount":"5"},{"account":"'$B'","direction":"credit","amount":"4"}]}')" 422
check "monto decimal → 400" "$(req -X POST -H "idempotency-key: dec-$R" $BASE/v1/internal-transfers -d '{"from":"'$A'","to":"'$B'","amount":"1.5"}')" 400
check "transferir 250 USDC A→B" "$(req -X POST -H "idempotency-key: tr1-$R" $BASE/v1/internal-transfers -d '{"from":"'$A'","to":"'$B'","amount":"250000000"}')" 201
check "sobregiro A→B 10,000 → 422" "$(req -X POST -H "idempotency-key: tr2-$R" $BASE/v1/internal-transfers -d '{"from":"'$A'","to":"'$B'","amount":"10000000000"}')" 422
check "  …código insufficient_funds" "$(jq -r .code /tmp/r.json)" insufficient_funds
req $BASE/v1/accounts/$A >/dev/null; check "saldo A = 750000000" "$(jq -r .balance /tmp/r.json)" 750000000
req $BASE/v1/accounts/$B >/dev/null; check "saldo B = 250000000" "$(jq -r .balance /tmp/r.json)" 250000000
req $BASE/v1/accounts/system:USDC-ETH-SEPOLIA:custody >/dev/null; C=$(jq -r .balance /tmp/r.json)
check "historial de A: 2 partidas" "$(req $BASE/v1/accounts/$A/postings; jq '.postings|length' /tmp/r.json)" "2002"

# 20 transferencias concurrentes de 50 USDC desde A (750): exactamente 15 deben pasar
for i in $(seq 1 20); do
  curl "${H[@]}" -o /dev/null -w '%{http_code}\n' -X POST -H "idempotency-key: conc-$i-$R" $BASE/v1/internal-transfers \
    -d '{"from":"'$A'","to":"'$B'","amount":"50000000"}' &
done > /tmp/conc.txt; wait
check "concurrencia: 15 aceptadas" "$(grep -c 201 /tmp/conc.txt)" 15
req $BASE/v1/accounts/$A >/dev/null; check "  …saldo A = 0" "$(jq -r .balance /tmp/r.json)" 0
check "registrar wallet de depósito" "$(req -X POST $BASE/v1/wallets -d '{"client_id":"'$CA'","chain":"ethereum","network":"eth-sepolia","address":"0x'$(openssl rand -hex 20)'","purpose":"deposit"}')" 201
check "sin API key → 401" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/v1/assets)" 401
echo "── $ok OK, $fail fallas"; [[ $fail == 0 ]]
