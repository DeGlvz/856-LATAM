// Página pública de 856: menú móvil, aparición al desplazarse y envío de «Solicitar acceso».
import './landing.css';
import './sin-tecnicismos';

document.documentElement.classList.add('js');

// Iconos: si su fuente no llega (red corporativa que bloquea Google Fonts), se ocultan en lugar de mostrar su nombre
if ('fonts' in document) {
  document.fonts.load('24px "Material Symbols Outlined"', 'check').then((faces) => {
    if (faces.length === 0) document.documentElement.classList.add('no-icons');
  }).catch(() => document.documentElement.classList.add('no-icons'));
}

// Menú móvil
const toggle = document.getElementById('menu-toggle');
const menu = document.getElementById('mobile-menu');
if (toggle && menu) {
  const setOpen = (open: boolean) => {
    menu.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    const icon = toggle.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = open ? 'close' : 'menu';
  };
  toggle.addEventListener('click', () => setOpen(menu.classList.contains('hidden')));
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
}

// Aparición al desplazarse
const targets = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  targets.forEach((t) => io.observe(t));
} else {
  targets.forEach((t) => t.classList.add('is-visible'));
}

// Año del pie
const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

// Solicitar acceso
const form = document.getElementById('access-form') as HTMLFormElement | null;
const ok = document.getElementById('form-ok');
const err = document.getElementById('form-error');
const submit = document.getElementById('form-submit') as HTMLButtonElement | null;
if (form && ok && err && submit) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.classList.add('hidden');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    if (!data.message) delete data.message;
    submit.disabled = true;
    const label = submit.querySelector('span');
    const prev = label?.textContent;
    if (label) label.textContent = 'Enviando…';
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/v1/public/access-requests`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data),
      });
      if (res.status === 429) throw new Error('Recibimos varias solicitudes desde tu red. Intenta de nuevo en una hora.');
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ? `Revisa los datos: ${body.error}` : 'No pudimos enviar tu solicitud. Intenta de nuevo.');
      }
      form.reset();
      form.classList.add('hidden');
      ok.classList.remove('hidden');
      ok.classList.add('flex');
      ok.focus();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : 'No pudimos enviar tu solicitud.';
      err.classList.remove('hidden');
    } finally {
      submit.disabled = false;
      if (label && prev) label.textContent = prev;
    }
  });
}
