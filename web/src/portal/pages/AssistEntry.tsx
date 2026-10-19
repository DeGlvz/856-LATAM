import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { papi } from '../api';
import { usePortal } from '../auth';

export function AssistEntry() {
  const navigate = useNavigate();
  const { refresh } = usePortal();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    window.history.replaceState({}, '', '/portal/auth/assist');
    if (started.current) return;
    started.current = true;
    if (!token) {
      setError('El enlace de asistencia no contiene un token válido.');
      return;
    }
    void papi<{ session_token: string }>('/auth/assist?token=' + encodeURIComponent(token))
      .then(async ({ session_token }) => {
        sessionStorage.setItem('c856-assist-session', session_token);
        await refresh();
        navigate('/', { replace: true });
      })
      .catch(() => setError('El enlace de asistencia venció o ya fue utilizado. Solicite uno nuevo desde la consola.'));
  }, [navigate, refresh, token]);

  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div role={error ? 'alert' : 'status'} className="max-w-md text-center text-sm text-muted-foreground">
        {error || 'Iniciando sesión de asistencia segura…'}
      </div>
    </div>
  );
}
