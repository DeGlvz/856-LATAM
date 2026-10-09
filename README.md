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

### Compensación (fase 2)
| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/obligations` | **Idempotency-Key**. `{debtor_id, creditor_id, asset_id, amount, due_at?, external_ref?}` (OC, factura, CFDI) |
| GET | `/v1/obligations?client_id&status&asset_id` | |
| POST | `/v1/obligations/:id/cancel` | Solo si está `open` |
| POST | `/v1/netting/preview` | `{asset_id, cutoff?, obligation_ids?}` → posiciones netas, bruto, neto, `savings_bps`, faltantes |
| POST | `/v1/netting/runs` | **Idempotency-Key**. Liquida el alcance en un solo asiento `netting` |
| GET | `/v1/netting/runs/:id` | Corrida con posiciones y obligaciones liquidadas |

Reglas del motor:
- Netting multilateral: cada cliente solo paga o recibe `por cobrar − por pagar`. Un ciclo A→B→C→A se liquida sin mover saldo.
- Todo o nada: si un pagador neto no tiene saldo, la corrida se rechaza (`insufficient_funds`) y nada cambia.
- Obligaciones bloqueadas durante la corrida: dos corridas simultáneas no liquidan lo mismo dos veces.

### Transferencias on-chain (fase 3)
| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/withdrawals` | **Idempotency-Key**. `{client_id, asset_id, to_address, amount}` → 202 `reserved` |
| GET | `/v1/withdrawals` · `/v1/withdrawals/:id` | Estado, hash, confirmaciones, gas |
| POST | `/v1/withdrawals/:id/cancel` | Solo en `reserved` (antes de firmar) |
| POST | `/v1/deposits/report` | `{tx_hash}`: detecta depósitos nativos/ERC-20 a wallets `deposit` |
| GET | `/v1/deposits` | `pending` → `credited` |
| POST | `/v1/webhooks/alchemy` | Address Activity firmado: detecta depósitos automáticamente |
| GET | `/v1/treasury/hot-wallet` | Conciliación: saldo on-chain de la hot wallet vs custodia en libro |
| POST | `/v1/worker/tick` | Ejecuta un ciclo del worker (operación/pruebas) |

Ciclo de un retiro: `reserved → signed → broadcast → confirmed` (o `failed` / `cancelled`).
- **Reserva**: al aceptarlo, el saldo pasa de *disponible* a `withdrawals_pending` (no se puede gastar dos veces).
- **Firma**: el worker firma y guarda la tx **antes** de enviarla; si el proceso cae, se reenvía la misma tx (mismo nonce, mismo hash).
- **Confirmación**: con `CONFIRMATIONS` bloques se liquida: sale de custodia y el gas se registra en `network_fees`. Si revierte o no se puede firmar tras 5 intentos, el saldo vuelve al cliente.
- Solo a direcciones en **lista blanca** del cliente (`wallets.purpose = withdrawal_whitelist`).
- El ETH de la hot wallet para gas debe registrarse en el libro (asiento `adjustment`: débito `system:ETH-SEPOLIA:custody`, crédito `system:ETH-SEPOLIA:equity`); si no, la liquidación se detiene con un aviso en `last_error`.
- Firma detrás de la interfaz `Signer` (`src/chain/signer.ts`). Hoy `LocalKeySigner` (**solo testnet**, bloqueado en mainnet); mañana MPC sin tocar el flujo.
- Depósitos: se revalidan contra la cadena y se acreditan una sola vez (`tx_hash + log_index`) al llegar a N confirmaciones.

Pendiente: barrido (*sweep*) de wallets de depósito a la hot wallet, reemplazo de tx atascadas (gas bump), TRON/BTC/LTC.

Pruebas: `bash test/smoke.sh` (libro), `bash test/netting.sh` (compensación) y `node test/transfers.e2e.mjs` (on-chain, contra cadena local Hardhat/Anvil).

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
