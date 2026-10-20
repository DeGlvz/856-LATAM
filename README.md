# 856-LATAM

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

### Simulación informativa de cargas S2S
Las rutas `POST /v1/assets`, `POST /v1/clients`, `POST /v1/entries` y `POST /v1/portal/obligations/import` aceptan `x-856-simulate: true`. El payload pasa por la validación de estructura, referencias activas, unidades base y reglas contables aplicables dentro de una transacción PostgreSQL dedicada que siempre termina en `ROLLBACK`; ninguna fila de prueba ni importación queda persistida. La respuesta válida es HTTP 200 con una huella SHA-256 del alcance, `provider_calls: 0` y datos sintéticos de wallet, IBAN `ZZ…` y webhook interno `processed`. Las fallas responden HTTP 422 con `{ "errors": [{ "fila": 2, "campo": "monto", "motivo": "…" }] }`.

Los montos se envían como **string de entero positivo en unidades base**: USDC tiene 6 decimales (por ejemplo, `"1000001"` = 1.000001 USDC), EURe y ETH tienen 18 (por ejemplo, `"1000000000000000001"` = 1.000000000000000001). Los CSV de obligaciones conservan el formato empresarial existente: valor decimal en texto, punto como separador, sin agrupadores ni redondeo; el simulador convierte a unidades base usando los decimales del activo y rechaza precisión excedente.

La importación S2S del portal debe autenticarse con una llave Ed25519 `trade`; la firma cubre método, ruta, timestamp, nonce y SHA-256 del cuerpo crudo, usando los headers `x-856-key`, `x-856-timestamp`, `x-856-nonce` y `x-856-signature`. El aprovisionamiento `/v1` conserva su autenticación existente (`x-api-key` o sesión de operador): esas credenciales globales no tienen una llave Ed25519 de cliente asociada en el diseño actual.

Una importación completa y sin errores escribe, después del rollback, el único dato durable de la simulación: `audit_log.action = template_simulation_passed` con su cliente y huella. El detalle del cliente devuelve `metadata.simulation_status` (`passed` si hay una simulación exitosa en las últimas 24 horas, `pending` si no la hay) y la consola lo presenta como indicador de precaución, no como control de acceso. La activación fiat por cliente no depende de una simulación previa: el tesorero puede proceder cuando corresponda. Glosario: **unidad base** = entero mínimo del activo; **huella** = SHA-256 de ruta, cliente y payload; **dry-run** = validación transaccional con rollback obligatorio.

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
- Roles: **lectura** (solo consulta) · **ejecutivo** — *Ejecutivo de cuenta*, antes «operador» (altas de clientes, cuentas, obligaciones, depósitos) · **tesorero**, el superusuario (retiros, asientos, transferencias internas, corridas de compensación, activos, wallets, worker, operadores).
- Bitácora `audit_log` inmutable: login, fallos, logout, accesos denegados y toda escritura hecha desde la consola.

Alta de operadores:
- Primer tesorero: definir `CONSOLE_BOOTSTRAP_EMAIL` y `CONSOLE_BOOTSTRAP_PASSWORD` (mín. 12), arrancar una vez y **borrar la contraseña** de las variables. Solo actúa si no hay operadores.
- Siguientes: `npm run operator:create -- <email> <lectura|ejecutivo|tesorero> [nombre]` (`operador` se acepta como alias de `ejecutivo`) (pide la contraseña por stdin).

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
- `POST /v1/clients/:id/retire` (tesorero, motivo ≥5) **siempre se ejecuta**, tras doble confirmación en la consola (casilla + advertencia final). Cancela obligaciones abiertas/pendientes, retiros solo reservados (con reverso en el ledger) y avisos fiat abiertos; conserva retiros firmados/enviados y depósitos por confirmar; revoca usuarios, sesiones y llaves. Con saldos: los pone en cero (asiento de ajuste a `retired_balances`) y archiva (cierra y anonimiza). Sin saldos ni historial: borra. Responde qué se resolvió (`resolved`) y qué se conservó (`preserved`).
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

### Consola — fase 5: auditoría, autorización y 2FA
- **2FA (TOTP)** en *Seguridad*: alta con QR o clave manual (Google/Microsoft Authenticator, 1Password…), baja con código vigente. Con 2FA activo el login pide el código en un segundo paso (`POST /v1/auth/login` → `{mfa_required, mfa_token}` → `POST /v1/auth/login/totp {mfa_token, code}`). Un código no se acepta dos veces (anti-reuso por paso de tiempo). El secreto se guarda cifrado con AES-256-GCM.
- **Autorización** de retiros y corridas de compensación (pantalla *Aprobaciones*, con contador en el menú):
  - Retiro de cliente/API: el saldo se reserva al pedirlo (`approval_status: pending`); el worker no firma hasta que **un** ejecutivo de cuenta o tesorero distinto lo autorice. Una sola aprobación basta; rechazar devuelve el saldo (motivo obligatorio). Una instrucción ingresada por un ejecutivo o tesorero en consola puede pasar al worker directamente.
  - Corrida: se solicita (`202`, `pending_approval`) con las obligaciones exactas y el neto simulado; al aprobar se liquida en un asiento solo si nada cambió (si cambió → `409 scope_changed` / `422 obligations_not_open`, la corrida sigue pendiente con `last_error` y se puede rechazar).
  - Reglas: quien solicita no aprueba (`403 same_operator`); solo operadores de consola aprueban (`403 operator_only`); con `APPROVAL_REQUIRE_2FA=true` el aprobador necesita 2FA activo (`403 totp_required`) y un código por aprobación.
- **Auditoría** (solo tesorero): bitácora con filtros por actor, acción, resultado (correcto / error / denegado), objetivo y fechas; paginación y exportación CSV. Ahora guarda el motivo de cancelaciones y rechazos.
- **Operadores** (tesorero): estado de 2FA y *Restablecer 2FA* de otro operador (teléfono perdido; cierra sus sesiones, exige motivo, no aplica a uno mismo).

| Método | Ruta | Notas |
|---|---|---|
| POST | `/v1/auth/login/totp` | Segundo paso del login (público, limitado a 10/min) |
| POST | `/v1/auth/totp/setup` · `/enable` · `/disable` | El propio operador; `enable`/`disable` exigen `{code}` |
| GET | `/v1/approvals` | Retiros y corridas pendientes + política vigente |
| POST | `/v1/withdrawals/:id/approve` · `/reject` | Ejecutivo de cuenta o tesorero. `{code}` para aprobar; `{reason}` para rechazar |
| POST | `/v1/netting/runs/:id/approve` · `/reject` | Ídem |
| GET | `/v1/netting/runs?status=` | `pending_approval` · `settled` · `rejected` |
| GET | `/v1/audit` · `/v1/audit/actions` | Tesorero. `actor, action, result, target, from, to, limit, cursor` |
| GET | `/v1/operators` · POST `/v1/operators/:id/totp/reset` | Tesorero |

Variables nuevas (migración `009`):

| Variable | Por defecto | Uso |
|---|---|---|
| `DUAL_APPROVAL` | `console` | `off` · `console` (solo corridas solicitadas desde consola) · `all` (también corridas por API key); no afecta retiros |
| `APPROVAL_REQUIRE_2FA` | `true` | El aprobador debe tener 2FA y confirmar con código |
| `TOTP_ENCRYPTION_KEY` | — | **Requerida para activar 2FA.** Mínimo 32 caracteres aleatorios (p. ej. `openssl rand -hex 32`). No cambiarla después: los secretos existentes dejarían de descifrarse |
| `TOTP_ISSUER` | `856-LATAM` | Nombre que muestra la app de autenticación |

