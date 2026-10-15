// 015 — Multi-red EVM (ola 1) y activos habilitados por cliente.
//   • Retiros, barridos, intentos y depósitos guardan su red: la misma hot wallet firma en varias redes, así que
//     los nonces (y los hashes) se identifican por red + dirección.
//   • Activos de las redes de prueba: Base Sepolia, Arbitrum Sepolia, Polygon Amoy y BNB Smart Chain Testnet,
//     con los contratos oficiales de Circle (USDC en todas; EURC donde Circle lo emite). BNB no tiene stablecoin
//     oficial de prueba: se registra su token de prueba propio cuando se despliegue.
//   • client_assets: qué activos tiene habilitados cada cliente (enabled | exit_only) y solicitudes del ejecutivo.
//   • Depósitos en activos no habilitados quedan "held" (en revisión) hasta que tesorería decida.
// Idempotente: puede re-ejecutarse sin error.
export default /* sql */ `
-- ───── Red en cada movimiento on-chain ─────
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS network TEXT;
UPDATE withdrawals w SET network = a.network FROM assets a WHERE a.id = w.asset_id AND w.network IS NULL;
ALTER TABLE withdrawals ALTER COLUMN network SET NOT NULL;
DROP INDEX IF EXISTS withdrawals_nonce_idx;
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_net_nonce_idx ON withdrawals (network, from_address, nonce) WHERE nonce IS NOT NULL AND status <> 'failed';

ALTER TABLE sweeps ADD COLUMN IF NOT EXISTS network TEXT;
UPDATE sweeps s SET network = w.network FROM wallets w WHERE w.id = s.wallet_id AND s.network IS NULL;
ALTER TABLE sweeps ALTER COLUMN network SET NOT NULL;
DROP INDEX IF EXISTS sweeps_nonce_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sweeps_net_nonce_idx ON sweeps (network, from_address, nonce) WHERE status <> 'failed';

ALTER TABLE tx_attempts ADD COLUMN IF NOT EXISTS network TEXT;
UPDATE tx_attempts t SET network = w.network FROM withdrawals w WHERE t.kind = 'withdrawal' AND w.id = t.ref_id AND t.network IS NULL;
UPDATE tx_attempts t SET network = s.network FROM sweeps s WHERE t.kind = 'sweep' AND s.id = t.ref_id AND t.network IS NULL;

ALTER TABLE deposits ADD COLUMN IF NOT EXISTS network TEXT;
UPDATE deposits d SET network = a.network FROM assets a WHERE a.id = d.asset_id AND d.network IS NULL;
ALTER TABLE deposits ALTER COLUMN network SET NOT NULL;
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_tx_hash_log_index_key;
CREATE UNIQUE INDEX IF NOT EXISTS deposits_net_tx_log_idx ON deposits (network, tx_hash, log_index);
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_status_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_status_check CHECK (status IN ('pending','held','credited','orphaned'));
ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS held_reason TEXT,
  ADD COLUMN IF NOT EXISTS released_by TEXT,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS deposits_held_idx ON deposits (created_at) WHERE status = 'held';

-- ───── Activos de la ola 1 (contratos oficiales de Circle, verificados el 15-oct-2026) ─────
INSERT INTO assets (id, symbol, chain, network, kind, contract_address, decimals) VALUES
  ('EURC-ETH-SEPOLIA',  'EURC', 'ethereum', 'eth-sepolia',  'erc20',  '0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4', 6),
  ('ETH-BASE-SEPOLIA',  'ETH',  'ethereum', 'base-sepolia', 'native', NULL, 18),
  ('USDC-BASE-SEPOLIA', 'USDC', 'ethereum', 'base-sepolia', 'erc20',  '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 6),
  ('EURC-BASE-SEPOLIA', 'EURC', 'ethereum', 'base-sepolia', 'erc20',  '0x808456652fdb597867f38412077a9182bf77359f', 6),
  ('ETH-ARB-SEPOLIA',   'ETH',  'ethereum', 'arb-sepolia',  'native', NULL, 18),
  ('USDC-ARB-SEPOLIA',  'USDC', 'ethereum', 'arb-sepolia',  'erc20',  '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', 6),
  ('POL-AMOY',          'POL',  'ethereum', 'polygon-amoy', 'native', NULL, 18),
  ('USDC-AMOY',         'USDC', 'ethereum', 'polygon-amoy', 'erc20',  '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', 6),
  ('BNB-TESTNET',       'BNB',  'ethereum', 'bnb-testnet',  'native', NULL, 18)
ON CONFLICT (id) DO NOTHING;

-- ───── Activos habilitados por cliente ─────
CREATE TABLE IF NOT EXISTS client_assets (
  client_id  UUID NOT NULL REFERENCES clients(id),
  asset_id   TEXT NOT NULL REFERENCES assets(id),
  status     TEXT NOT NULL CHECK (status IN ('enabled','exit_only')),  -- exit_only: puede retirar o compensar, no recibir
  updated_by TEXT NOT NULL DEFAULT 'sistema',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, asset_id)
);
-- Clientes existentes: lo que ya tienen en cuenta + las 5 redes por defecto de la ola 1 (una sola vez)
INSERT INTO client_assets (client_id, asset_id, status, updated_by)
SELECT DISTINCT a.client_id, a.asset_id, 'enabled', 'migración 015' FROM accounts a WHERE a.client_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO client_assets (client_id, asset_id, status, updated_by)
SELECT c.id, s.id, 'enabled', 'migración 015' FROM clients c CROSS JOIN assets s
 WHERE s.active AND s.network IN ('eth-sepolia','base-sepolia','arb-sepolia','polygon-amoy','bnb-testnet') AND c.status <> 'closed'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS client_asset_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id),
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  action        TEXT NOT NULL CHECK (action IN ('enable','exit_only','disable')),
  reason        TEXT NOT NULL CHECK (length(reason) >= 5),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by  TEXT NOT NULL,
  requested_by_operator UUID REFERENCES operators(id),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS client_asset_requests_open_idx ON client_asset_requests (client_id, asset_id) WHERE status = 'pending';
`;
