// Catálogo de proveedores fiat automáticos. Agregar uno = añadir una entrada aquí e implementar FiatProvider.
// Solo describe capacidades y estado de configuración; nunca expone credenciales.
import { config, isProduction } from '../config.js';
import type { FiatProviderId } from './domain.js';

export interface ProviderInfo {
  id: FiatProviderId;
  label: string;
  currencies: string[];
  rail_id: string | null;
  implemented: boolean;
  configured: boolean;
  active: boolean;
  note: string;
}

const CATALOG: Omit<ProviderInfo, 'configured' | 'active'>[] = [
  { id: 'monerium', label: 'Monerium', currencies: ['EUR'], rail_id: 'monerium-eur', implemented: true, note: 'SEPA → EURe con IBAN dedicado.' },
  { id: 'circle', label: 'Circle', currencies: ['USD'], rail_id: null, implemented: false, note: 'Estrategia definida; integración pendiente.' },
  { id: 'transak', label: 'Transak', currencies: [], rail_id: null, implemented: false, note: 'Estrategia definida; integración pendiente.' },
];

export function listProviders(): ProviderInfo[] {
  return CATALOG.map((p) => {
    const configured = p.id === 'monerium' ? !!(config.MONERIUM_CLIENT_ID && config.MONERIUM_CLIENT_SECRET) : false;
    const active = p.implemented && (p.id === 'monerium' ? isProduction && config.FIAT_LIVE_ENABLED : false);
    return { ...p, configured, active };
  });
}