> Operación: una corrida de compensación que requiera aprobación necesita un tesorero con 2FA. Alta: `npm run operator:create -- <correo> tesorero`.

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

**Alta:** desde la consola (detalle del cliente → *Portal del cliente*, rol tesorero) se puede *Invitar admin* en cualquier momento, *Reenviar* una invitación vigente (revoca la anterior y genera enlace nuevo) y, por usuario, restablecer **contraseña** (enlace `/portal/restablecer#<token>`, 24 h, un solo uso; al usarlo se cierran las sesiones) o **2FA**. Los enlaces (`/portal/invitacion#<token>`, 72 h, un solo uso) se muestran una vez; el token va en el fragmento y nunca llega al servidor en la URL. Todas las acciones quedan en auditoría.

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
| `GET /v1/clients/:id/portal/users` · `POST …/portal/invites` · `POST …/portal/invites/:inviteId/resend` · `POST …/portal/users/:userId/password-reset` · `POST …/portal/users/:userId/totp-reset` | Consola (tesorero): usuarios e invitaciones, reenvío, restablecer contraseña y 2FA |

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

### Portal de clientes — fase 3: lista blanca y salidas
**El cliente origina; 856 valida y autoriza.** Los retiros solicitados desde el portal o una integración/API key quedan pendientes hasta que los autorice un ejecutivo de cuenta o tesorero distinto; el worker no los ejecuta antes de esa autorización. Con `ORIGIN_RULE=enforce`, las `API_KEYS` globales no originan retiros y la consola no origina transferencias internas ni altas de lista blanca (`403 origin_not_client`); un operador sí puede ingresar una instrucción interna de retiro. Las obligaciones quedan fuera de la regla hasta la fase 4.

Los retiros ingresados en consola por instrucción de un ejecutivo de cuenta o tesorero pueden pasar directamente al worker sin aprobación adicional. El operador solicitante queda registrado y se conservan las validaciones normales de cliente activo, activo habilitado, saldo y lista blanca.

- **Lista blanca** (`/portal/lista-blanca`): la pide un usuario Operador o superior; la aprueba **otro** usuario Aprobador o Administrador con 2FA (`403 same_user`); queda **en espera** `WHITELIST_COOLDOWN_HOURS` (24 h) antes de poder usarse, con cuenta regresiva. Retirar (Aprobador+) es inmediato. Una dirección no se repite entre clientes (`409 address_unavailable`).
- **Nueva salida** (`/portal/salidas`) en cuatro pasos: activo → destino vigente → monto en unidades del activo (sin float) → confirmación con **simulación** exacta: monto, destino, comisión de 856 (hoy 0), gas (lo paga 856), disponible, saldo resultante, obligaciones por pagar y la **huella** (`sha256` del alcance). La simulación vence en `EXIT_SIMULATION_TTL_MIN` (30 min).
- **Aprobación interna del cliente:** el Administrador fija con 2FA un umbral por activo; arriba de él otro usuario Aprobador+ aprueba con 2FA antes de que la salida llegue a 856.
- **Validación y autorización en la consola** (Aprobaciones › *Salidas por validar*): muestra origen, aprobación del cliente, simulación y huella, con tiempo objetivo `EXIT_VALIDATION_SLA_MIN` (4 h; alerta en el Tablero si se rebasa). Un ejecutivo de cuenta o tesorero distinto del solicitante autoriza con 2FA; basta una aprobación individual. Rechazar exige motivo y devuelve el saldo.
- **Atado a la huella:** si al autorizar cambió el destino (ya no vigente) o las obligaciones por pagar, responde `409 scope_changed` (simular de nuevo). El worker vuelve a calcular la huella antes de firmar y, si no coincide, revierte la reserva y marca la salida fallida.
- **Seguimiento:** el cliente ve el estado (aprobación interna, validación, autorizada, enviada, ejecutada, rechazada con motivo, cancelada), el hash y el enlace al explorador; nunca ve quién autorizó en 856. Puede cancelar mientras no esté autorizada.
- **Llaves de API:** una llave Ed25519 con permiso `withdraw` (casilla al crearla) puede simular, solicitar y cancelar salidas; los tokens de lectura nunca originan.
- **Rol de consola renombrado:** `operador` → `ejecutivo` (*Ejecutivo de cuenta*), mismos permisos; el tesorero es el superusuario.

| Método y ruta | Quién | Uso |
|---|---|---|
| `GET /v1/portal/whitelist` · `POST /v1/portal/whitelist` `{address, label?}` | lectura · operador+ | Lista y solicitud de alta |
| `POST /v1/portal/whitelist/:id/approve` `{code}` · `/remove` | aprobador+ (+2FA) | Aprobar (otro usuario) y retirar |
| `GET` · `PUT /v1/portal/settings/approval-thresholds` `{asset_id, threshold\|null, code}` | lectura · admin + 2FA | Umbral de aprobación interna |
| `POST /v1/portal/exits/simulate` `{asset_id, whitelist_id, amount}` | operador+ o llave `withdraw` | Simulación con huella |
| `POST /v1/portal/exits` `{simulation_id}` | operador+ o llave `withdraw` | Solicitar (reserva el saldo) |
| `GET /v1/portal/exits?state` · `GET /v1/portal/exits/:id` | lectura | Seguimiento |
| `POST /v1/portal/exits/:id/approve` `{code}` · `/cancel` | aprobador+ (+2FA) · operador+ | Aprobación interna y cancelación |
| `POST /v1/withdrawals/:id/approve` `{code}` · `/reject` `{reason}` | ejecutivo de cuenta o tesorero (consola) | Autorizar una vez con 2FA o rechazar |

Migración `013_portal_salidas` (idempotente): rol `operador` → `ejecutivo`; `wallets.wl_status/wl_requested_by/wl_approved_by/active_from/removed_*` (las direcciones existentes quedan vigentes); campos históricos de umbral y segunda autorización en `assets`/`withdrawals`; tablas `client_approval_thresholds` y `exit_simulations`; retiros con origen, simulación, huella, aprobación del cliente y tiempo objetivo (`approval_status` admite `client_pending`).

Variables nuevas: `WHITELIST_COOLDOWN_HOURS` (24), `EXIT_SIMULATION_TTL_MIN` (30), `EXIT_VALIDATION_SLA_MIN` (240). Para activar la regla: `ORIGIN_RULE=enforce`.

Pruebas: `ORIGIN_RULE=enforce` + `node test/portal-fase3.e2e.mjs` (regla de origen, lista blanca, simulación, autorización individual por ejecutivo/tesorero y ejecución en cadena, umbral del cliente, `scope_changed`, rechazo, cancelación, fila alterada en la base, llaves, aislamiento, tiempo objetivo y bitácora) y `npx playwright test portal-salidas.spec.mjs` (5 recorridos: lista blanca, salida en cuatro pasos, aprobación interna, autorización y rechazo en la consola, permiso de la llave).

### Portal de clientes — fase 4: obligaciones y compensación
**El acreedor registra, el deudor acepta.** Solo las obligaciones aceptadas (`open`) entran a compensación. Con `ORIGIN_RULE=enforce` la consola y las `API_KEYS` globales ya no registran obligaciones de clientes (`403 origin_not_client`): conservan la consulta, la cancelación con motivo y las corridas sobre lo ya aceptado.

