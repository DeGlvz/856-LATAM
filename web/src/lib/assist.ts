import { api } from './api';

export type AssistOrigin = 'client_list' | 'client_detail';

export function openAssistTab() {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  return tab;
}

export async function launchAssistTab(clientId: string, origin: AssistOrigin, tab: Window) {
  try {
    const { token } = await api<{ token: string }>(`/console/clients/${clientId}/assist-token`, {
      method: 'POST',
      json: { origin },
    });
    const url = new URL('/portal/auth/assist', window.location.origin);
    url.searchParams.set('token', token);
    tab.location.replace(url.toString());
  } catch (error) {
    tab.close();
    throw error;
  }
}
