# Producción en DigitalOcean (NYC1)

App y llaves separadas. La app no tiene ninguna llave: pide firmas a un servidor firmante que solo se alcanza por la red privada.

```
Internet → Cloudflare (DNS) → prod856-app  [Caddy + app · SIGNER_BACKEND=remote · sin llaves]
                                 │ VPC                │ VPC
                                 ▼                    ▼
                           prod856-db           prod856-signer  [llaves cifradas · política · bitácora]
                     (PG 17, solo desde app)    (firewall: solo desde app · 8443 API · 22 SSH)
```

| Recurso | Tipo | Costo/mes |
|---|---|---|
| `prod856-app` | Droplet 1 vCPU / 2 GB, Ubuntu 24.04, respaldos semanales | US$14.40 |
| `prod856-signer` | Droplet 1 vCPU / 1 GB, Ubuntu 24.04, respaldos semanales | US$7.20 |
| `prod856-db` | PostgreSQL 17 administrado, 1 GB / 10 GB, respaldos diarios + PITR | US$15.15 |
| `prod856-app-fw` / `prod856-signer-fw` | Firewalls de nube | gratis |
| IP reservada de la app | Fija para DNS y listas blancas | gratis asignada |

## Reglas
- Ninguna llave, contraseña ni secreto se escribe en el repositorio, en chats ni en GitHub. Los archivos `app.env` y `signer.env` viven solo en su droplet (permisos 600).
- Las llaves de producción se **generan nuevas en el firmante**. Las que estuvieron en Railway se consideran expuestas y no se reutilizan.
- Producción solo se despliega por tag `vX.Y.Z`. El firmante se actualiza a mano.

## 1. Endurecer los droplets (una vez)
Desde tu PC, con la llave `856_prod`:
```bash
# App (IP pública)
scp -i ~/.ssh/856_prod deploy/do/harden.sh root@<IP_APP>:/root/
ssh -i ~/.ssh/856_prod root@<IP_APP> 'DEPLOY_PUBKEY="<pública de la llave de despliegue de GitHub>" bash /root/harden.sh app'

# Firmante (solo accesible a través de la app; usa la IP PRIVADA del firmante)
scp -i ~/.ssh/856_prod -o ProxyJump=deploy@<IP_APP> deploy/do/harden.sh root@<IP_PRIVADA_FIRMANTE>:/root/
ssh -i ~/.ssh/856_prod -J deploy@<IP_APP> root@<IP_PRIVADA_FIRMANTE> 'bash /root/harden.sh signer'
```
Después de esto root ya no entra por SSH; se usa `deploy@`.

## 2. GitHub (una vez)
- Llave de despliegue: en tu PC `ssh-keygen -t ed25519 -C gh-deploy -f ~/.ssh/856_gh_deploy`. La **pública** va en `DEPLOY_PUBKEY` del paso 1; la **privada** la pegas tú en *Settings → Secrets → Actions →* `DO_SSH_KEY`.
- *Settings → Environments*: crear `production` (opcional: aprobación requerida).
- *Variables*: `DO_APP_HOST` (IP reservada de la app), `DO_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <IP_APP>`), `DO_SIGNER_PRIVATE_IP`.

## 3. Firmante: llaves nuevas
En `prod856-signer` (`ssh -J deploy@<IP_APP> deploy@<IP_PRIVADA_FIRMANTE>`):
```bash
cd /opt/856-signer
printf 'IMAGE_REPO=ghcr.io/deglvz/cripto-api\nPRIVATE_IP=<IP_PRIVADA_FIRMANTE>\n' > stack.env
umask 077; printf 'SIGNER_SECRET=%s\n' "$(openssl rand -hex 32)" > signer.env   # copiar este valor a SIGNER_REMOTE_SECRET de la app
cp policy.json /etc/856-signer/policy.json       # copiar deploy/do/signer/policy.json; ajustar topes antes
```
Ejecutar el workflow **deploy-signer** con el tag publicado (descarga la imagen). Luego:
```bash
docker compose --env-file stack.env run --rm signer node dist/signer-service/main.js init --show-mnemonic
```
- Pide una contraseña (mínimo 16 caracteres). Guárdala en tu gestor de contraseñas.
- Muestra la **hot wallet** (`SIGNER_REMOTE_HOT_ADDRESS`) y la **xpub** (`DEPOSIT_HD_XPUB`): son públicas, van en `app.env`.
- Muestra la frase de 24 palabras **una sola vez**: escríbela en papel y guárdala fuera de línea. Respaldar también `/var/lib/856-signer/keystore.json` (cifrado) fuera del servidor.
```bash
docker compose --env-file stack.env up -d
docker compose --env-file stack.env exec signer node dist/signer-service/main.js unlock   # pide la contraseña
```