- **Código de contraparte** por cliente (`856-XXXX-XXXX`, aleatorio, en Inicio y en Obligaciones). El acreedor identifica al deudor con ese código; la consulta es exacta y devuelve solo el nombre (no hay búsqueda ni lista, no se pueden enumerar clientes).
- **Estados:** `pending_acceptance` → `open` (aceptada) | `rejected` (con motivo) | `expired` (sin respuesta en `OBLIGATION_ACCEPT_TTL_HOURS`, 72 h); después `settled` o `cancelled`. Las obligaciones existentes y las registradas por la consola con la regla apagada nacen `open`.
- **Aceptar:** usuario Operador+ o llave Ed25519 con permiso `trade`. Si el monto alcanza el umbral de aprobación interna del deudor (fase 3), solo un Aprobador o Administrador con 2FA puede aceptarla (`403 approval_required`, `422 bad_code`). El acreedor no acepta lo suyo (`403 not_debtor`).
- **Cancelar:** el acreedor, con motivo, mientras esté pendiente o abierta y fuera de una corrida en curso (`409 in_pending_run`).
- **Duplicados:** misma referencia, misma contraparte y mismo activo con una obligación pendiente o abierta → `409 duplicate_obligation`.
- **Carga CSV** (columnas `contraparte, activo, monto, referencia, vencimiento`; coma o punto y coma; BOM de Excel): primero se valida sin registrar y se devuelve el reporte por fila y campo; al confirmar se registran todas las filas válidas en una sola transacción o ninguna (`409 import_row_failed`). Máximo `OBLIGATION_IMPORT_MAX_ROWS` (5 000).
- **Compensación (vista del cliente):** posición en la próxima corrida por activo (por cobrar, por pagar, neto, ahorro estimado y faltante de saldo), calculada como la consola pero devolviendo solo lo propio; historial de corridas donde participó con su renglón del asiento (abono o cargo) y sus obligaciones.
- **Avisos:** el portal avisa las obligaciones por aceptar (y las que vencen en < 24 h); el Tablero de la consola, las que vencen en < 24 h.
- El worker vence las aceptaciones fuera de plazo; cada lectura o decisión del portal también lo hace, salvo las lecturas de asistencia, estrictamente de solo lectura.

### Consola — asistencia de solo lectura («Ver como cliente»)
Ejecutivos y tesoreros pueden abrir el portal en una pestaña separada desde la lista o el perfil del cliente. El flujo no reutiliza la sesión ni las cookies del cliente: la pestaña mantiene una credencial de asistencia separada en `sessionStorage`, y las peticiones de asistencia omiten cookies. El `client_id` se obtiene del principal autenticado, nunca de parámetros enviados por el navegador. La asistencia no cambia `ORIGIN_RULE=enforce` ni habilita acciones de origen del cliente.

| Método y ruta | Quién | Uso |
|---|---|---|
| `POST /v1/console/clients/:id/assist-token` `{origin: "client_list" or "client_detail"}` | Sesión de consola, rol `ejecutivo` o `tesorero`, `x-856-console: 1` | Emite `{token, expires_at}`; token `ast_` de un solo canje y máximo 10 minutos |
| `GET /v1/portal/auth/assist?token=ast_...` | Token de asistencia | Canjea una vez el enlace por una credencial `asr_`, con el mismo vencimiento |
| `GET /v1/portal/auth/assist/close` con `x-856-assist-token: asr_...` | Sesión de asistencia | Revoca la credencial al salir o al cerrar la pestaña (intento best-effort del navegador) |
| `GET` / `HEAD` en rutas de consulta del portal | Sesión de asistencia | Consulta únicamente los datos del cliente ligado al token; la ruta `auth/assist/close` es la excepción de control de sesión |
| Cualquier otro método HTTP en rutas del portal | Sesión de asistencia | `403 operation_not_allowed_in_assist_mode`; se rechaza antes de ejecutar la ruta |

Los tokens se guardan como SHA-256 en PostgreSQL; el vencimiento se comprueba en cada petición y es el límite garantizado de la sesión. El navegador intenta revocar al salir o cerrar la pestaña, pero el cierre abrupto puede impedir que llegue el aviso. La bitácora inmutable registra `client_impersonation_initiated`, el actor `console:<correo>`, el cliente, `success`/`denied` y el origen del inicio. Los rechazos de escritura del portal también quedan auditados con el cliente y el actor operador. La interfaz muestra el banner de asistencia y deshabilita controles de acción; la API sigue siendo la protección autoritativa.

La asistencia muestra también la sección **Llaves de API** para guiar al cliente: permite consultar nombres, prefijos, tipo, permisos, IP autorizadas, vencimiento, último uso y estado, además de la ayuda de integración. Nunca expone secretos; crear, rotar o revocar sigue reservado al administrador del cliente y la API rechaza cualquier mutación. La sección **Usuarios** y el resto de administración no se habilitan.

La consulta de obligaciones del portal (`GET /v1/portal/obligations`) cubre la vista de obligaciones/facturación existente; el sistema no tiene un recurso o endpoint independiente de facturas. También se pueden consultar balances, movimientos, estados de cuenta, depósitos y demás rutas `GET` del portal bajo el mismo contexto y las mismas restricciones.

Prueba E2E: `ORIGIN_RULE=enforce BASE KEY DATABASE_URL node test/client-assist.e2e.mjs` (roles permitidos/denegados, emisión/canje único, balances, movimientos, estado de cuenta y obligaciones, POST/PATCH bloqueados, balance y postings intactos, auditoría y revocación).

| Método y ruta (`/v1/portal`) | Quién | Uso |
|---|---|---|
| `GET /counterparty` · `GET /counterparties/:code` | lectura | Código propio · confirmar contraparte (30/min) |
| `GET /obligations?role&status&asset_id` · `GET /obligations/:id` | lectura | Lista (con `to_accept`) y detalle |
| `POST /obligations` `{counterparty_code, asset_id, amount, external_ref?, due_at?}` | operador+ o llave `trade` | Registrar por cobrar |
| `POST /obligations/:id/accept` `{code?}` · `/reject` `{reason}` | deudor: operador+ (aprobador+ con 2FA arriba del umbral) o llave `trade` | Aceptar o rechazar |
| `POST /obligations/:id/cancel` `{reason}` | acreedor: operador+ o llave `trade` | Cancelar |
| `POST /obligations/import` `{filename?, csv}` · `/import/:id/commit` · `/import/:id/discard` | operador+ o llave `trade` | Carga masiva |
| `GET /netting/positions?asset_id` · `GET /netting/runs` · `GET /netting/runs/:id` | lectura | Posición e historial propios |

Migración `014_portal_obligaciones` (idempotente): `clients.counterparty_code` (función `gen_counterparty_code()`); estados nuevos de `obligations` con origen, aceptación, rechazo, vencimiento e `import_id`; tabla `obligation_imports`.

Variables nuevas: `OBLIGATION_ACCEPT_TTL_HOURS` (72), `OBLIGATION_IMPORT_MAX_ROWS` (5000).

Pruebas: `ORIGIN_RULE=enforce` + `node test/portal-fase4.e2e.mjs` (68 verificaciones: códigos, alta, duplicados, aislamiento, aceptación, umbral con 2FA, rechazo, cancelación, vencimiento, regla de origen, llaves `trade`/`read`/`withdraw`, CSV con errores por fila y confirmación atómica, posiciones, corrida con asiento, bitácora y migración re-ejecutable) y `npx playwright test portal-obligaciones.spec.mjs` (5 recorridos).

### Multi-red EVM (ola 1) y activos habilitados por cliente
**Varias redes EVM en una sola instalación.** La red principal sigue siendo `ALCHEMY_NETWORK`; `NETWORKS` agrega las demás (csv). Redes conocidas (chainId, explorador y moneda nativa ya cargados): `eth-sepolia` (11155111), `base-sepolia` (84532), `arb-sepolia` (421614), `polygon-amoy` (80002, POL), `bnb-testnet` (97, tBNB), `opt-sepolia` y `avax-fuji`.

