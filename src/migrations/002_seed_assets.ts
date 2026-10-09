// 002 — Activos iniciales en testnet (Ethereum Sepolia)
export default /* sql */ `
INSERT INTO assets (id, symbol, chain, network, kind, contract_address, decimals) VALUES
  ('ETH-SEPOLIA',      'ETH',  'ethereum', 'eth-sepolia', 'native', NULL, 18),
  ('USDC-ETH-SEPOLIA', 'USDC', 'ethereum', 'eth-sepolia', 'erc20', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 6)
ON CONFLICT (id) DO NOTHING;
`;