### Desbloqueo (después de cada reinicio o actualización del firmante)
El firmante arranca bloqueado. Mientras esté bloqueado la app no puede firmar (los pagos y barridos esperan).
```bash
ssh -J deploy@<IP_APP> deploy@<IP_PRIVADA_FIRMANTE>
cd /opt/856-signer && docker compose --env-file stack.env exec signer node dist/signer-service/main.js unlock
docker compose --env-file stack.env exec signer node dist/signer-service/main.js status
```

### Pausa de emergencia
```bash
touch /etc/856-signer/PAUSE     # rechaza toda firma de inmediato
rm /etc/856-signer/PAUSE        # reanuda
docker compose --env-file stack.env exec signer node dist/signer-service/main.js lock   # borra las llaves de memoria
```

### Bitácora
`/var/lib/856-signer/audit.jsonl`: cada firma, rechazo, desbloqueo y error (sin secretos).

## 4. App
En `prod856-app` (`ssh deploy@<IP_APP>`):
```bash
cd /opt/856
printf 'DOMAIN=856latam.com\nACME_EMAIL=<correo>\nIMAGE_REPO=ghcr.io/deglvz/cripto-api\n' > stack.env
umask 077; nano app.env
```
`app.env`: las mismas variables que hoy tiene Railway **excepto** `SIGNER_PRIVATE_KEY`, `HD_MNEMONIC` y `DEPOSIT_HD_SEED`, más:
```
ENVIRONMENT=production
DATABASE_URL=<cadena de conexión de prod856-db, red VPC, sslmode=require>
SIGNER_BACKEND=remote
SIGNER_REMOTE_URL=http://<IP_PRIVADA_FIRMANTE>:8443
SIGNER_REMOTE_SECRET=<el mismo SIGNER_SECRET del firmante>
SIGNER_REMOTE_HOT_ADDRESS=<dirección que mostró init>
DEPOSIT_HD_XPUB=<xpub que mostró init>
HD_GENERATION=2
```
Todas las demás llaves expuestas en Railway (Alchemy, webhooks, API_KEYS, TOTP_ENCRYPTION_KEY, Monerium…) se **rotan** al cargarlas aquí.

Publicar el tag (`git tag v1.0.0 && git push origin v1.0.0`): el workflow **deploy-do** construye, despliega y verifica `/health`.

## 5. Migración desde Railway
1. Ventana de mantenimiento: en Railway `WORKER_ENABLED=false` (sin firmas ni barridos nuevos).
2. Último barrido de las direcciones de depósito antiguas con el sistema actual, y transferencia del saldo de la hot wallet antigua a la **hot wallet nueva** (topes de la política: hacerlo en varias transacciones o subir el tope temporalmente).
3. Base de datos (desde `prod856-app`):
   ```bash
   docker run --rm -e PGSSLMODE=require postgres:17-alpine sh -c \
     'pg_dump -Fc "$RAILWAY_URL" | pg_restore --no-owner --no-acl -d "$DO_URL"'
   ```
   (`RAILWAY_URL` y `DO_URL` se pasan con `-e`, nunca quedan en el historial: usar `read -s`.)
4. `HD_GENERATION=2`: las direcciones de depósito nuevas salen de la semilla nueva; las antiguas quedan archivadas y visibles. Avisar a los clientes de sus direcciones nuevas.
5. Cloudflare (DNS only): `A @`, `A www`, `A hooks` → IP reservada de la app. Actualizar los webhooks (Alchemy, Monerium, Openfort) a `https://hooks.856latam.com/...`.
6. Verificar `/health`, consola y una firma de prueba de bajo monto; luego apagar Railway producción.

## 6. H2H (futuro)
Cuando llegue el primer banco o cliente host-to-host: droplet `prod856-gateway` en la misma VPC (SFTP aislado por cliente + IPsec con strongSwan, IP reservada propia) y Spaces para archivos. La API con certificado de cliente (mTLS) ya está preparada y comentada en `app/Caddyfile`.