- **Arranque:** cada red se verifica contra su chainId esperado; si no coincide o no responde, esa red se apaga (`503 network_down`) y las demás siguen. Pedir algo en una red no encendida → `422 network_not_supported`.
- **Worker:** recorre las redes una tras otra con su propio manejo de errores; `POST /v1/worker/tick` devuelve `{networks: {<red>: "ok" | error}}`.
- **Nonces y unicidad por red:** retiros y barridos usan `(network, from, nonce)`; depósitos, `(network, tx_hash, log_index)`. La misma hot wallet firma en todas las redes con nonces independientes.
- **Webhooks:** un webhook *Address Activity* de Alchemy por red, con su llave de firma. La red del evento es la de la llave que valida la firma (nunca la que diga el cuerpo).
- **Direcciones de depósito:** la misma dirección derivada sirve en todas las redes EVM; se registra por red y solo se muestra al cliente si la red está encendida y tiene al menos un activo del cliente en estado `enabled`. Si todos sus activos están en `exit_only` o `disabled`, la dirección se oculta y no se pueden generar nuevas en esa red; las direcciones históricas siguen registradas para detectar depósitos y ponerlos en revisión. En la consola, un tesorero con 2FA puede archivar direcciones con movimientos (se ocultan, pero siguen monitoreándose y acreditando) o eliminar las que no tienen depósitos ni barridos registrados. Debe quedar una dirección visible por red habilitada. La URI del QR incluye la red (`ethereum:<dirección>@<chainId>`).
- **Activos nuevos (migración 015):** `EURC-ETH-SEPOLIA`, `ETH-BASE-SEPOLIA`, `USDC-BASE-SEPOLIA`, `EURC-BASE-SEPOLIA`, `ETH-ARB-SEPOLIA`, `USDC-ARB-SEPOLIA`, `POL-AMOY`, `USDC-AMOY` y `BNB-TESTNET`, con los contratos de prueba de Circle. Circle no publica USDC/EURC en BNB testnet ni EURC en Arbitrum o Amoy: en BNB solo va el nativo hasta desplegar un token de prueba propio.

**Activos habilitados por cliente.** Cada cliente opera solo los activos que tiene habilitados:

| Estado | Recibir depósitos | Retirar / compensar |
|---|---|---|
| `enabled` (Habilitado) | sí | sí |
| `exit_only` (Solo salida) | no: el depósito queda **en revisión** (`held`) | sí, lo que ya tiene |
| sin fila (deshabilitado) | no: queda en revisión | no (`403 asset_not_enabled`) |

- **Por defecto** un cliente nuevo recibe todos los activos de `DEFAULT_CLIENT_NETWORKS` (las 5 redes) más los que pida al crearse (`assets`). Los clientes existentes conservan lo que tenían y reciben además los de esas redes.
- **Quién cambia:** el **Tesorero** aplica el cambio con 2FA; el **Ejecutivo** lo solicita con motivo y lo aprueba un tesorero distinto (`403 same_operator`; una sola solicitud pendiente por cliente y activo, `409 request_pending`). Deshabilitar con saldo u operaciones abiertas no procede (`409 asset_in_use`): se usa «Solo salida».
- **Depósitos en revisión:** un depósito en un activo no habilitado no se acredita; aparece en Aprobaciones y el Tesorero lo acredita con 2FA (no habilita el activo). En el portal se ve «En revisión».
- **Compensación:** el acreedor necesita el activo para recibir y el deudor para pagar; si la contraparte no lo tiene → `422 counterparty_asset_not_enabled`. La carga CSV lo marca en el campo «activo».
- **Consola:** tablero con una fila por red (salud, bloque, gas, conciliación), tarjeta «Activos habilitados» en el cliente, selector de red al generar dirección o dar de alta en lista blanca, columna Red en movimientos, solicitudes y depósitos en revisión en Aprobaciones. En «Activos habilitados» se pueden seleccionar varios activos (o todos los de una red) para aplicar el mismo estado en una sola operación; el Tesorero confirma el lote con 2FA y se aplica de forma atómica, mientras que el Ejecutivo envía solicitudes individuales por activo para aprobación.
- **Portal:** insignia «Solo salida» en saldos, selector de red al generar dirección (con los activos que recibe), red en depósitos y lista blanca, y el asistente de salidas solo ofrece destinos de la misma red que el activo.

| Método y ruta | Quién | Uso |
|---|---|---|
| `GET /v1/networks` | lectura | Redes encendidas, chainId, confirmaciones, explorador |
| `GET /v1/clients/:id/assets` | lectura | Activos del cliente por red, saldo y solicitud pendiente |
| `PUT /v1/clients/:id/assets/:assetId` `{status, code}` | tesorero (2FA) | `enabled` · `exit_only` · `disabled` |
| `PUT /v1/clients/:id/assets/bulk` `{asset_ids, status, code}` | tesorero (2FA) | Aplica el mismo estado a varios activos de forma atómica |
| `POST /v1/clients/:id/asset-requests` `{asset_id, action, reason}` | ejecutivo+ | Solicitar `enable` · `exit_only` · `disable` |
| `POST /v1/clients/:id/asset-requests/bulk` `{asset_ids, action, reason}` | ejecutivo+ | Solicitar el mismo cambio para varios activos, todo o nada |
| `GET /v1/asset-requests?status&client_id` | lectura | Solicitudes |
| `POST /v1/asset-requests/:id/approve` `{code}` · `/reject` `{reason}` | tesorero distinto (2FA al aprobar) | Decidir |
| `POST /v1/deposits/:id/release` `{code}` | tesorero (2FA) | Acreditar un depósito en revisión |
| `POST /v1/clients/:id/deposit-address` `{network?}` · `GET /v1/treasury/hot-wallet?network` | — | Ahora por red (por defecto, la principal) |
| `POST /v1/deposits/report` `{tx_hash, network?}` | — | Si no se indica red, se busca en todas |
| `GET /v1/portal/assets` | portal: lectura o llave | Activos propios y su estado |
| `POST /v1/portal/deposit-addresses` `{network?}` · `POST /v1/portal/whitelist` `{address, network?, label?}` | portal: operador+ | Por red |

Migración `015_multired` (idempotente): columna `network` en `withdrawals`, `sweeps`, `tx_attempts` y `deposits` (con valor de la red principal para lo existente); índices únicos por red; estado `held` y columnas `held_reason`, `released_by`, `released_at` en `deposits`; activos nuevos; tablas `client_assets` y `client_asset_requests`.

Variables nuevas: `NETWORKS`, `DEFAULT_CLIENT_NETWORKS` y, por red, con el sufijo de su id en mayúsculas y `_` (`BASE_SEPOLIA`, `ARB_SEPOLIA`, `POLYGON_AMOY`, `BNB_TESTNET`): `ALCHEMY_WEBHOOK_ID_<RED>`, `ALCHEMY_WEBHOOK_SIGNING_KEY_<RED>` y, opcionales, `CONFIRMATIONS_<RED>`, `GAS_LOW_WEI_<RED>`, `GAS_BUMP_MAX_FEE_WEI_<RED>`, `EXPLORER_URL_<RED>`, `RPC_URL_<RED>` (solo pruebas locales). La red principal sigue usando las variables sin sufijo.

