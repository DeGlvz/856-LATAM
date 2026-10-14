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

Prueba: `node test/console-fase3.e2e.mjs` (28 verificaciones, cadena local con depósito, barrido y retiro reales).

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

### Consola — fase 5: auditoría, doble aprobación y 2FA
- **2FA (TOTP)** en *Seguridad*: alta con QR o clave manual (Google/Microsoft Authenticator, 1Password…), baja con código vigente. Con 2FA activo el login pide el código en un segundo paso (`POST /v1/auth/login` → `{mfa_required, mfa_token}` → `POST /v1/auth/login/totp {mfa_token, code}`). Un código no se acepta dos veces (anti-reuso por paso de tiempo). El secreto se guarda cifrado con AES-256-GCM.
- **Doble aprobación** de retiros y corridas de compensación (pantalla *Aprobaciones*, con contador en el menú):
  - Retiro: el saldo se reserva al pedirlo (`approval_status: pending`); el worker no firma hasta que **otro** tesorero lo apruebe. Rechazar devuelve el saldo (motivo obligatorio).
  - Corrida: se solicita (`202`, `pending_approval`) con las obligaciones exactas y el neto simulado; al aprobar se liquida en un asiento solo si nada cambió (si cambió → `409 scope_changed` / `422 obligations_not_open`, la corrida sigue pendiente con `last_error` y se puede rechazar).
  - Reglas: quien solicita no aprueba (`403 same_operator`); solo operadores de consola aprueban (`403 operator_only`); con `APPROVAL_REQUIRE_2FA=true` el aprobador necesita 2FA activo (`403 totp_required`) y un código por aprobación.
- **Auditoría** (solo tesorero): bitácora con filtros por actor, acción, resultado (correcto / error / denegado), objetivo y fechas; paginación y exportación CSV. Ahora guarda el motivo de cancelaciones y rechazos.
- **Operadores** (tesorero): estado de 2FA y *Restablecer 2FA* de otro operador (teléfono perdido; cierra sus sesiones, exige motivo, no aplica a uno mismo).

| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/auth/login/totp` | Segundo paso del login (público, limitado a 10/min) |
| POST | `/v1/auth/totp/setup` · `/enable` · `/disable` | El propio operador; `enable`/`disable` exigen `{code}` |
| GET | `/v1/approvals` | Retiros y corridas pendientes + política vigente |
| POST | `/v1/withdrawals/:id/approve` · `/reject` | Tesorero. `{code}` para aprobar; `{reason}` para rechazar |
| POST | `/v1/netting/runs/:id/approve` · `/reject` | Ídem |
| GET | `/v1/netting/runs?status=` | `pending_approval` · `settled` · `rejected` |
| GET | `/v1/audit` · `/v1/audit/actions` | Tesorero. `actor, action, result, target, from, to, limit, cursor` |
| GET | `/v1/operators` · POST `/v1/operators/:id/totp/reset` | Tesorero |

Variables nuevas (migración `009`):

| Variable | Por defecto | Uso |
|---|---|---|
| `DUAL_APPROVAL` | `console` | `off` · `console` (solo lo pedido desde la consola) · `all` (también por API key) |
| `APPROVAL_REQUIRE_2FA` | `true` | El aprobador debe tener 2FA y confirmar con código |
| `TOTP_ENCRYPTION_KEY` | — | **Requerida para activar 2FA.** Mínimo 32 caracteres aleatorios (p. ej. `openssl rand -hex 32`). No cambiarla después: los secretos existentes dejarían de descifrarse |
| `TOTP_ISSUER` | `856-LATAM` | Nombre que muestra la app de autenticación |

> Operación: con `DUAL_APPROVAL` activo se necesitan **al menos dos tesoreros con 2FA**. Alta: `npm run operator:create -- <correo> tesorero`.

Pruebas: `node test/console-fase5.e2e.mjs` (56 verificaciones, cadena local) y navegador con Playwright:
```bash
cd test/playwright && npm ci && npx playwright install chromium
BASE=http://localhost:8080 KEY=… DATABASE_URL=… BOOT_EMAIL=… BOOT_PASS=… npx playwright test   # 6 recorridos
```

### Reemplazo de transacciones atascadas (gas bump)
Si un retiro o barrido enviado no se mina en `GAS_BUMP_AFTER_SEC`, el worker lo vuelve a firmar con el **mismo nonce** y comisiones más altas (`+GAS_BUMP_PERCENT` %, o la estimación actual si es mayor) y lo reenvía.
- Todos los envíos quedan en `tx_attempts` (original, automático o manual, con autor). Solo uno puede minarse; la confirmación busca el recibo del hash vigente **y de todos los intentos anteriores**, y adopta el que se haya minado.
- Tope: si la comisión necesaria supera `GAS_BUMP_MAX_FEE_WEI`, se detiene y deja el motivo en `last_error`. Máximo `GAS_BUMP_MAX_ATTEMPTS` aceleraciones.
- Si el nonce ya se minó, no se reemplaza (`409 already_mined`): se confirma en el siguiente ciclo.
- Manual (tesorero): botón **Acelerar (subir gas)** en el detalle del retiro, o `POST /v1/withdrawals/:id/bump` · `POST /v1/sweeps/:id/bump`. Toma el mismo candado del worker. Historial: `attempts_log` en el detalle del retiro, `GET /v1/sweeps/:id/attempts`.

| Variable | Por defecto | Uso |
|---|---|---|
| `GAS_BUMP_ENABLED` | `true` | Aceleración automática en el worker |
| `GAS_BUMP_AFTER_SEC` | `300` | Tiempo sin minarse antes de acelerar |
| `GAS_BUMP_PERCENT` | `25` | Aumento por intento (mín. 11; la red exige ≥ 10 %) |
| `GAS_BUMP_MAX_FEE_WEI` | `300000000000` | Tope de `maxFeePerGas` (300 gwei) |
| `GAS_BUMP_MAX_ATTEMPTS` | `6` | Aceleraciones máximas por transacción |

Prueba: `node test/gas-bump.e2e.mjs` (cadena local con minado manual; API con `GAS_BUMP_AFTER_SEC=3`).

### Portal de clientes — fase 1: identidad, usuarios y llaves de API
Portal web en `/portal` (separado de la consola: otra cookie, otra cabecera anti-CSRF, otros hooks) y API en `/v1/portal`. **El `client_id` nunca viaja en la petición**: sale de la sesión o de la llave; acceder a datos de otro cliente responde `404`.

**Alta:** 856 solo invita al **primer admin** desde la consola (detalle del cliente → *Portal del cliente* → *Invitar primer admin*, rol tesorero). El enlace (`/portal/invitacion#<token>`, 72 h, un solo uso) se muestra una vez; el token va en el fragmento y nunca llega al servidor en la URL. Después, el admin del cliente invita y administra a su gente.

| Rol | Puede | 2FA |
|---|---|---|
| `viewer` (Consulta) | Ver | Opcional |
| `operator` (Operador) | Preparar operaciones (fases 3–4) | Opcional |
| `approver` (Aprobador) | Aprobar (fases 3–4) | **Obligatorio** |
| `admin` (Administrador) | Usuarios y llaves de API | **Obligatorio** |

- Aprobador/admin sin 2FA solo pueden activarlo (`403 totp_enrollment_required` en lo demás). Al activar se entregan 10 códigos de recuperación de un uso (se guardan como SHA-256).
- El admin puede restablecer el 2FA de otro usuario con motivo (queda en bitácora); no puede cambiarse a sí mismo ni dejar al cliente sin admin.
- Cambiar rol, desactivar o restablecer 2FA cierra las sesiones del usuario.

**Llaves de API** (solo admin, con código 2FA; vigencia máx. `PORTAL_KEY_MAX_DAYS`, lista de IP opcional):
- **Firma Ed25519 (recomendada).** El par se genera en el navegador (WebCrypto); a 856 solo viaja la pública, con prueba de posesión (firma de un reto de un uso). La privada se descarga **una vez**, cifrada con la frase del usuario (PBKDF2-SHA256 600k + AES-256-GCM). Cada petición lleva `x-856-key`, `x-856-timestamp`, `x-856-nonce`, `x-856-signature` = Ed25519 sobre `MÉTODO\nRUTA?QUERY\nTS\nNONCE\nsha256(cuerpo)` (base64url). Ventana ±`PORTAL_SIG_WINDOW_SEC`, nonce irrepetible, `PORTAL_SIG_MAX_FAILS` firmas inválidas → `423` 15 min.
- **Token de lectura** (`856r_…`, con dígito verificador) para tableros/BI: `Authorization: Bearer`, solo `GET`; 856 guarda únicamente su SHA-256.
- **Rotación sin corte:** la llave nueva convive `PORTAL_KEY_OVERLAP_DAYS` con la anterior. Revocación inmediata.
- En fase 1 las llaves solo autentican `GET /v1/portal/me` y `GET /v1/portal/ping`; las operaciones llegan en fases 2–4.

