// «Sin tecnicismos»: cada claim técnico marcado con data-st="id" recibe su traducción a lenguaje llano.
// Puntero (hover: hover): popover anclado al claim. Táctil (hover: none): chip por sección y hoja inferior.
// El hero y el bloque <noscript> se generan en el build desde el mismo JSON (vite-plugin-sin-tecnicismos.ts).
import './sin-tecnicismos.css';
import raw from './sin-tecnicismos.json';

type Entry = { titulo: string; texto: string };
const data = raw as Record<string, Entry>;
const LABEL = 'Sin tecnicismos';
const isTouch = () => window.matchMedia('(hover: none)').matches;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

type Trigger = HTMLElement & { _pop?: HTMLElement; _lifted?: HTMLElement[] };
const sections = new Map<HTMLElement, { name: string; ids: string[] }>();

// Nombre de cada sección: se lee antes de envolver los claims, para no arrastrar el texto de los popovers
document.querySelectorAll<HTMLElement>('section').forEach((s) => {
  if (s.querySelector('[data-st]')) sections.set(s, { name: s.querySelector('h2')?.textContent?.trim() ?? '', ids: [] });
});

let current: Trigger | null = null;
let sheet: ReturnType<typeof buildSheet> | null = null;
let uid = 0;

// Límites visibles: la ventana recortada por los ancestros con overflow distinto de visible
function visibleBounds(from: HTMLElement) {
  let { top, bottom, left, right } = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  for (let p = from.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); left = Math.max(left, r.left); right = Math.min(right, r.right);
  }
  return { top, bottom, left, right };
}

// Los ancestros se elevan mientras el popover está abierto: tarjetas vecinas (backdrop-blur) no deben taparlo
function lift(t: Trigger) {
  const list: HTMLElement[] = [];
  for (let p = t.parentElement; p && p !== document.body; p = p.parentElement) {
    p.classList.add('st-lift');
    if (getComputedStyle(p).position === 'static') p.classList.add('st-lift-pos');
    list.push(p);
  }
  t._lifted = list;
}
function unlift(t: Trigger) {
  t._lifted?.forEach((p) => p.classList.remove('st-lift', 'st-lift-pos'));
  t._lifted = [];
}

function place(t: Trigger) {
  const pop = t._pop;
  if (!pop) return;
  pop.classList.remove('st-up', 'st-right');
  const b = visibleBounds(t);
  const r = t.getBoundingClientRect();
  const below = b.bottom - r.bottom - 8;
  const above = r.top - b.top - 8;
  if (pop.offsetHeight + 8 > below && above > below) pop.classList.add('st-up');
  if (r.left + pop.offsetWidth > b.right - 8 && r.right - pop.offsetWidth >= b.left) pop.classList.add('st-right');
}

function closePop(t: Trigger) {
  t.classList.remove('st-open');
  t.setAttribute('aria-expanded', 'false');
  unlift(t);
  if (current === t) current = null;
}

function openPop(t: Trigger) {
  if (current && current !== t) closePop(current);
  lift(t);
  t.classList.add('st-open');
  t.setAttribute('aria-expanded', 'true');
  place(t);
  current = t;
}

function buildSheet() {
  const overlay = el('div', 'st-overlay');
  const box = el('div', 'st-sheet');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'st-sheet-title');
  box.tabIndex = -1;
  const head = el('div', 'st-sheet-head');
  head.append(el('span', 'st-grab'));
  const titles = el('div');
  const title = el('h2', undefined, '');
  title.id = 'st-sheet-title';
  titles.append(el('span', 'st-label', LABEL), title);
  const close = el('button', 'st-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Cerrar');
  head.append(titles, close);
  const body = el('div', 'st-sheet-body');
  body.tabIndex = 0;
  box.append(head, body);
  document.body.append(overlay, box);
  return { overlay, box, head, title, close, body, open: false, opener: null as HTMLElement | null };
}

function hideSheet() {
  if (!sheet?.open) return;
  sheet.open = false;
  sheet.overlay.classList.remove('is-open');
  sheet.box.classList.remove('is-open', 'is-dragging');
  sheet.box.style.transform = '';
  document.documentElement.classList.remove('st-lock');
  document.body.style.overflow = '';
  sheet.opener?.focus({ preventScroll: true });
}

