# cripto-api

API REST (Node 22 + TypeScript + Fastify + viem) sobre RPC de **Alchemy**, desplegable en **Akash Network**.

## Endpoints
| Método | Ruta | Auth |
|---|---|---|
| GET | `/health` | — |
| GET | `/v1/block/latest` | `x-api-key` |
| GET | `/v1/address/:address/balance` | `x-api-key` |
| GET | `/v1/address/:address/tokens` (ERC-20, `alchemy_getTokenBalances`) | `x-api-key` |
| GET | `/v1/tx/:hash` | `x-api-key` |
| POST | `/v1/webhooks/alchemy` (Alchemy Notify) | firma HMAC `x-alchemy-signature` |

## Local
```bash
cp .env.example .env   # completar ALCHEMY_API_KEY y API_KEYS
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
