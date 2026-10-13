import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { usePortal } from './auth';
import { PortalLayout } from './Layout';
import { PortalLogin } from './pages/Login';
import { Invitation } from './pages/Invitation';
import { Home } from './pages/Home';
import { PortalSecurity } from './pages/Security';
import { Users } from './pages/Users';
import { Keys } from './pages/Keys';

function RequireSession({ children }: { children: ReactNode }) {
  const { me, loading } = usePortal();
  const loc = useLocation();
  if (loading) return <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Cargando…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // Aprobador o admin sin 2FA: solo puede ir a activarlo
  if (me.totp_enrollment_required && loc.pathname !== '/seguridad') return <Navigate to="/seguridad" replace />;
  return <>{children}</>;
}
function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = usePortal();
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

export default function PortalApp() {
  return (
    <BrowserRouter basename="/portal">
      <Routes>
        <Route path="/login" element={<PortalLogin />} />
        <Route path="/invitacion" element={<Invitation />} />
        <Route element={<RequireSession><PortalLayout /></RequireSession>}>
          <Route index element={<Home />} />
          <Route path="seguridad" element={<PortalSecurity />} />
          <Route path="usuarios" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="llaves" element={<AdminOnly><Keys /></AdminOnly>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
