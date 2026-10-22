import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

type Entry = { titulo: string; texto: string };

const SECTIONS: Record<string, string> = {
  produccion: 'En producción hoy', resolvemos: 'Qué resolvemos', rieles: 'Rieles a tu medida', integracion: 'Integración',
  api: 'Tu tesorería, programable', comofunciona: 'Cómo funciona', gobierno: 'Tu tesorería, bajo tu control',
  alcance: 'Alcance', formulario: 'Solicitar acceso',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// «Sin tecnicismos» sin JS: el hero y un bloque <noscript> se generan desde el mismo JSON que usa el script
export function sinTecnicismos(): Plugin {
  const file = path.resolve(import.meta.dirname, 'src/landing/sin-tecnicismos.json');
  return {
    name: 'sin-tecnicismos',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
        const get = (id: string) => {
          const e = data[id];
          if (!e) throw new Error(`sin-tecnicismos: falta el id «${id}» en sin-tecnicismos.json`);
          return e;
        };
        const inline = (ids: string[]) => ids.map((id) => {
          const e = get(id);
          return `<p class="st-inline" data-st-inline="${id}"><span class="st-label">Sin tecnicismos</span>${ids.length > 1 ? `<strong>${esc(e.titulo)}.</strong> ` : ''}${esc(e.texto)}</p>`;
        }).join('\n');
        const noscript = () => {
          const groups = Object.keys(SECTIONS).map((k) => {
            const items = Object.entries(data).filter(([id]) => id.startsWith(`${k}.`))
              .map(([, e]) => `<dt>${esc(e.titulo)}</dt><dd>${esc(e.texto)}</dd>`).join('');
            return `<section class="st-noscript-group"><h3>${esc(SECTIONS[k])}</h3><dl>${items}</dl></section>`;
          }).join('\n');
          return `<noscript><div class="st-noscript"><div class="st-noscript-inner"><h2>Sin tecnicismos</h2>${groups}</div></div></noscript>`;
        };
        return html
          .replace(/<!--st:([\w.,]+)-->/g, (_, ids: string) => inline(ids.split(',')))
          .replace('<!--st-noscript-->', noscript);
      },
    },
  };
}