**Puesta en marcha (una vez):**
1. **Alchemy:** en la app de 856-LATAM, habilitar Base Sepolia, Arbitrum Sepolia, Polygon Amoy y BNB Testnet.
2. **Webhooks:** crear un webhook *Address Activity* por red apuntando a `https://<dominio>/v1/webhooks/alchemy`; en Railway pegar su id y su llave de firma en `ALCHEMY_WEBHOOK_ID_<RED>` y `ALCHEMY_WEBHOOK_SIGNING_KEY_<RED>`. Agregar `NETWORKS=base-sepolia,arb-sepolia,polygon-amoy,bnb-testnet`.
3. **Token de Notify:** renovar `ALCHEMY_NOTIFY_TOKEN` si venció (registra las direcciones en cada webhook).
4. **Fondeo de la hot wallet** en cada red: nativo de los faucets (Alchemy pide saldo en mainnet; tBNB del faucet de BNB Chain) y USDC/EURC del faucet de Circle. El tablero marca «Bajo» por red.
5. **Plan de Alchemy:** cinco redes multiplican las lecturas del worker; revisar los créditos del plan.

Pruebas: `node test/multired.e2e.mjs` con `ORIGIN_RULE=off` y dos cadenas locales (`RPC_URL` y `RPC_B`, `NETWORKS=eth-sepolia,base-sepolia`, `RPC_URL_BASE_SEPOLIA`; 39 verificaciones: redes, activos por defecto, misma dirección en dos redes, webhook por llave, depósitos, saldos y retiros por red con nonces independientes, solo salida → en revisión → acreditar, solicitudes ejecutivo/tesorero, bitácora y migración re-ejecutable) y `npx playwright test multired.spec.mjs` (5 recorridos: tablero por red, activos del cliente, solicitud y aprobación, depósito en revisión, portal por red).

Pendiente: Tron (ola 2a), Solana y Bitcoin (ola 2b).

### Fase M1 — paso a mainnet con sandbox para clientes
**Dos despliegues del mismo código**, separados por `ENVIRONMENT`:

| Despliegue | `ENVIRONMENT` | Redes | Base, llaves y hot wallet |
|---|---|---|---|
| Producción (`856-latam-production`) | `production` | `eth-mainnet` (principal), `base-mainnet`, `arb-mainnet`, `bnb-mainnet` | propias, nuevas |
| Sandbox (`856-latam-sandbox`) | `sandbox` | `eth-sepolia` | propias; aquí vive lo que hoy está en Sepolia |

**Activos main** (alta idempotente al arrancar, solo para las redes encendidas; contratos verificados el 15-oct-2026 en la fuente del emisor y en el explorador oficial, ver `src/chain/catalog.ts`):

| Red | Activos (decimales) |
|---|---|
| Ethereum | `ETH-MAINNET` (18), `USDT-MAINNET` Tether (6), `USDC-MAINNET` Circle (6), `EURE-MAINNET` Monerium (18) |
| Base (red de fiat) | `ETH-BASE` (18), `USDC-BASE` Circle (6), `EURE-BASE` Monerium (18) |
| Arbitrum | `ETH-ARB` (18), `USDT-ARB` USDT0 de Tether (6), `USDC-ARB` Circle (6), `EURE-ARB` Monerium (18) |
| BNB Smart Chain | `BNB-BSC` (18), `USDT-BSC` Binance-Peg (18), `USDC-BSC` Binance-Peg (18) |

Si un activo ya existe con otra red, contrato o decimales, el arranque se detiene (un error ahí acreditaría depósitos de un token equivocado). Los activos de redes del otro ambiente quedan inactivos y no se listan.

**Reglas de arranque** (el proceso termina con el motivo en el log):
- `NETWORKS`/`ALCHEMY_NETWORK` con redes del otro ambiente, o una red desconocida en `production` → rechazado. En `production` el chainId se verifica siempre, incluso con `RPC_URL_<RED>`.
- `production` exige `ORIGIN_RULE=enforce`, `TOTP_ENCRYPTION_KEY` y semilla HD propia (`HD_MNEMONIC` o `DEPOSIT_HD_SEED`; no se deriva de `SIGNER_PRIVATE_KEY`). Un `SWEEP_MIN_*` que no sea entero → rechazado.
- `production` sin ningún tesorero activo con 2FA → rechazado, salvo el primer despliegue (`CONSOLE_BOOTSTRAP_*` o un tesorero aún sin 2FA): arranca en **modo de alta**, con el worker detenido y `/v1` (portal incluido) respondiendo `503 setup_required` excepto login y 2FA. Sale solo en cuanto el tesorero activa su 2FA.

**Política de retiros.** Las solicitudes de clientes e integraciones requieren una sola autorización interna, sin umbral de monto que active doble aprobación. Las instrucciones ingresadas por un ejecutivo de cuenta o tesorero en consola pueden ejecutarse directamente tras las validaciones normales.

**Bloqueantes antes de fondos reales.** `POST /v1/internal-transfers` valida activos habilitados: el emisor debe tener el activo habilitado o en «solo salida» y el receptor habilitado, si no `422 asset_not_enabled`. `ORIGIN_RULE=enforce` es obligatorio en `production`.

**Barrido con mínimo por activo.** `SWEEP_MIN_<ID DEL ACTIVO>` en unidades base (p. ej. `SWEEP_MIN_USDT_MAINNET`). Debajo del mínimo el depósito se acredita al cliente igual; solo se espera a juntar más antes de barrer (en Ethereum el gas hace incosteable barrer montos chicos). El portal lo muestra como «mín. recomendado» al generar la dirección.

**Distintivo de ambiente.** En el sandbox, franja «PRUEBAS» en todas las pantallas de consola y portal (también en el login) e insignia fija en la cabecera.

| Método y ruta | Quién | Uso |
|---|---|---|
| `GET /v1/meta` | público | `{environment, setup_required}` |
| `GET /health` | público | agrega `environment` |
| `GET /v1/summary` | consola | agrega `environment` y `treasurers {active_with_2fa, single}` |
| `GET /v1/portal/assets` | portal | agrega `sweep_min` por activo |

Migraciones: ninguna de esquema. Solo datos al arrancar (catálogo main, activos del otro ambiente inactivos). La base del sandbox se crea desde cero con las migraciones actuales.

Variables nuevas: `ENVIRONMENT`, `HD_MNEMONIC`, `SWEEP_MIN_<ACTIVO>` (y las de Alchemy por red ya existentes: `ALCHEMY_WEBHOOK_ID_<RED>`, `ALCHEMY_WEBHOOK_SIGNING_KEY_<RED>`). `DEFAULT_CLIENT_NETWORKS` toma por defecto las redes del ambiente.

**Riesgos aceptados en M1.** Un solo tesorero: punto único de falla y sin control dual (guardar fuera de línea sus códigos de recuperación de 2FA). Llaves de hot wallet y semilla HD en variables de entorno de Railway (la interfaz `Signer` queda lista para MPC). USDT y USDC en BNB son Binance-Peg (emisor Binance, no Tether ni Circle).

Pruebas: `node test/m1.e2e.mjs` (47 verificaciones: reglas de arranque de ambos ambientes, modo de alta, catálogo y decimales 6 vs 18 con conversión exacta, transferencia interna 422, un solo tesorero vs dos, mínimo de barrido; ver cabecera para variables) y `npx playwright test m1.spec.mjs`.

### Fase F1 — entrada SEPA → EURe con cuentas por cliente/proveedor
El cliente transfiere euros por SEPA y recibe saldo en **EURe** (1 EURe = 1 €) en 856. Solo **entrada**; la salida a fiat (redeem) queda para una fase posterior. 856 no toca fiat: lo opera el proveedor regulado.

