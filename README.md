# cripto-api

API REST (Node 22 + TypeScript + Fastify + viem) sobre RPC de **Alchemy**, con **PostgreSQL** como libro contable. Desplegado en **Railway** (núcleo + base de datos); imagen portable a Akash/Flux.

## Endpoints
| Método | Ruta | Auth |
|---|---|---|
| GET | `/health` | — |
| GET | `/v1/block/latest` | `x-api-key` |
| GET | `/v1/address/:address/balance` | `x-api-key` |
| GET | `/v1/address/:address/tokens` (ERC-20, `alchemy_getTokenBalances`) | `x-api-key` |
| GET | `/v1/tx/:hash` | `x-api-key` |
| POST | `/v1/webhooks/alchemy` (Alchemy Notify) | firma HMAC `x-alchemy-signature` |

### Libro contable (fase 1)
| Método | Ruta | Notas |
|---|---|---|
| GET/POST | `/v1/assets` | Al crear un activo se abren sus cuentas de sistema (`custody`, `fees`, `equity`) |
| POST | `/v1/clients` | **Idempotency-Key**. `assets: [...]` abre cuentas `available` |
| GET | `/v1/clients/:id` | Cliente + cuentas con saldo |
| POST | `/v1/clients/:id/accounts` | `{ "asset_id": "USDC-ETH-SEPOLIA" }` |
| GET | `/v1/accounts/:id\|code` · `/v1/accounts/:ref/postings?limit&before` | Saldo e historial paginado |
| GET/POST | `/v1/wallets` | Direcciones on-chain (sin llaves privadas) |
| POST | `/v1/entries` | **Idempotency-Key**. Asiento de doble partida genérico |
| GET | `/v1/entries/:id` | Asiento con sus partidas |
| POST | `/v1/internal-transfers` | **Idempotency-Key**. `{from,to,amount}` sin gas |

Reglas del libro:
- Montos en **unidades base** como string entero (`"1000000"` = 1 USDC de 6 decimales).
- Por asiento y activo, débitos = créditos (validado en la API y por trigger al `COMMIT`).
- Cuentas de cliente = pasivo, nunca negativas (`insufficient_funds`). Custodia = activo.
- `postings` y `journal_entries` son inmutables: se corrige con asiento de reverso.
- Concurrencia: bloqueo `FOR UPDATE` en orden fijo; probado con 20 cargos simultáneos sin sobregiro.
- Idempotencia: misma llave + mismo cuerpo → misma respuesta (`idempotent-replayed: true`); otro cuerpo → 422.
- Migraciones embebidas, se aplican al arrancar (`MIGRATE_ON_START`), con candado para varias réplicas.

Prueba de humo: `BASE=https://… KEY=<api key> bash test/smoke.sh`

## Local
```bash
cp .env.example .env   # completar ALCHEMY_API_KEY, API_KEYS y DATABASE_URL
npm i && npm run dev
curl -H 'x-api-key: clave-cliente-1' localhost:8080/v1/block/latest
```

## Despliegue en Akash
```bash
docker build -t ghcr.io/TU_USUARIO/cripto-api:1.0.0 .
docker push ghcr.io/TU_USUARIO/cripto-api:1.0.0
# Editar deploy.yaml (imagen + variables) y desplegar desde console.akash.network
# o con: provider-services tx deployment create deploy.yaml --from <wallet>
```
Después, en Alchemy → Webhooks, apuntar a `https://<uri-akash>/v1/webhooks/alchemy` y copiar el *signing key*.

## Consideraciones de seguridad
- Las variables del SDL son visibles para el proveedor Akash. Para producción usar una API key de Alchemy restringida (allowlist de dominios/IP, solo métodos necesarios) y rotarla.
- Akash expone HTTP en el ingress del proveedor; para TLS propio, poner Cloudflare (proxy) delante con dominio personalizado.
- Red: cambiar `ALCHEMY_NETWORK` (`eth-mainnet`, `base-mainnet`, `polygon-mainnet`, `arb-mainnet`…).
