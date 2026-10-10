import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';

function RequireAuth({ children }: { children: ReactNode }) {
  const { operator, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Cargando…</div>;
  if (!operator) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter basename="/console">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
