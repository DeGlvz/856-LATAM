import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { PortalAuthProvider } from './auth';
import PortalApp from './App';
import './portal.css';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <PortalAuthProvider>
        <PortalApp />
      </PortalAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