| Método y ruta | Uso |
|---|---|
| `POST /v1/portal/auth/login` · `/auth/login/totp` · `/auth/logout` | Sesión (cookie `__Host-c856p` + cabecera `x-856-portal: 1`); 2FA con código o código de recuperación |
| `GET /v1/portal/me` · `GET /v1/portal/ping` | Identidad (sesión o llave) |
| `POST /v1/portal/auth/totp/setup` · `/enable` · `/disable` · `/auth/recovery-codes` | 2FA propio |
| `POST /v1/portal/invites/lookup` · `/invites/accept` | Aceptar invitación (públicas, el token es la credencial) |
| `GET /v1/portal/users` · `PATCH /users/:id` · `POST /users/:id/totp/reset` | Usuarios (admin) |
| `GET /v1/portal/users/invites` · `POST /users/invites` · `POST /users/invites/:id/revoke` | Invitaciones (admin) |
| `GET /v1/portal/keys` · `POST /keys/challenge` · `POST /keys` · `POST /keys/:id/rotate` · `POST /keys/:id/revoke` | Llaves (admin) |
| `GET /v1/clients/:id/portal` · `POST /v1/clients/:id/portal-invite` | Consola: estado del portal e invitación del primer admin |

Toda petición del portal queda en `audit_log` con `client_id` (actor `portal:<correo>` o `llave:<prefijo>`). Migración `011_portal_identidad`.

| Variable | Por defecto | Uso |
|---|---|---|
| `PORTAL_SESSION_TTL_MIN` / `PORTAL_SESSION_IDLE_MIN` | `480` / `30` | Vida máxima e inactividad de la sesión |
| `PORTAL_INVITE_TTL_HOURS` | `72` | Vigencia de invitaciones |
| `PORTAL_KEY_MAX_DAYS` / `PORTAL_KEY_OVERLAP_DAYS` | `90` / `7` | Vigencia máxima de llaves y traslape al rotar |
| `PORTAL_SIG_WINDOW_SEC` / `PORTAL_SIG_MAX_FAILS` | `300` / `10` | Ventana de firma y bloqueo por firmas inválidas |
| `ORIGIN_RULE` | `off` | Regla de origen (solo el cliente origina operaciones); se activa en la fase 3 |

Pruebas: `node test/portal-fase1.e2e.mjs` (API: 63 verificaciones, incluye aislamiento entre clientes, repetición, firma alterada, IP y bloqueo) y `npx playwright test portal.spec.mjs` en `test/playwright` (navegador: invitación desde consola, 2FA obligatorio, llave Ed25519 descifrada y usada para firmar, token de lectura, operador sin acceso a administración).

### Consola — administración de operadores
Página **Operadores** (`/console/operadores`, solo tesorero). El alta deja de depender del script: el tesorero invita y la persona define su nombre y contraseña.

- **Invitación** de un solo uso (`/console/invitacion#<token>`, `CONSOLE_INVITE_TTL_HOURS`, 72 h por defecto); el enlace se muestra una vez y el token nunca viaja en la URL al servidor. Se puede revocar mientras esté pendiente.
- **Cambio de rol, desactivar y reactivar.** Cambiar rol o desactivar cierra las sesiones del operador. Nadie puede modificarse a sí mismo (`403 self_change`).
- **Step-up 2FA:** toda escritura de este módulo exige el código TOTP del tesorero que actúa (`403 totp_required` si no tiene 2FA; `422 bad_code`).
- **Siempre un tesorero activo con 2FA** (`409 last_treasurer`), también al apagar el propio 2FA.
- **Alertas de portal:** el Tablero y el detalle del cliente avisan cuando un cliente tiene usuarios en el portal y menos de 2 admins (la recuperación nivel 2 lo exige).
- `create-operator` y `CONSOLE_BOOTSTRAP_*` siguen funcionando para el primer tesorero.