**Modos.** `FIAT_MODE=treasury` conserva el perfil/IBAN compartido y la asignación por aviso o código de contraparte. `FIAT_MODE=per_client` crea una cuenta por cliente y proveedor: cada IBAN se liga a una dirección HD dedicada (`wallets.purpose = 'fiat_client'`), y órdenes, avisos, depósitos, conciliación, liberación y libro conservan ese vínculo. Solo clientes `active` son elegibles. Cada cliente puede tener una sola cuenta abierta; para cambiar de proveedor primero se cierra localmente la cuenta anterior. El cierre local desactiva las instrucciones del portal y sigue sondeando la cuenta para detectar fondos tardíos; no cierra el IBAN externo, lo que debe coordinarse con el proveedor.

La frontera sigue Arquitectura Hexagonal y Patrón Estrategia: `FiatIngressPort` normaliza entrada y webhooks del proveedor, mientras `CryptoCustodyPort` verifica la acuñación on-chain. Monerium es el único adaptador real actualmente implementado y reutiliza la integración API v2 existente. En sandbox solo opera el adaptador simulado. `transak` y `circle` tienen identificadores tipados para extender la estrategia, pero responden `501 provider_not_supported` hasta que se definan sus contratos/API; no se simulan operaciones reales ni se inventan endpoints. El ciclo normalizado de la transacción es `CREATED → PROCESSING → SETTLED` o `FAILED`; la conciliación del depósito no equivale a su liberación contable.

**Flujo**
1. El cliente consulta las instrucciones (IBAN, BIC, beneficiario) y crea un **aviso de pago** con el monto (EUR, hasta 2 decimales, sin float) → referencia `856-XXXX-XXXX-NNN` (los 3 dígitos son de control), vigente `FIAT_INTENT_TTL_DAYS` días.
2. Transfiere por SEPA con la referencia como concepto. El proveedor registra la orden (`received`) y acuña EURe en la dirección enlazada (`minted`).
3. **Conciliación automática**: orden `processed` + `Transfer` del contrato EURe hacia la dirección exacta de la cuenta **por el monto exacto** (céntimos × 10¹⁶), con las confirmaciones de la red → `reconciled`. En modo treasury, la asignación usa aviso o código de contraparte; en modo per_client el cliente/proveedor se deriva de la cuenta enlazada y cualquier aviso se valida contra esa misma cuenta. Los desacuerdos quedan en `review`.
4. Un **tesorero con 2FA** libera (`released`: asiento custodia EURe ↑ / saldo disponible del cliente ↑) o rechaza con motivo (`rejected`). En revisión, la asignación manual solo aplica al modo treasury; un depósito per_client nunca puede reasignarse a otro cliente. **Conciliar no acredita: solo `released` mueve saldo.** El portal muestra «Recibido, pendiente de liberación» desde `reconciled`.

**Fuentes de verdad.** El sondeo de `GET /orders` del proveedor (cada `FIAT_POLL_INTERVAL_MS`, en el worker) y la verificación on-chain. `POST /v1/fiat/webhooks/:providerId` requiere el cuerpo HTTP crudo y verifica Standard Webhooks (HMAC-SHA256 de `webhook-id.webhook-timestamp.cuerpo`, ventana de 5 min), persiste el identificador, hash SHA-256 del cuerpo y órdenes antes de responder, y solo adelanta el sondeo; la misma entrega es idempotente. Reutilizar el mismo ID con distinto contenido firmado responde `409`; sin secreto, firma válida o persistencia responde error, nunca éxito. Se conserva `/v1/webhooks/monerium` como alias. El webhook de Alchemy de Base también solo adelanta el sondeo.

**Salvaguardas**
- `FIAT_LIVE_ENABLED=false` por defecto: en production el fiat queda **apagado** (503 `fiat_disabled`) y no sale ninguna llamada a Monerium (`provider_calls` en el estado). En sandbox se usa siempre el **proveedor simulado** (`FIAT_LIVE_ENABLED=true` en sandbox → arranque rechazado).
- Contra Monerium real solo: token (client credentials), ligar dirección (firma de mensaje `I hereby declare that I am the address owner.`, sin gas), pedir y leer IBAN, leer órdenes y tokens. Esta fase **no crea órdenes** ni usa «Create payments».
- El alta verifica que el contrato EURe que anuncia el proveedor (`GET /tokens`) sea el del catálogo (`EURE-BASE`, verificado en Basescan en M1); si difiere, se detiene.
- Avisos: solo el cliente (usuario `operator`+ o llave Ed25519 con `trade`), con origen verificable (usuario/llave, IP y firma). Consola o `API_KEYS` globales → `403 origin_not_client`. Acreditar es proceso de sistema (compatible con `ORIGIN_RULE=enforce`).
- Idempotencia: una fila por cuenta/orden, `SHA-256(providerId + externalTxId + clientId)` en modo per_client, un hash por depósito (otra orden con el mismo hash → revisión, sin acuñación propia no se libera) y un asiento por orden/cliente.
- Liberar, rechazar y dar de alta: solo **sesión de tesorero con 2FA** (una `API_KEY` global → `403 session_required`).
- La tesorería fiat entra al **barrido** hacia la hot wallet como cualquier dirección derivada (respeta `SWEEP_MIN_EURE_BASE`).
- Las acciones de activación/cierre y la consulta de IBANs per_client están restringidas al rol exacto `tesorero` y exigen una sesión de consola con código TOTP vigente; la bitácora incluye cliente, proveedor y motivo.

| Método y ruta | Quién | Uso |
|---|---|---|
| `GET /v1/portal/fiat/instructions` | portal (sesión o llave `read`) | IBAN, BIC, beneficiario, activo y pasos; `409 fiat_not_ready` mientras no hay IBAN |
| `POST /v1/portal/fiat/payment-intents` | usuario `operator`+ o llave `trade` | `{amount: "1250.50", expected_date?, note?}` → aviso con referencia |
| `GET /v1/portal/fiat/payment-intents[/:id]` | portal | avisos del cliente (`open`, `matched`, `expired`, `cancelled`) |
| `POST /v1/portal/fiat/payment-intents/:id/cancel` | usuario `operator`+ o llave `trade` | cancela un aviso abierto |
| `GET /v1/portal/fiat/deposits` | portal | depósitos conciliados, liberados o rechazados del cliente |
| `GET /v1/console/fiat/status` | consola | proveedor, cuenta (IBAN, dirección), último sondeo, cola |
| `POST /v1/console/fiat/setup` | tesorero + 2FA | alta / avance del alta (idempotente) |
| `GET /v1/console/fiat/accounts` | tesorero | lista cuentas y vínculos cliente/proveedor |
| `POST /v1/console/fiat/clients/:clientId/accounts/activate` | tesorero + 2FA | `{provider, code}`; reserva/linkea la cuenta del cliente activo |
| `POST /v1/console/fiat/accounts/:id/close` | tesorero + 2FA | `{reason, code}`; cierre local, exige resolver depósitos abiertos |
| `POST /v1/console/fiat/poll` | tesorero | sondeo inmediato |
| `GET /v1/console/fiat/deposits` | consola | bandeja con filtro por estado y cliente |
| `POST /v1/console/fiat/deposits/:id/release` | tesorero + 2FA | `{code, client_id?, reason?}` (en revisión: cliente y motivo obligatorios) |
| `POST /v1/console/fiat/deposits/:id/reject` | tesorero + 2FA | `{code, reason}` |
| `POST /v1/console/fiat/payment-intents` | — | siempre `403 origin_not_client` |
| `POST /v1/console/fiat/simulate[/:orderId/process]` | tesorero, **solo sandbox** | el proveedor simulado registra una orden; en per_client incluye `client_id` para resolver la cuenta |
| `POST /v1/fiat/webhooks/:providerId` | proveedor configurado | evento firmado y persistido; adelanta el sondeo |

