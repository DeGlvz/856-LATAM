import 'dotenv/config';
import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);
const Env = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  ALCHEMY_API_KEY: z.string().min(10),
  // Subdominio de red Alchemy: eth-mainnet, eth-sepolia, base-mainnet, polygon-mainnet, arb-mainnet…
  ALCHEMY_NETWORK: z.string().default('eth-sepolia'),
  API_KEYS: z.string().min(1).transform((s) => new Set(s.split(',').map((k) => k.trim()).filter(Boolean))),
  ALCHEMY_WEBHOOK_SIGNING_KEY: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(120),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(10),
  // Solo pruebas locales: sustituye la URL de Alchemy (p.ej. http://127.0.0.1:8545)
  RPC_URL: z.string().url().optional(),
  // Llave de PRUEBA (Sepolia) de la hot wallet. En producción se reemplaza por MPC (ver src/chain/signer.ts)
  SIGNER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'llave hex de 32 bytes con 0x').optional(),
  // Backend de la hot wallet: local (SIGNER_PRIVATE_KEY, sandbox y pruebas) o kms (AWS KMS, ECC_SECG_P256K1)
  SIGNER_BACKEND: z.preprocess(blank, z.enum(['local', 'kms', 'remote']).default('local')),
  SIGNER_KMS_KEY_ID: z.preprocess(blank, z.string().optional()),
  // remote: servicio firmante separado (src/signer-service) en la red privada; la app no guarda llaves
  SIGNER_REMOTE_URL: z.preprocess(blank, z.string().url().optional()),
  SIGNER_REMOTE_SECRET: z.preprocess(blank, z.string().min(32, 'mínimo 32 caracteres aleatorios').optional()),
  // Anclajes públicos (no secretos): dirección de la hot wallet y xpub del nodo m/44'/60'/0'/0 que reporta el firmante
  SIGNER_REMOTE_HOT_ADDRESS: z.preprocess(blank, z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  DEPOSIT_HD_XPUB: z.preprocess(blank, z.string().startsWith('xpub').optional()),
  // Generacion de la semilla HD vigente: solo se derivan, barren y ligan direcciones de esta generacion
  HD_GENERATION: z.preprocess(blank, z.coerce.number().int().min(1).default(1)),
  // Semilla HD (hex 32-64 bytes) para direcciones de depósito. Si falta, se deriva de SIGNER_PRIVATE_KEY (solo testnet)
  DEPOSIT_HD_SEED: z.string().regex(/^0x[0-9a-fA-F]{64,128}$/).optional(),
  // Alternativa a DEPOSIT_HD_SEED: frase mnemónica BIP-39 (12 o 24 palabras). En production se exige una de las dos.
  HD_MNEMONIC: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().trim().refine((v) => [12, 15, 18, 21, 24].includes(v.split(/\s+/).length), 'frase de 12 a 24 palabras').optional()),
  // Alchemy Notify: registrar direcciones de depósito en el webhook Address Activity
  ALCHEMY_WEBHOOK_ID: z.string().optional(),
  ALCHEMY_NOTIFY_TOKEN: z.string().optional(),
  ALCHEMY_NOTIFY_URL: z.string().url().default('https://dashboard.alchemy.com/api/update-webhook-addresses'),
  // Barrido: ETH mínimo (wei) para barrer saldo nativo de una dirección de depósito
  SWEEP_MIN_NATIVE_WEI: z.coerce.bigint().default(1_000_000_000_000_000n), // 0.001 ETH
  SWEEP_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Orígenes de la página pública (alojada aparte, p. ej. Vercel) autorizados a enviar «Solicitar acceso»; vacío = mismo origen
  LANDING_ORIGINS: z.string().default('').transform((v) => new Set(v.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean))),
  // Compatibilidad de entorno: reemplazadas por worker_policies; ya no gobiernan escaneos de clientes.
  SWEEP_ACTIVE_WINDOW_MIN: z.coerce.number().int().min(1).default(30),
  SWEEP_IDLE_INTERVAL_MS: z.coerce.number().int().min(1000).default(900_000),
  CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  MIGRATE_ON_START: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Consola de operación (/console): sesiones de operador con cookie httpOnly
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), // false solo en local (http)
  SESSION_TTL_MIN: z.coerce.number().int().min(5).default(480),   // vida máxima de la sesión
  SESSION_IDLE_MIN: z.coerce.number().int().min(1).default(30),   // cierre por inactividad
  LOGIN_MAX_FAILS: z.coerce.number().int().min(1).default(5),     // intentos antes de bloquear
  LOGIN_LOCK_MIN: z.coerce.number().int().min(1).default(15),
  // Primer operador (tesorero): se crea solo si la tabla está vacía. Borrar la contraseña después del primer arranque.
  CONSOLE_BOOTSTRAP_EMAIL: z.string().email().optional(),
  CONSOLE_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  // Vigencia del enlace de invitación de un operador nuevo
  CONSOLE_INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  // Tablero: alerta de gas si la hot wallet tiene menos de este saldo nativo (wei)
  GAS_LOW_WEI: z.coerce.bigint().default(50_000_000_000_000_000n), // 0.05 ETH
  // Aprobación de corridas de compensación: off | console (solo lo pedido desde la consola) | all (también API key).
  // Los retiros de cliente/API siempre requieren aprobación; las instrucciones de consola no.
  DUAL_APPROVAL: z.enum(['off', 'console', 'all']).default('console'),
  // El aprobador debe tener 2FA activo y confirmar cada aprobación con un código TOTP
  APPROVAL_REQUIRE_2FA: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Llave para cifrar (AES-256-GCM) los secretos TOTP en la base. Sin ella no se puede activar 2FA.
  TOTP_ENCRYPTION_KEY: z.string().min(32, 'mínimo 32 caracteres aleatorios').optional(),
  TOTP_ISSUER: z.string().default('856-LATAM'),
  // Reemplazo de transacciones atascadas (mismo nonce, comisiones más altas)
  GAS_BUMP_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  GAS_BUMP_AFTER_SEC: z.coerce.number().int().min(1).default(300),       // sin minarse tras este tiempo → se acelera
  GAS_BUMP_PERCENT: z.coerce.number().int().min(11).max(200).default(25), // aumento por intento (la red exige ≥ 10 %)
  GAS_BUMP_MAX_FEE_WEI: z.coerce.bigint().default(300_000_000_000n),     // tope de maxFeePerGas (300 gwei)
  GAS_BUMP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  // Portal de clientes (/portal)
  PORTAL_SESSION_TTL_MIN: z.coerce.number().int().min(5).default(480),
  PORTAL_SESSION_IDLE_MIN: z.coerce.number().int().min(1).default(30),
  PORTAL_INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  PORTAL_KEY_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),   // vigencia máxima de una llave de API
  PORTAL_KEY_OVERLAP_DAYS: z.coerce.number().int().min(0).max(30).default(7), // traslape al rotar
  PORTAL_SIG_WINDOW_SEC: z.coerce.number().int().min(30).max(900).default(300),
  PORTAL_SIG_MAX_FAILS: z.coerce.number().int().min(3).default(10),           // firmas inválidas antes de bloquear la llave
  // Regla de origen: solo credenciales del cliente originan operaciones. Se activa en la fase 3 del portal.
  ORIGIN_RULE: z.enum(['off', 'enforce']).default('off'),
  // Fase 3 del portal: salidas
  WHITELIST_COOLDOWN_HOURS: z.coerce.number().min(0).max(720).default(24),   // espera antes de usar una dirección nueva
  EXIT_SIMULATION_TTL_MIN: z.coerce.number().int().min(1).max(1440).default(30), // vigencia de una simulación de salida
  EXIT_VALIDATION_SLA_MIN: z.coerce.number().int().min(5).default(240),      // tiempo objetivo de tesorería para validar
  // Fase 4 del portal: obligaciones
  OBLIGATION_ACCEPT_TTL_HOURS: z.coerce.number().min(1).max(2160).default(72), // plazo del deudor para aceptar
  OBLIGATION_IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(20000).default(5000),
  // Multi-red EVM (ola 1): redes encendidas y redes habilitadas por defecto a cada cliente nuevo.
  // Ajustes por red con sufijo del slug en mayúsculas (p. ej. CONFIRMATIONS_BASE_SEPOLIA): ver src/chain/networks.ts
  NETWORKS: z.string().optional(),
  // Por defecto según ENVIRONMENT: sandbox → las 5 redes de prueba de la ola 1; production → las 4 redes main (M1)
  DEFAULT_CLIENT_NETWORKS: z.string().optional(),
  // Fase M1: ambiente del despliegue. production = solo redes main; sandbox = solo redes de prueba (para clientes).
  ENVIRONMENT: z.enum(['production', 'sandbox']).default('sandbox'),
  // Fase F1: entrada SEPA → EURe con Monerium (modo tesorería única). Credenciales de la app Private (client credentials).
  MONERIUM_ENV: z.enum(['production', 'sandbox']).default('production'),
  MONERIUM_CLIENT_ID: z.preprocess(blank, z.string().optional()),
  MONERIUM_CLIENT_SECRET: z.preprocess(blank, z.string().optional()),
  // Secreto (whsec_…) de la suscripción de webhooks de Monerium; sin él el webhook solo dispara un sondeo
  MONERIUM_WEBHOOK_SECRET: z.preprocess(blank, z.string().optional()),
  FIAT_MODE: z.enum(['treasury', 'per_client']).default('treasury'),
  FIAT_CHAIN: z.enum(['base']).default('base'),
  // Interruptor: false = ninguna llamada sale a Monerium (se usa el proveedor simulado solo fuera de production)
  FIAT_LIVE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  OPENFORT_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  OPENFORT_WEBHOOK_SECRET: z.preprocess(blank, z.string().optional()),
  OPENFORT_PUBLISHABLE_KEY: z.preprocess(blank, z.string().optional()),
  OPENFORT_SECRET_KEY: z.preprocess(blank, z.string().optional()),
  FIAT_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  FIAT_INTENT_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // Llave para cifrar (AES-256-GCM) las cuentas bancarias de los rieles fiat. Sin ella la carga y lectura de cuentas queda deshabilitada.
  FIAT_RAILS_ENC_KEY: z.preprocess(blank, z.string().min(32, 'm�nimo 32 caracteres aleatorios').optional()),
});

export const config = Env.parse(process.env);
export const isProduction = config.ENVIRONMENT === 'production';
export const defaultClientNetworks = config.DEFAULT_CLIENT_NETWORKS
  ?? (isProduction ? 'eth-mainnet,base-mainnet,arb-mainnet,bnb-mainnet' : 'eth-sepolia,base-sepolia,arb-sepolia,polygon-amoy,bnb-testnet');
export const rpcUrl = config.RPC_URL ?? `https://${config.ALCHEMY_NETWORK}.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
