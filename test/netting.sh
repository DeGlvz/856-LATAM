#!/usr/bin/env bash
# Prueba del motor de compensación. Uso: BASE=http://localhost:8080 KEY=<api key> bash test/netting.sh
set -u
BASE=${BASE:-http://localhost:8080}; KEY=${KEY:?KEY requerida}; AS=USDC-ETH-SEPOLIA
H=(-s -H "x-api-key: $KEY" -H 'content-type: application/json')
ok=0; fail=0; R=$RANDOM$RANDOM
check() { if [[ "$2" == "$3" ]]; then echo "✔ $1"; ok=$((ok+1)); else echo "✘ $1 — esperado $3, obtenido $2"; fail=$((fail+1)); fi; }
req() { curl "${H[@]}" -o /tmp/n.json -w '%{http_code}' "$@"; }
client() { req -X POST -H "idempotency-key: cl-$1-$R" $BASE/v1/clients -d '{"name":"Cliente '$1'","assets":["'$AS'"]}' >/dev/null; jq -r .id /tmp/n.json; }
acct() { jq -r '.accounts[0].id' <(curl "${H[@]}" $BASE/v1/clients/$1); }
bal() { curl "${H[@]}" $BASE/v1/accounts/$(acct $1) | jq -r .balance; }
fund() { req -X POST -H "idempotency-key: f-$1-$2-$R" $BASE/v1/entries -d '{"kind":"deposit","postings":[{"account":"system:'$AS':custody","direction":"debit","amount":"'$2'"},{"account":"'$(acct $1)'","direction":"credit","amount":"'$2'"}]}' >/dev/null; }
ob() { req -X POST -H "idempotency-key: ob-$1-$2-$3-$4-$R" $BASE/v1/obligations -d '{"debtor_id":"'$1'","creditor_id":"'$2'","asset_id":"'$AS'","amount":"'$3'","external_ref":"'$4'"}'; }

A=$(client A); B=$(client B); C=$(client C); D=$(client D)
fund $A 100000000   # A tiene 100 USDC
check "obligación A→B 100 (OC-1)" "$(ob $A $B 100000000 OC-1)" 201
check "obligación B→C 100 (OC-2)" "$(ob $B $C 100000000 OC-2)" 201
check "obligación C→A 100 (OC-3)" "$(ob $C $A 100000000 OC-3)" 201
check "obligación A→D 30 (OC-4)"  "$(ob $A $D 30000000 OC-4)" 201
check "deudor = acreedor → 422" "$(ob $A $A 1 X)" 422
IDS=$(curl "${H[@]}" "$BASE/v1/obligations?status=open&asset_id=$AS&limit=1000" | jq -c --arg a $A --arg b $B --arg c $C --arg d $D '[.obligations[]|select(.debtor_id==$a or .debtor_id==$b or .debtor_id==$c or .debtor_id==$d)|.id]')
SCOPE='{"asset_id":"'$AS'","obligation_ids":'$IDS'}'

check "preview" "$(req -X POST $BASE/v1/netting/preview -d "$SCOPE")" 200
check "  …bruto 330 USDC" "$(jq -r .gross_amount /tmp/n.json)" 330000000
check "  …neto 30 USDC" "$(jq -r .net_amount /tmp/n.json)" 30000000
check "  …ahorro 9090 bps" "$(jq -r .savings_bps /tmp/n.json)" 9090
check "  …se puede liquidar" "$(jq -r .can_settle /tmp/n.json)" true

check "ejecutar compensación" "$(req -X POST -H "idempotency-key: run1-$R" $BASE/v1/netting/runs -d "$SCOPE")" 201
RUN=$(jq -r .id /tmp/n.json)
check "  …4 obligaciones liquidadas" "$(jq '.obligations|length' /tmp/n.json)" 4
check "reintento misma llave → misma corrida" "$(req -X POST -H "idempotency-key: run1-$R" $BASE/v1/netting/runs -d "$SCOPE"; jq -r .id /tmp/n.json)" "201$RUN"
check "segunda corrida → nada que compensar" "$(req -X POST -H "idempotency-key: run2-$R" $BASE/v1/netting/runs -d "$SCOPE")" 422
check "saldo A = 70" "$(bal $A)" 70000000
check "saldo B = 0"  "$(bal $B)" 0
check "saldo C = 0"  "$(bal $C)" 0
check "saldo D = 30" "$(bal $D)" 30000000

# Faltante: B debe 50 a D y no tiene saldo
ob $B $D 50000000 FAC-9 >/dev/null; OB=$(jq -r .id /tmp/n.json); S2='{"asset_id":"'$AS'","obligation_ids":["'$OB'"]}'
req -X POST $BASE/v1/netting/preview -d "$S2" >/dev/null
check "preview con faltante: no liquidable" "$(jq -r .can_settle /tmp/n.json)" false
check "  …faltante de B = 50" "$(jq -r --arg b $B '.positions[]|select(.client_id==$b).shortfall' /tmp/n.json)" 50000000
check "corrida con faltante → 422" "$(req -X POST -H "idempotency-key: run3-$R" $BASE/v1/netting/runs -d "$S2"; jq -r .code /tmp/n.json)" "422insufficient_funds"
check "  …la obligación sigue abierta" "$(curl "${H[@]}" "$BASE/v1/obligations?client_id=$B&status=open" | jq '.obligations|length')" 1
fund $B 50000000
# Dos corridas simultáneas sobre lo mismo: solo una liquida
for k in a b; do curl "${H[@]}" -o /dev/null -w '%{http_code}\n' -X POST -H "idempotency-key: run4$k-$R" $BASE/v1/netting/runs -d "$S2" & done > /tmp/nc.txt; wait
check "concurrencia: una 201 y una 422" "$(sort /tmp/nc.txt | tr '\n' ' ')" "201 422 "
check "saldo D = 80" "$(bal $D)" 80000000

ob $C $D 1000 X >/dev/null; OX=$(jq -r .id /tmp/n.json)
check "cancelar obligación" "$(req -X POST $BASE/v1/obligations/$OX/cancel)" 200
check "cancelar otra vez → 409" "$(req -X POST $BASE/v1/obligations/$OX/cancel)" 409
check "consultar corrida" "$(req $BASE/v1/netting/runs/$RUN; jq -r .net_amount /tmp/n.json)" "20030000000"
echo "── $ok OK, $fail fallas"; [[ $fail == 0 ]]