Pantallas: **Recibir euros** y **Avisos de pago** en `/portal`; **Depósitos en euros** en `/console` (estado del alta, bandeja, liberar/rechazar con 2FA y, en sandbox, «Simular depósito»).

Migraciones `016_fiat_entrada` y `017_fiat_per_client`: cuentas/depósitos/avisos enlazados, claves idempotentes por cliente y proveedor, inbox durable de webhooks y propósitos `fiat_treasury` / `fiat_client` en `wallets`. Montos EUR en céntimos y EURe en unidades base con `CHECK (token_amount = amount_cents × 10¹⁶)`.

Variables nuevas: `FIAT_LIVE_ENABLED`, `MONERIUM_ENV`, `MONERIUM_CLIENT_ID`, `MONERIUM_CLIENT_SECRET`, `MONERIUM_WEBHOOK_SECRET`, `FIAT_MODE`, `FIAT_CHAIN`, `FIAT_POLL_INTERVAL_MS`, `FIAT_INTENT_TTL_DAYS`.

**Puesta en marcha en production** (cuando Monerium apruebe el perfil): configurar `MONERIUM_CLIENT_ID`, `MONERIUM_CLIENT_SECRET`, `FIAT_LIVE_ENABLED=true` y, para Whitelabel, `FIAT_MODE=per_client` en el gestor de secretos del despliegue; nunca guardar credenciales en el repositorio ni en el cliente web. El arranque también requiere que la red elegida por `FIAT_CHAIN` esté habilitada en `NETWORKS`. Configurar `MONERIUM_WEBHOOK_SECRET` y apuntar el webhook público del proveedor a `/v1/fiat/webhooks/monerium`; sin secreto el endpoint rechaza el evento y el sondeo periódico sigue siendo fuente de verdad. En la consola, un tesorero con 2FA activa una cuenta para cada cliente `active` y repite hasta que cada IBAN quede activo. En sandbox dejar `FIAT_LIVE_ENABLED=false`: se usa el simulador y la consola tesorero puede probar el ciclo sin conectar Monerium. Transak y Circle no se habilitan en producción hasta que exista un adaptador con contrato documentado y operaciones reales implementadas.

**Riesgos.** Perfil personal de Monerium: piloto solo con fondos propios; clientes reales requieren el perfil corporativo de la empresa. Por confirmar en la primera llamada real: que Monerium acepte la firma de propiedad desde la dirección HD de 856 y el formato exacto del webhook. Los bancos pueden truncar o alterar el concepto SEPA (por eso la tolerancia y la revisión manual). Un depósito rechazado deja sus EURe en custodia sin asignar: la devolución se gestiona fuera de este flujo. URLs de privacidad y términos de la app de Monerium aún en `https://localhost`.

Pruebas: `node --test test/fiat-domain.test.mjs` (estado de dominio, idempotencia por proveedor/orden/cliente y firma/expiración del webhook); `node test/fiat-f1.e2e.mjs` (flujo legacy y restricciones multi-cliente/proveedor, webhook durable, 2FA y aislamiento; requiere servicios locales según su cabecera) y `npx playwright test fiat.spec.mjs`.

### Rieles fiat múltiples con cuentas cifradas e interruptores
La consola tiene la pestaña **Control de Rieles Fiat** (tesorero: edita; ejecutivo: solo lectura enmascarada). Cada riel (`fiat_rails`) es genérico: wire/ACH USD, Revolut Business EUR/GBP/USD, contingencia, locales a futuro (SPEI, PIX, PSE, CBU/CCI), más rieles `automatic` como Monerium (`monerium-eur`) y OTC Limitless. La migración 024 solo siembra **interruptores apagados y sin cuenta**; no contiene datos bancarios.

- **Variable `FIAT_RAILS_ENC_KEY`** (≥ 32 caracteres; generar con `openssl rand -hex 32`, guardar en el gestor de secretos y **no cambiarla**: las cuentas cifradas dejarían de poder descifrarse). Cifra con AES-256-GCM los datos de cuenta de `fiat_rail_accounts`. Sin ella el feature de cuentas queda deshabilitado (error `fiat_rails_key_missing`) y no se ofrece ningún riel manual.
- **Cuentas versionadas e inmutables:** cada cambio es una versión nueva. Doble aprobación: un tesorero propone y **otro distinto** aprueba, ambos con 2FA y motivo. La auditoría (`fiat_rail_account_proposed/approved`) guarda solo campos cambiados y últimos 4, nunca valores completos. Un riel manual no se enciende sin cuenta activa.
- **Interruptores:** `PUT /v1/console/fiat/rails/:rail_id` (tesorero + TOTP + `x-856-console` + motivo; ejecutivo o API_KEY → 403 `forbidden`). Se audita `fiat_rail_toggled` (antes/después/motivo) y `fiat_rail_last_active_disabled` si se apaga el último riel activo de una moneda. Apagar un riel lo oculta del portal y bloquea avisos de pago nuevos (`rail_disabled`); los avisos ya abiertos siguen vigentes.
- **Visibilidad por cliente:** `visibility = all | restricted`. En `restricted` solo ven y usan el riel los clientes asignados (`fiat_rail_clients`; auditoría `fiat_rail_client_assigned/unassigned`); los demás reciben `rail_not_available` al crear avisos. El detalle del cliente muestra sus rieles asignados.
- **Gestión de rieles manuales:** el tesorero puede **crear** rieles (`POST /v1/console/fiat/rails`: `rail_id` slug único, etiqueta, moneda, país, tipo, prioridad, alterno, límites, «recomendado para», tiempo de liquidación, revisión, mensaje y visibilidad), **editar** todos sus metadatos (incluidos los seeds) y **archivar/restaurar** (`is_archived`; sin borrado físico; se apaga al archivar y no se permite si hay avisos de pago abiertos en esa moneda). Un riel nuevo nace apagado y sin cuenta; la cuenta sigue con doble aprobación. Los rieles automáticos (Monerium, OTC) solo permiten editar interruptor, mensaje, límites y visibilidad (`rail_locked`). Auditoría `fiat_rail_created` / `fiat_rail_updated` con campos antes/después, sin valores de cuenta; `rail_id` duplicado → 409 `rail_exists`. No se cambia el tipo de un riel con cuentas ni la moneda de uno encendido. Migración 025 (`is_archived`).
- **Portal:** `GET /v1/portal/fiat/instructions` conserva los campos EUR actuales y suma `active_rails` (cada tarjeta con MEMO = `counterparty_code` del cliente, sin nombres personales), `unavailable_rails` (mensaje de mantenimiento y alterno) y `notice`. `?amount=` filtra por mínimo/máximo.
- **Aprobaciones:** la doble aprobación de cuentas es propia (proponente ≠ aprobador); no usa `client_approval_thresholds`.
- **Conciliación manual:** los rieles manuales no se concilian solos. Tesorería identifica el depósito en el banco, lo registra y usa **liberar** (`release`) o **rechazar** (`reject`) de la consola de fiat existente, con 2FA.
- **Depósito sin identificar (nota):** si llega un depósito sin MEMO o con uno que no coincide con ningún cliente, no se acredita; queda para revisión manual y tesorería lo libera al cliente correcto o lo rechaza/devuelve por el canal bancario.