| Método y ruta | Rol | Uso |
|---|---|---|
| `GET /v1/operators` | tesorero | Lista con 2FA, último acceso, sesiones activas y estado |
| `POST /v1/operators/invites` `{email, role, code}` | tesorero + 2FA | Crea invitación; devuelve el enlace una vez |
| `GET /v1/operators/invites` · `POST /v1/operators/invites/:id/revoke` `{code}` | tesorero (+ 2FA al revocar) | Invitaciones pendientes |
| `PATCH /v1/operators/:id` `{role?, active?, code}` | tesorero + 2FA | Rol y activación |
| `POST /v1/auth/invites/lookup` · `/accept` | pública (límite por IP) | Aceptar invitación |
| `GET /v1/clients/portal-alerts` | lectura | Clientes con menos de 2 admins en el portal |

Migración `012_consola_operadores` (`operator_invites`; `operators.deactivated_at/by`). Bitácora: `operator_invite_created|revoked|accepted`, `operator_role_changed`, `operator_deactivated|reactivated`.

Pruebas: `node test/console-operadores.e2e.mjs` (69 verificaciones) y `npx playwright test operadores.spec.mjs` en `test/playwright` (7 recorridos).

### Portal de clientes — fase 2: inicio, cuentas y depósitos
Pantallas **Inicio** (avisos, saldos por activo y movimientos recientes), **Cuentas** (historial paginado, filtro por fechas, CSV y estado de cuenta mensual) y **Depósitos** (direcciones con QR y depósitos recibidos). Todo se filtra por el cliente de la sesión o la llave; un activo o recurso ajeno responde `404`.

- **Saldos:** disponible, reservado en retiros (reservados, firmados o enviados), total = disponible + reservado, y por pagar / por cobrar (obligaciones abiertas). Una sola lectura consistente.
- **Movimientos:** un renglón por asiento con el neto en su cuenta; el concepto se arma con el tipo y la dirección. Nunca se exponen descripciones, metadatos ni referencias internas: solo hash de su depósito, folio de su retiro o corrida donde participó.
- **CSV:** BOM UTF-8 (abre bien en Excel), montos en unidades del activo con todos sus decimales (sin redondeo), máximo 50 000 renglones (`422 too_many_rows`: acote fechas).
- **Estado de cuenta:** mes calendario en UTC; saldo inicial + abonos − cargos = saldo final, consistente con el saldo actual.
- **Direcciones de depósito:** generar una nueva (operador o superior; consulta no puede); las anteriores siguen acreditando.
- **Avisos:** KYB pendiente o cliente suspendido, llaves que vencen en ≤ 14 días, menos de 2 admins activos, 2FA sin activar.
- Las **llaves de API** con permiso de lectura (Ed25519 o token) consultan todos los `GET` de esta fase.

| Método y ruta | Uso |
|---|---|
| `GET /v1/portal/balances` | Saldos por activo |
| `GET /v1/portal/activity?limit` | Últimos movimientos (10, máx. 50) |
| `GET /v1/portal/accounts/:activo/entries?limit&cursor&from&to` · `…/entries.csv` | Historial paginado y CSV |
| `GET /v1/portal/statements/:AAAA-MM?asset=` · `/statements/:AAAA-MM.csv?asset=` | Estado de cuenta mensual |
| `GET /v1/portal/deposit-addresses` · `POST /v1/portal/deposit-addresses` | Direcciones (generar: operador+, solo sesión) |
| `GET /v1/portal/deposits?status&limit&cursor` | Depósitos (pending → credited) |
| `GET /v1/portal/notices` | Avisos |

Sin migraciones ni variables nuevas.

Pruebas: `node test/portal-fase2.e2e.mjs` (79 verificaciones: saldos exactos, precisión > 2^53, paginación, CSV y estado de cuenta que cuadran, depósito real pending → credited, llaves, aislamiento y ausencia de datos internos) y `npx playwright test portal-cuentas.spec.mjs` (5 recorridos).

Pendiente: TRON/BTC/LTC.

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
