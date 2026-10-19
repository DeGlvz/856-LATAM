import type { ReactNode } from 'react';
import { EnvBanner } from '@/components/EnvBanner';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { usePortal } from './auth';
import { PortalLayout } from './Layout';
import { PortalLogin } from './pages/Login';
import { Invitation } from './pages/Invitation';
import { Home } from './pages/Home';
import { PortalSecurity } from './pages/Security';
import { Users } from './pages/Users';
import { Keys } from './pages/Keys';
import { AccountDetail, Accounts } from './pages/Accounts';
import { Deposits } from './pages/Deposits';
import { Whitelist } from './pages/Whitelist';
import { ExitDetail, Exits } from './pages/Exits';
import { Obligations } from './pages/Obligations';
import { Netting } from './pages/Netting';
import { PaymentIntents, ReceiveEuros } from './pages/Euros';
import { AssistEntry } from './pages/AssistEntry';

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
function AdminOrAssistKeys() {
  const { isAdmin, isAssist } = usePortal();
  return isAdmin || isAssist ? <Keys readOnly={isAssist} /> : <Navigate to="/" replace />;
}

export default function PortalApp() {
  return (
    <BrowserRouter basename="/portal">
      <EnvBanner />
      <Routes>
        <Route path="/login" element={<PortalLogin />} />
        <Route path="/auth/assist" element={<AssistEntry />} />
        <Route path="/invitacion" element={<Invitation />} />
        <Route element={<RequireSession><PortalLayout /></RequireSession>}>
          <Route index element={<Home />} />
          <Route path="cuentas" element={<Accounts />} />
          <Route path="cuentas/:asset" element={<AccountDetail />} />
          <Route path="depositos" element={<Deposits />} />
          <Route path="euros" element={<ReceiveEuros />} />
          <Route path="avisos" element={<PaymentIntents />} />
          <Route path="salidas" element={<Exits />} />
          <Route path="salidas/:id" element={<ExitDetail />} />
          <Route path="lista-blanca" element={<Whitelist />} />
          <Route path="obligaciones" element={<Obligations />} />
          <Route path="compensacion" element={<Netting />} />
          <Route path="seguridad" element={<PortalSecurity />} />
          <Route path="usuarios" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="llaves" element={<AdminOrAssistKeys />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
