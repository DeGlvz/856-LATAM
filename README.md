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
| GET | `/v1/obligations?client_id&status&asset_id&external_ref&from&to&netting_run_id&limit&cursor` | Paginado (`next_cursor`); trae nombre y estado de deudor y acreedor |
| POST | `/v1/obligations/:id/cancel` | `{reason}` (mín. 5). Solo si está `open`; guarda motivo, fecha y autor |
| POST | `/v1/netting/preview` | `{asset_id, cutoff?, obligation_ids?}` → posiciones netas, bruto, neto, `savings_bps`, faltantes, `blocked`, `obligation_ids` simulados. Rol lectura |
| POST | `/v1/netting/runs` | **Idempotency-Key**. `{…alcance, expected_net_amount?}`. Liquida el alcance en un solo asiento `netting` |
| GET | `/v1/netting/runs?asset_id&limit&cursor` | Historial paginado con ahorro y autor |
| GET | `/v1/netting/runs/:id` | Corrida con posiciones y obligaciones liquidadas (con nombres) |

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

### Direcciones de depósito y barrido
| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/clients/:id/deposit-address` | Dirección propia del cliente (HD `m/44'/60'/0'/0/i`); `{rotate:true}` genera otra |
| GET | `/v1/sweeps` | Movimientos internos depósito → hot wallet |

- Cada dirección nueva se registra sola en el webhook Address Activity (Alchemy Notify API); si falla, el worker reintenta.
- Barrido automático: tokens → si la dirección no tiene ETH, la hot wallet le envía gas (`gas_topup`) y luego se barre (`sweep_token`); ETH ≥ `SWEEP_MIN_NATIVE_WEI` → `sweep_native`.
- El barrido no cambia la custodia (es interno); solo el gas se registra en `network_fees`. El gas enviado por la plataforma nunca se acredita como depósito.
- Conciliación (`/v1/treasury/hot-wallet`): on-chain (hot + direcciones de depósito) − custodia en libro.
- Nonces de la hot wallet compartidos entre retiros y barridos (`src/chain/nonce.ts`).

### Consola de operación (fase 1: login + tablero)
Interfaz web en **`/console`** (React + Vite + TypeScript, TanStack Query, Tailwind + shadcn/ui; código en `web/`). Fastify sirve `web/dist`.

| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/auth/login` | `{email, password}` → cookie de sesión `httpOnly`, `Secure`, `SameSite=Strict`. 10 intentos/min por IP |
| GET | `/v1/auth/me` | Operador de la sesión |
| POST | `/v1/auth/logout` | Revoca la sesión en el servidor |
| GET | `/v1/summary` | Tablero: salud, conciliación por activo, gas de la hot wallet, retiros en vuelo, pendientes |
| GET | `/v1/clients?limit&cursor&status&kind&q` | Lista paginada por cursor (`next_cursor`) |
| GET | `/v1/entries?limit&cursor&kind&external_ref&account&client_id&asset_id&from&to&postings` | Asientos con filtros y partidas |

Seguridad:
- `/v1` acepta **x-api-key** (integraciones) **o** sesión de operador (consola). La API key nunca llega al navegador.
- Contraseñas con **argon2id**; la base guarda solo el SHA-256 del token de sesión. Sesión de 8 h con cierre a los 30 min de inactividad.
- 5 intentos fallidos bloquean la cuenta 15 min; el mensaje de error no revela si el correo existe.
- Escrituras desde la consola exigen el header `x-856-console: 1` (defensa CSRF adicional a `SameSite=Strict`).
- Roles: **lectura** (solo consulta) · **operador** (altas de clientes, cuentas, obligaciones, depósitos) · **tesorero** (retiros, asientos, transferencias internas, corridas de compensación, activos, wallets, worker).
- Bitácora `audit_log` inmutable: login, fallos, logout, accesos denegados y toda escritura hecha desde la consola.

Alta de operadores:
- Primer tesorero: definir `CONSOLE_BOOTSTRAP_EMAIL` y `CONSOLE_BOOTSTRAP_PASSWORD` (mín. 12), arrancar una vez y **borrar la contraseña** de las variables. Solo actúa si no hay operadores.
- Siguientes: `npm run operator:create -- <email> <lectura|operador|tesorero> [nombre]` (pide la contraseña por stdin).

Desarrollo: `npm run dev` (API en :8080) y `npm --prefix web run dev` (Vite con proxy de `/v1`; usar `COOKIE_SECURE=false` en local).
Prueba: `node test/console.e2e.mjs` (58 verificaciones: sesión, roles, CSRF, bitácora, tablero, paginación, estáticos).

### Consola — fase 2: clientes y cuentas
Pantallas: lista de clientes (búsqueda, filtros por estado y tipo, paginación), detalle del cliente (cuentas y saldos, direcciones de depósito, lista blanca, asientos recientes), cuenta con su historial de partidas y detalle de asiento.

| Método | Ruta | Notas |
|---|---|---|
| PATCH | `/v1/clients/:id` | `{name?, external_id?, metadata?, status?, reason?}`. Cerrar: solo tesorero |
| GET | `/v1/clients/:id` | Ahora incluye `allowed_transitions`, `status_reason`, `status_changed_at` |
| PATCH | `/v1/wallets/:id` | `{active}`: activa/desactiva lista blanca o depósito (tesorero) |

Ciclo de vida del cliente (migración `007`):
- `pending_kyb → active | closed` · `active → suspended | closed` · `suspended → active | closed` · `closed` es definitivo.
- Suspender o cerrar exige motivo (mín. 5 caracteres); queda en el cliente y en la bitácora.
- Cerrar exige saldos en cero y nada abierto (retiros en vuelo, depósitos pendientes, obligaciones).
- **Bloqueo en base de datos**: un cliente `suspended` o `closed` no puede disponer de saldo (cualquier débito a su cuenta se rechaza: retiros, transferencias, pagos netos, asientos manuales). Sí puede recibir.
- **Retiros solo para clientes `active`** (KYB aprobado): `pending_kyb`, `suspended` y `closed` reciben `422 client_not_active`.
- Compensación: si un pagador neto está suspendido o cerrado, la corrida completa se rechaza (todo o nada); se excluyen sus obligaciones o se reactiva antes de correr.
- Cliente cerrado: no admite nuevas direcciones de depósito ni de lista blanca.
- `POST /v1/wallets` valida direcciones Ethereum.

Prueba: `node test/console-fase2.e2e.mjs` (38 verificaciones).

### Consola — fase 3: retiros, depósitos y barridos
Pantalla **Retiros y depósitos** (`/console/movimientos`) con pestañas Retiros · Depósitos · Barridos, filtros por estado y cliente, paginación y refresco cada 15 s.
- **Nuevo retiro** (tesorero): cliente activo → activo con saldo → destino de su lista blanca → monto en unidades humanas (convertido a unidades base sin float) → pantalla de confirmación con el monto exacto y las unidades base.
- **Detalle del retiro**: línea de tiempo (reservado → firmado → enviado → confirmado), hash, confirmaciones, nonce, gas pagado, último error, asientos de reserva/liquidación/reverso; **cancelar** con motivo mientras esté reservado.
- **Reportar depósito** por hash (operador) y **ciclo del worker** a demanda (tesorero).
- `GET /v1/withdrawals`, `/v1/deposits`, `/v1/sweeps`: ahora con `cursor`/`next_cursor`, filtro `asset_id` y nombre del cliente; estados validados. `POST /v1/withdrawals/:id/cancel` acepta `{reason}` y registra quién canceló.

Prueba: `node test/console-fase3.e2e.mjs` (27 verificaciones, cadena local con depósito, barrido y retiro reales).

### Consola — fase 4: compensación
Pantalla **Compensación** (`/console/compensacion`) con pestañas Obligaciones · Simular y liquidar · Corridas, filtrada por activo.
- **Obligaciones**: filtros por estado y referencia (OC, factura, CFDI), paginación, alta (operador) con selector de deudor/acreedor y monto en unidades humanas sin float, detalle y **cancelación con motivo** (operador).
- **Simular**: alcance "todas las abiertas al corte" (las que no tienen vencimiento entran siempre) o **selección** marcada en la lista. Muestra bruto, neto, ahorro y, por cliente, por cobrar/por pagar/neto/disponible, faltantes y pagadores bloqueados.
- **Liquidar** (tesorero): confirmación con el neto exacto y unidades base; se envían los `obligation_ids` simulados y `expected_net_amount`. Si el alcance cambió desde la simulación → `409 scope_changed` y nada se mueve.
- **Corridas**: historial con ahorro y quién ejecutó; detalle con posiciones, obligaciones liquidadas y acceso al asiento.
- **Detalle del cliente**: tarjeta de obligaciones (por pagar / por cobrar).

Reglas nuevas del motor (migración `008`):
- Obligación con un cliente cerrado → `409 client_closed`; deudor o acreedor inexistente → `404`.
- `obligation_ids` que ya no están abiertas o no corresponden al activo/corte → `422 obligations_not_open` (antes se ignoraban).
- Pagador neto suspendido o cerrado: la simulación lo marca (`blocked`, `can_settle: false`) y la corrida responde `422 client_not_active` con el nombre del cliente.
- Cada corrida guarda `created_by` (correo del operador o `api:xxxx`); cada cancelación, `cancel_reason`, `cancelled_at` y `cancelled_by`. Todo queda además en la bitácora.

Prueba: `node test/console-fase4.e2e.mjs` (41 verificaciones; no requiere cadena).

Pendiente: reemplazo de tx atascadas (gas bump), TRON/BTC/LTC.

Pruebas: `bash test/smoke.sh` (libro), `bash test/netting.sh` (compensación), `node test/console-fase4.e2e.mjs` (consola de compensación), `node test/transfers.e2e.mjs` y `node test/deposits-sweep.e2e.mjs` (on-chain, contra cadena local Hardhat/Anvil).

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
