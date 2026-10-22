# Despliegue en AWS (Fase AWS1) — us-east-2

Producción en una sola instancia con Docker Compose (`app` + `caddy`), base RDS privada, llave de firma en KMS y secretos en SSM.
Presupuesto de tope: `856-mensual` (US$35, ya existente; esta plantilla no lo crea). El sandbox **sigue en Railway** y no se toca.

```
Cloudflare (nube gris) → EIP → EC2 t4g.small (SG: solo 80/443, sin SSH)
                               ├─ caddy (TLS Let's Encrypt) → app (node dist/bootstrap.js)
                               └─ app ──► RDS PostgreSQL 16 (privada, cifrada, respaldos 7 días)
                                      ├─► KMS signing key (secp256k1)  kms:Sign / kms:GetPublicKey
                                      └─► SSM /856/production/*  (SecureString, llave KMS propia)
GitHub Actions (OIDC) → ECR → ssm send-command → docker compose up
```

Rol de la instancia (mínimos permisos): `kms:Sign`/`kms:GetPublicKey` sobre la llave de firma; `ssm:GetParametersByPath` sobre `/856/production/*`;
`kms:Decrypt` sobre la llave de secretos; pull de ECR; y `AmazonSSMManagedInstanceCore` (Session Manager).

## Archivos

| Archivo | Uso |
|---|---|
| `856-prod.yaml` | CloudFormation: VPC, EC2, RDS, 2 llaves KMS, ECR, rol de instancia, OIDC y rol de despliegue |
| `docker-compose.yml`, `Caddyfile` | Se copian a `/opt/856` en cada despliegue (los envía el workflow) |
| `../../.github/workflows/deploy-aws.yml` | CI/CD: build arm64 → ECR → `ssm send-command` (con health check y vuelta automática) |

## Secretos y configuración

- **Nada secreto** en el repositorio, en GitHub ni en `/opt/856/*.env`. La app los lee de SSM al arrancar (`SECRETS_SOURCE=ssm`; `src/bootstrap.ts` los carga a `process.env` sin pisar lo ya definido y luego inicia el servidor).
- Parámetros `SecureString` bajo `/856/production/<NOMBRE>` cifrados con `alias/856-prod-secrets`: `HD_MNEMONIC` (**nueva**), `ALCHEMY_API_KEY`, `ALCHEMY_WEBHOOK_SIGNING_KEY[_<RED>]`, `ALCHEMY_WEBHOOK_ID[_<RED>]`, `ALCHEMY_NOTIFY_TOKEN`, `MONERIUM_CLIENT_ID`, `MONERIUM_CLIENT_SECRET`, `MONERIUM_WEBHOOK_SECRET`, `TOTP_ENCRYPTION_KEY`, `FIAT_RAILS_ENC_KEY`, `API_KEYS`, `DATABASE_URL`.
- Parámetros `String` (no secretos, mismo prefijo): `HD_GENERATION`, `ALCHEMY_NETWORK`, `NETWORKS`, `FIAT_*`, `LANDING_ORIGINS`, etc. Cualquier variable de `.env.example` puede ir aquí.
- `/opt/856/app.env` (no secreto, creado por la plantilla): `ENVIRONMENT=production`, `SIGNER_BACKEND=kms`, `SIGNER_KMS_KEY_ID`, `SECRETS_SOURCE=ssm`, `ORIGIN_RULE=enforce`…
- Con `SIGNER_BACKEND=kms` el arranque **rechaza** `SIGNER_PRIVATE_KEY` y exige `SIGNER_KMS_KEY_ID`.
- `DATABASE_URL` usa TLS: `postgres://app856:<clave>@<endpoint-rds>:5432/cripto?sslmode=no-verify` (RDS exige TLS; el cifrado se mantiene, la verificación del certificado queda pendiente: ver riesgos del PR).
- `TOTP_ENCRYPTION_KEY` y `FIAT_RAILS_ENC_KEY` **cifran datos que ya están en la base**: si se restaura el volcado de Railway hay que cargar los mismos valores (o aceptar re-enrolar 2FA y recapturar cuentas de rieles). Decisión de Jose.

## Pasos de despliegue

> Todo lo siguiente lo ejecuta una persona con credenciales de AWS; este repositorio solo trae el código, la plantilla y la documentación.

1. **CloudFormation** (us-east-2): crear la pila con `856-prod.yaml`. Parámetros: `AcmeEmail`, `DbMasterPassword` (aleatoria, ≥24, solo `A-Za-z0-9_.~-`; guardarla en el gestor de contraseñas). Si la cuenta ya tiene el proveedor OIDC de GitHub: `CreateGitHubOidcProvider=false` y `ExistingGitHubOidcProviderArn`. Anotar las salidas.
2. **Cargar SSM (Jose)**, desde su terminal y sin pegar valores en chats/tickets:
   ```bash
   aws ssm put-parameter --region us-east-2 --type SecureString --key-id alias/856-prod-secrets \
     --name /856/production/HD_MNEMONIC --value "$(leer-de-forma-segura)"        # repetir por cada parámetro
   aws ssm put-parameter --region us-east-2 --type String --name /856/production/HD_GENERATION --value 2
   ```
   `HD_MNEMONIC` nueva (BIP-39, generada fuera de línea) y `HD_GENERATION=2` (ver «Semilla HD»). Rotar `API_KEYS`, credenciales de Alchemy y Monerium por el incidente de Railway.
