import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';

/** Superficie mínima del cliente SSM (permite un doble en pruebas). */
export interface SsmLike { send(command: GetParametersByPathCommand): Promise<any> }

/**
 * Carga los parámetros de SSM bajo `path` en `env` sin sobrescribir lo ya definido.
 * El nombre de la variable es el último segmento del parámetro. Devuelve los nombres cargados (nunca los valores).
 */
export async function loadSsmSecrets(client: SsmLike, env: NodeJS.ProcessEnv, path = '/856/production/'): Promise<string[]> {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  const loaded: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, Recursive: false, NextToken: token }));
    for (const p of res.Parameters ?? []) {
      if (!p.Name || p.Value === undefined) continue;
      const key = p.Name.slice(prefix.length);
      if (!key || key.includes('/')) continue;
      if (env[key] === undefined || env[key] === '') { env[key] = p.Value; loaded.push(key); }
    }
    token = res.NextToken;
  } while (token);
  return loaded;
}

/** Entrypoint del contenedor: con SECRETS_SOURCE=ssm carga los secretos y arranca el servidor; sin SSM, igual que antes. */
export async function bootstrap(opts: {
  env?: NodeJS.ProcessEnv;
  ssm?: SsmLike;
  start: () => Promise<unknown>;
  log?: (msg: string) => void;
}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (env.SECRETS_SOURCE === 'ssm') {
    let client = opts.ssm;
    if (!client) {
      const { SSMClient } = await import('@aws-sdk/client-ssm');
      client = new SSMClient({});
    }
    const names = await loadSsmSecrets(client, env, env.SSM_PATH || '/856/production/');
    if (!names.length) throw new Error('SECRETS_SOURCE=ssm pero no se cargó ningún parámetro: revise la ruta y los permisos');
    log(`secretos cargados desde SSM: ${names.length}`);
  }
  await opts.start();
}