// El botón «atrás» del navegador también cierra: al abrir se apila un estado y al cerrar se deshace
function requestClose() {
  if (history.state && history.state.stSheet) history.back();
  else hideSheet();
}

function openSheet(section: HTMLElement, targetId: string | null, opener: HTMLElement) {
  const info = sections.get(section);
  if (!info) return;
  if (current) closePop(current);
  sheet ??= initSheet();
  sheet.title.textContent = info.name;
  sheet.body.replaceChildren(...info.ids.map((id) => {
    const e = el('div', 'st-entry');
    e.id = `st-entry-${id}`;
    e.append(el('h3', undefined, data[id].titulo), el('p', undefined, data[id].texto));
    if (id === targetId) e.classList.add('is-target');
    return e;
  }));
  sheet.opener = opener;
  sheet.open = true;
  history.pushState({ stSheet: true }, '');
  document.documentElement.classList.add('st-lock');
  document.body.style.overflow = 'hidden';
  sheet.overlay.classList.add('is-open');
  sheet.box.classList.add('is-open');
  sheet.box.focus({ preventScroll: true });
  sheet.body.scrollTop = 0;
  if (targetId) {
    const t = sheet.body.querySelector<HTMLElement>(`#st-entry-${CSS.escape(targetId)}`);
    if (t) sheet.body.scrollTop = Math.max(0, t.offsetTop - 16);
  }
}

function initSheet() {
  const s = buildSheet();
  s.close.addEventListener('click', requestClose);
  s.overlay.addEventListener('click', requestClose);
  // Swipe hacia abajo desde la cabecera o desde el contenido cuando está arriba del todo
  let y0: number | null = null;
  let dy = 0;
  s.box.addEventListener('touchstart', (e) => {
    const inBody = s.body.contains(e.target as Node);
    y0 = inBody && s.body.scrollTop > 0 ? null : e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  s.box.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) { s.box.classList.add('is-dragging'); s.box.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  s.box.addEventListener('touchend', () => {
    if (y0 === null) return;
    const far = dy > 90;
    y0 = null;
    s.box.classList.remove('is-dragging');
    s.box.style.transform = '';
    if (far) requestClose();
  });
  // Focus trap
  s.box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f: HTMLElement[] = [s.close, s.body];
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });
  document.addEventListener('focusin', (e) => {
    if (s.open && !s.box.contains(e.target as Node)) s.box.focus({ preventScroll: true });
  });
  window.addEventListener('popstate', hideSheet);
  return s;
}

// Envuelve el contenido de cada claim en un disparador accesible y le agrega el popover
document.querySelectorAll<HTMLElement>('[data-st]').forEach((host) => {
  const id = host.dataset.st ?? '';
  const entry = data[id];
  if (!entry) { console.warn(`sin-tecnicismos: id sin traducción «${id}»`); return; }
  const section = host.closest('section');
  if (section) sections.get(section)?.ids.push(id);

  const popId = `st-pop-${++uid}`;
  const t: Trigger = el('span', 'st-trigger');
  t.tabIndex = 0;
  t.setAttribute('role', 'button');
  t.setAttribute('aria-expanded', 'false');
  t.setAttribute('aria-controls', popId);
  t.setAttribute('aria-describedby', popId);
  while (host.firstChild) t.append(host.firstChild);
  const pop = el('span', 'st-pop');
  pop.id = popId;
  pop.setAttribute('aria-hidden', 'true');
  pop.append(el('span', 'st-label', LABEL), document.createTextNode(entry.texto));
  pop.addEventListener('click', (e) => e.stopPropagation());
  t._pop = pop;
  t.append(pop);
  host.append(t);

  t.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !isTouch()) openPop(t); });
  t.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') closePop(t); });
  t.addEventListener('focus', () => { if (!isTouch()) openPop(t); });
  t.addEventListener('blur', () => closePop(t));
  t.addEventListener('click', () => {
    if (isTouch()) { if (section) openSheet(section, id, t); return; }
    if (t.classList.contains('st-open')) closePop(t); else openPop(t);
  });
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    t.click();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (sheet?.open) requestClose();
  else if (current) closePop(current);
});
window.addEventListener('resize', () => { if (current) closePop(current); });