3. **GitHub**: variables de repositorio `AWS_DEPLOY_ROLE_ARN` (salida `DeployRoleArn`) y `AWS_INSTANCE_ID` (salida `InstanceId`). El rol solo se asume desde tags de versión `v*` (`refs/tags/v*`); no usar *environments* (cambian el `sub` del token OIDC).
4. **Migrar la base** (ventana de mantenimiento; detener antes la app de Railway para que no haya escrituras). Desde `aws ssm start-session --target <InstanceId>` en la instancia:
   ```bash
   export SRC='<url de Railway>' DST='<url de RDS con ?sslmode=require>'   # solo en esa sesión; no guardar en historial
   docker run --rm -e SRC -e DST postgres:16-alpine sh -c 'pg_dump --no-owner --no-acl "$SRC" | psql -v ON_ERROR_STOP=1 "$DST"'
   ```
   Verificar conteos de tablas clave (`clients`, `ledger_entries`, `schema_migrations`). Al arrancar, la migración `035_hd_generation` se aplica sola.
5. **Primer despliegue**: ejecutar el workflow `deploy-aws` (crear un tag `vX.Y.Z` o *Run workflow* eligiendo ese tag; desde `main` el rol se rechaza). Revisar la salida (`deploy ok: <sha>`). Primera vez: `app` no existe en ECR hasta que el workflow publique la imagen.
6. **Cloudflare** (nube gris/solo DNS): registros A de `856latam.com`, `www` y `hooks` → `ElasticIp`. Caddy emite el certificado al primer acceso (el puerto 80 debe llegar). `hooks.856latam.com` solo expone `/v1/webhooks/*` y `/v1/fiat/webhooks/*`.
7. **Webhooks**: en Alchemy (uno por red) apuntar a `https://hooks.856latam.com/v1/webhooks/alchemy` y actualizar `ALCHEMY_WEBHOOK_ID_<RED>`/`..._SIGNING_KEY_<RED>` en SSM; en Monerium, `https://hooks.856latam.com/v1/fiat/webhooks/monerium` y su secreto en SSM. Tras cambiar SSM: reiniciar con `docker compose --env-file stack.env up -d --force-recreate app` (vía SSM Session Manager).
8. **Hot wallet**: al arrancar, la app lee la dirección de la llave KMS y la registra (`/v1/treasury/hot-wallet` o consola). Verificar que la dirección sea la esperada, enviar un fondeo pequeño de prueba, firmar un retiro de prueba y después fondear el saldo operativo. Las llaves de la hot wallet de Railway se consideran comprometidas: mover sus fondos a la dirección KMS y retirarlas.
9. **Cierre de Railway**: tras validar login, depósito, retiro, webhooks y 7 días estables, apagar y borrar el servicio de producción y su base en Railway (el sandbox permanece), y revocar las llaves anteriores.

## Semilla HD y generaciones

La migración `035_hd_generation` agrega `wallets.hd_generation` (default 1 = semilla anterior). `HD_GENERATION` (default 1) indica la vigente:

- Solo se **derivan, barren y ligan** direcciones de la generación vigente (depósitos nuevos, barrido, registro en el webhook, cuentas fiat).
- Las direcciones de generaciones anteriores quedan **archivadas y visibles** en consola, siguen acreditando depósitos que lleguen, pero **no se barren automáticamente** (la semilla anterior ya no está en el servidor): recuperar sus fondos es un procedimiento manual y fuera de línea.
- El cliente obtiene direcciones nuevas en el portal; las anteriores no se le ofrecen.
- Una cuenta fiat de una generación anterior responde `409 fiat_account_previous_generation`: cerrarla y activarla de nuevo.

## Rollback

- **Versión de la app**: el workflow regresa solo a la etiqueta anterior si el health check falla. A mano (Session Manager): `cd /opt/856 && IMAGE_TAG=$(cat previous-tag) docker compose --env-file stack.env up -d`.
- **Base**: las migraciones solo agregan; `035` es una columna con default. Ante un error de datos, restaurar el respaldo/snapshot de RDS a una instancia nueva (retención 7 días; `DeletionPolicy: Snapshot` y protección contra borrado activos) y cambiar `DATABASE_URL` en SSM.
- **Hacia Railway** (solo mientras siga vivo): volver el DNS de Cloudflare al origen anterior. No hay replicación: lo escrito en AWS después del corte no existe en Railway; y las llaves ya rotadas no regresan.
- **Llave de firma**: la llave KMS tiene `DeletionPolicy: Retain`. No se programa su borrado salvo decisión explícita; deshabilitarla detiene toda firma.
