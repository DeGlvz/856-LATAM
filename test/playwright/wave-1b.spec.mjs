import { test, expect } from '@playwright/test';
process.env.ALCHEMY_API_KEY ??= 'browser-test-no-public-rpc';
process.env.API_KEYS ??= 'browser-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/browser_test';
const { KNOWN } = await import('../../dist/chain/networks.js');

const ids = ['opt-mainnet', 'opt-sepolia', 'polygon-mainnet', 'polygon-amoy', 'avax-mainnet', 'avax-fuji', 'linea-mainnet', 'linea-sepolia', 'celo-mainnet', 'celo-sepolia', 'unichain-mainnet', 'unichain-sepolia', 'worldchain-mainnet', 'worldchain-sepolia'];
const address = `0x${'12'.repeat(20)}`, hash = `0x${'34'.repeat(32)}`;
const date = '2026-10-23T12:00:00Z';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const assets = ids.map((network) => ({
      id: `NATIVE-${network}`, asset_id: `NATIVE-${network}`, symbol: KNOWN[network].native, network,
      decimals: 18, kind: 'native', active: true, status: 'enabled', network_enabled: true, network_label: KNOWN[network].label,
    }));
    const movements = ids.map((network) => ({
      id: network, network, asset_id: `NATIVE-${network}`, client_id: 'client', client_name: 'Cliente de prueba',
      amount: '1000000000000000000', to_address: address, from_address: address, tx_hash: hash,
      status: 'confirmed', approval_status: 'not_required', confirmations: 3, created_at: date, updated_at: date,
      kind: 'sweep_native', gas_cost_wei: '1000000000000000', wallet_id: network,
    }));
    const data = {
      '/v1/meta': { environment: 'sandbox', setup_required: false },
      '/v1/auth/me': { operator: { id: 'operator', name: 'Lectura', email: 'test@example.invalid', role: 'lectura', totp_enabled: true } },
      '/v1/summary': { explorer: KNOWN['opt-mainnet'].explorer, withdrawals_in_flight: { total: 0 }, approvals_pending: {} },
      '/v1/assets': { assets },
      '/v1/networks': { networks: ids.map((id) => ({ id, ...KNOWN[id], healthy: true })) },
      '/v1/withdrawals': { withdrawals: movements, next_cursor: null },
      '/v1/sweeps': { sweeps: movements, next_cursor: null },
      '/v1/portal/me': { kind: 'user', user: { id: 'user', name: 'Prueba', role: 'viewer', totp_enabled: true }, client: { id: 'client', name: 'Empresa de prueba', status: 'active' }, totp_enrollment_required: false },
      '/v1/portal/assets': { assets },
      '/v1/portal/deposit-addresses': { addresses: ids.map((network) => ({
        id: network, network, address, active: true, uri: `ethereum:${address}@${KNOWN[network].chainId}`, created_at: date,
      })) },
      '/v1/portal/deposits': { deposits: ids.map((network) => ({
        id: network, network, tx_hash: hash, amount: '1000000', decimals: 6, symbol: 'USDC', to_address: address,
        status: 'credited', confirmations: 3, required_confirmations: 3, created_at: date,
      })), next_cursor: null },
    }[path];
    await route.fulfill({ json: data ?? {}, status: data ? 200 : 404 });
  });
});

test('portal: etiquetas y enlaces por las 14 redes, sin depender de la red principal', async ({ page }) => {
  // Fastify sirve portal.html para estas rutas; Vite preview solo conoce las entradas HTML.
  await page.route('**/portal/depositos', async (route) => {
    await route.fulfill({ response: await route.fetch({ url: 'http://127.0.0.1:4173/console/portal.html' }) });
  });
  await page.goto('/portal/depositos');
  await expect(page.getByTestId('address-network')).toHaveCount(14);
  for (const id of ids) {
    await expect(page.getByTestId('address-network').filter({ hasText: new RegExp(`^${KNOWN[id].label}$`) })).toBeVisible();
    await expect(page.locator(`a[href="${KNOWN[id].explorer}/address/${address}"]`)).toHaveCount(1);
    await expect(page.locator(`a[href="${KNOWN[id].explorer}/tx/${hash}"]`)).toHaveCount(1);
  }
});

test('consola: retiros y barridos abren el explorador de su red y gas en CELO/POL/AVAX', async ({ page }) => {
  await page.goto('/console/movimientos');
  for (const id of ids) await expect(page.locator(`a[href="${KNOWN[id].explorer}/tx/${hash}"]`)).toHaveCount(1);
  await page.getByRole('tab', { name: /^Barridos/ }).click();
  for (const id of ids) await expect(page.locator(`a[href="${KNOWN[id].explorer}/tx/${hash}"]`)).toHaveCount(1);
  for (const symbol of ['CELO', 'POL', 'AVAX']) {
    const row = page.getByRole('row').filter({ hasText: `${symbol === 'CELO' ? 'Celo Sepolia' : symbol === 'POL' ? 'Polygon Amoy' : 'Avalanche Fuji'}` });
    await expect(row).toContainText(symbol);
    await expect(row).not.toContainText('ETH');
  }
});
