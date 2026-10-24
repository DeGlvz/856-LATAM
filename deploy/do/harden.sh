#!/usr/bin/env bash
# Endurecimiento inicial de un droplet 856 (Ubuntu 24.04). Ejecutar UNA vez como root:
#   bash harden.sh app      (en prod856-app)
#   bash harden.sh signer   (en prod856-signer)
# Opcional: DEPLOY_PUBKEY="ssh-ed25519 AAAA... gh-deploy" para la llave de despliegue de GitHub Actions (solo app).
set -euo pipefail
ROLE="${1:?uso: harden.sh app|signer}"
[[ "$ROLE" == app || "$ROLE" == signer ]] || { echo "rol inválido: $ROLE"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

timedatectl set-timezone UTC
apt-get update -y
apt-get -o Dpkg::Options::=--force-confold upgrade -y
apt-get install -y unattended-upgrades fail2ban ufw docker.io docker-compose-v2 jq
systemctl enable --now docker fail2ban unattended-upgrades
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/52-856-no-reboot   # el firmante no se reinicia solo

# Usuario de operación (sin contraseña, solo llave). root deja de entrar por SSH.
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
if [[ -n "${DEPLOY_PUBKEY:-}" && "$ROLE" == app ]]; then echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys; fi
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart docker' > /etc/sudoers.d/856-deploy && chmod 440 /etc/sudoers.d/856-deploy

cat > /etc/ssh/sshd_config.d/856.conf <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
CONF
systemctl restart ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
if [[ "$ROLE" == app ]]; then ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp; fi
ufw --force enable

# Swap (el firmante tiene 1 GB; scrypt usa ~32 MB pero el sistema agradece el margen)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [[ "$ROLE" == app ]]; then
  install -d -m 750 -o deploy -g deploy /opt/856
else
  install -d -m 750 -o deploy -g deploy /opt/856-signer
  install -d -m 700 -o 1000 -g 1000 /var/lib/856-signer      # uid 1000 = usuario node del contenedor
  install -d -m 755 -o deploy -g deploy /etc/856-signer      # política y archivo de pausa: los edita deploy, el contenedor solo lee
fi
echo "endurecimiento $ROLE completo. Entra de nuevo como: ssh deploy@<ip>"