Pruebas: `node test/fiat-rails-toggle.e2e.mjs` (mismos servicios que `fiat-f1.e2e.mjs` y `FIAT_RAILS_ENC_KEY` en la API; datos ficticios). `fiat-f1.e2e.mjs` y `fiat.spec.mjs` encienden `monerium-eur` antes de crear avisos.

### Registro de gas en el libro
Cada fondeo de gas de la hot wallet (moneda nativa enviada desde fuera de la plataforma) debe entrar al libro como **aportación de 856**: cargo `system:<NATIVO>:custody` / abono `system:<NATIVO>:equity`. Sin él, la custodia nativa del libro no alcanza para registrar el gas de barridos y retiros (el asiento dejaría la custodia negativa) y esos movimientos quedan **enviados pero sin liquidar** («Custodia nativa insuficiente…»).

- **Registrar** (tesorero, sesión de consola con 2FA; una `API_KEY` → `403 session_required`): red + hash de la transacción. El servidor verifica en cadena que la transacción fue exitosa y tiene las confirmaciones de la red, que el destino es la hot wallet y lleva moneda nativa, y que el origen **no** es una dirección de la plataforma (hot wallet, depósito, tesorería fiat). **El monto se toma de la cadena.** Idempotente por red + hash (`409 already_registered`). Asiento clase `gas_funding` con el origen y quién registró.
- **Recuperación automática**: los barridos y retiros detenidos se liquidan solos en el siguiente ciclo del worker.
- **Tablero**: por red, «Gas sin registrar» (saldo nativo de la hot wallet en cadena mayor que la custodia nativa del libro) y barridos/retiros detenidos, con el botón «Registrar fondeo de gas». La lista está en «Retiros y depósitos → Fondeos de gas».

| Método y ruta | Quién | Uso |
|---|---|---|
| `POST /v1/gas-fundings` | tesorero + 2FA | `{network, tx_hash, code}` → asiento de aportación |
| `GET /v1/gas-fundings?network=` | consola / API | fondeos registrados |
| `GET /v1/summary` | consola | `networks[].gas` agrega `ledger_custody`, `unregistered_wei`, `stuck_sweeps`, `stuck_withdrawals` |

Sin migración. Devolver gas sobrante a tesorería queda fuera de alcance (se haría como salida normal).

Pruebas: `node test/gas-funding.e2e.mjs` (barrido detenido por falta de custodia nativa y su liquidación automática, validaciones en cadena, idempotencia, roles y 2FA) y `npx playwright test gas.spec.mjs`.

Pruebas: `bash test/smoke.sh` (libro), `bash test/netting.sh` (compensación), `node test/console-fase4.e2e.mjs` (consola de compensación), `node test/transfers.e2e.mjs` y `node test/deposits-sweep.e2e.mjs` (on-chain, contra cadena local Hardhat/Anvil).

### Openfort (opcional) — conciliación por webhook
Integración **apagada por defecto** (`OPENFORT_ENABLED=false`: la ruta responde 404 y nada cambia). Para activarla: `OPENFORT_ENABLED=true` y `OPENFORT_WEBHOOK_SECRET` (secreto `whsec_…` de dashboard.openfort.io → Webhooks, solo por variable de entorno). `OPENFORT_PUBLISHABLE_KEY` y `OPENFORT_SECRET_KEY` se leen del entorno (Railway) y quedan reservadas para la API; el webhook no las necesita. Para volver al comportamiento anterior basta apagar el flag.

- `POST /v1/webhooks/openfort`: valida la cabecera `openfort-signature` (HMAC-SHA256 hex del cuerpo crudo, comparación en tiempo constante; `401` si falta o no coincide). Guarda el evento en `openfort_events` (migración 023, idempotente por huella del cuerpo) y cruza los hashes de transacción con `tx_attempts`, `sweeps` y `withdrawals`.
- **Solo observa**: no asienta en el libro, no firma ni altera aprobaciones 2FA. La cadena sigue siendo la fuente de verdad; el valor es ver eventos `transaction_*`/`balance.*` conciliados con los movimientos propios.

**Evaluado y descartado** (no optimiza lo existente sin cambiar la custodia):
- *Patrocinio de gas (paymaster) y gas-bump*: requiere cuentas inteligentes/EIP-7702 gestionadas por Openfort. Las direcciones de depósito son EOA HD locales; usarlo implicaría migrar direcciones y firma (cambio del modelo de custodia). El `gas_topup` y el reemplazo por nonce actuales ya funcionan y están registrados en el libro.
- *Barridos en batch*: dependen de cuentas inteligentes/delegación; mismo cambio de custodia. El ahorro ya se logra con `SWEEP_MIN_*`.
- *Login del portal y wallets embebidas*: el portal ya tiene identidad propia con llaves de API; no aportan.

Pruebas: `npm test` (incluye `test/openfort-webhook.test.mjs`: firma, parseo y extracción de hashes).

## Local
```bash
cp .env.example .env   # completar las variables requeridas; usar credenciales de prueba
npm ci
npm run dev            # API en http://localhost:8080
# En otra terminal:
npm --prefix web ci
npm --prefix web run dev
curl -H 'x-api-key: clave-cliente-1' localhost:8080/v1/block/latest
```
Requisitos: Node.js 20 o superior (el CI y Docker usan Node 22), npm y PostgreSQL accesible mediante `DATABASE_URL`. La API también necesita `ALCHEMY_API_KEY` y `API_KEYS`; usa `COOKIE_SECURE=false` para la consola local en HTTP. Vite sirve la consola y reenvía las rutas `/v1` a la API. `npm run build` compila la API, `npm run build:web` compila la consola y `npm test` compila la API y ejecuta las pruebas unitarias sin conectarse a PostgreSQL ni a proveedores externos. Las pruebas `*.e2e.mjs` y Playwright requieren una API/base de datos configuradas y, según el recorrido, servicios de cadena, credenciales o navegador; no forman parte de la barrera CI.

## Despliegue en Akash
El workflow publica la imagen en `ghcr.io/deglvz/cripto-api` solo después de pasar la compilación y las pruebas: `:sha-<commit-completo>` es inmutable, `:main` sigue el branch y `:latest` se actualiza en pushes a `main`. Para un despliegue reproducible, copia el tag `sha-...` del workflow exitoso y reemplaza `latest` en `deploy.yaml` por ese tag antes de crear o actualizar el deployment. Revisa el SDL y las variables en Akash manualmente; este repositorio no despliega en Akash ni en producción de forma automática. No guardes credenciales reales en el repositorio.

```bash
# Para probar una compilación local (no sustituye el tag SHA publicado):
docker build -t cripto-api:local .
# Editar deploy.yaml: fijar la imagen al tag SHA validado y revisar las variables.
# Desplegar manualmente desde console.akash.network
# o con: provider-services tx deployment create deploy.yaml --from <wallet>
```
Después, en Alchemy → Webhooks, apuntar a `https://<uri-akash>/v1/webhooks/alchemy` y copiar el *signing key*.

## Consideraciones de seguridad
- Las variables del SDL son visibles para el proveedor Akash. Para producción usar una API key de Alchemy restringida (allowlist de dominios/IP, solo métodos necesarios) y rotarla.
- Akash expone HTTP en el ingress del proveedor; para TLS propio, poner Cloudflare (proxy) delante con dominio personalizado.
- Red: `ALCHEMY_NETWORK` es la red principal; `NETWORKS` agrega otras redes EVM (ver «Multi-red EVM»). La misma llave firma en todas: un compromiso de la hot wallet afecta a todas las redes.
- Ambientes (fase M1): producción y sandbox nunca comparten base, llaves ni hot wallet. Nunca enviar fondos reales a la hot wallet del sandbox.
