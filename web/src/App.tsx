import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { EnvBanner } from '@/components/EnvBanner';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import type { Role } from './lib/api';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Clients } from './pages/Clients';
import { ClientDetail } from './pages/ClientDetail';
import { Account } from './pages/Account';
import { Movements } from './pages/Movements';
import { Netting } from './pages/Netting';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Security } from './pages/Security';
import { Operators } from './pages/Operators';
import { OperatorDetail } from './pages/OperatorDetail';
import { Usage } from './pages/Usage';
import { Worker } from './pages/Worker';
import { OperatorInvitation } from './pages/OperatorInvitation';
import { FiatDeposits } from './pages/FiatDeposits';
import { FiatRails } from './pages/FiatRails';
import { AccessRequests } from './pages/AccessRequests';

function RequireAuth({ children }: { children: ReactNode }) {
  const { operator, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Cargando…</div>;
  if (!operator) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/** Rutas solo para un rol mínimo: los demás vuelven al tablero. */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useAuth();
  return can(role) ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter basename="/console">
      <EnvBanner />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invitacion" element={<OperatorInvitation />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="clientes" element={<Clients />} />
          <Route path="clientes/:id" element={<ClientDetail />} />
          <Route path="cuentas/:ref" element={<Account />} />
          <Route path="movimientos" element={<Movements />} />
          <Route path="fiat-automaticos" element={<FiatDeposits />} />
          <Route path="euros" element={<Navigate to="/fiat-automaticos" replace />} />
          <Route path="rieles-fiat" element={<RequireRole role="ejecutivo"><FiatRails /></RequireRole>} />
          <Route path="compensacion" element={<Netting />} />
          <Route path="aprobaciones" element={<Approvals />} />
          <Route path="auditoria" element={<Audit />} />
          <Route path="seguridad" element={<Security />} />
          <Route path="operadores" element={<RequireRole role="tesorero"><Operators /></RequireRole>} />
          <Route path="operadores/:id" element={<RequireRole role="tesorero"><OperatorDetail /></RequireRole>} />
          <Route path="consumos" element={<RequireRole role="tesorero"><Usage /></RequireRole>} />
          <Route path="worker" element={<RequireRole role="ejecutivo"><Worker /></RequireRole>} />
          <Route path="solicitudes" element={<RequireRole role="ejecutivo"><AccessRequests /></RequireRole>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
