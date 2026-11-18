// Flaxia account and connection status.
//
// The keyring is managed in Flaxia settings, not here: Studio only reads the
// Auth connection metadata and links to the manager. Model consumers (the
// follow-up gateway) will read the Vault item once that work lands.

import {
  type ConnectionMetadata,
  FLAXIA_SETTINGS_CONNECTIONS,
  fetchCurrentUser,
  listConnections,
  signIn,
} from '../lib/auth';
import { el } from '../lib/dom';
import { openDialog } from './dialog';

const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  google: 'Google',
  openai: 'OpenAI',
  microsoft: 'Microsoft',
  slack: 'Slack',
  discord: 'Discord',
  line: 'LINE',
  github: 'GitHub',
  x: 'X',
};

const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement =>
  el('button', {
    class: `btn ${primary ? 'btn-primary' : ''}`.trim(),
    type: 'button',
    text: label,
    on: { click: onClick },
  });

const note = (text: string): HTMLElement => el('p', { class: 'field-hint', text });

const heading = (text: string): HTMLElement => el('div', { class: 'connection-heading', text });

export function openConnections(): void {
  let cancelled = false;
  const body = el('div', { class: 'connections' });
  const closed = openDialog({
    title: 'Connections',
    body,
    width: 520,
    actions: [{ label: 'Close', value: '' }],
    onClose: () => {
      cancelled = true;
    },
  });

  const manage = (): void => {
    window.open(FLAXIA_SETTINGS_CONNECTIONS, '_blank', 'noopener');
  };

  const renderConnection = (connection: ConnectionMetadata): HTMLElement => {
    const card = el('div', { class: 'connection-card' }, [
      el('div', { class: 'connection-card-head' }, [
        el('span', { class: 'connection-card-name', text: providerLabel(connection.provider) }),
        el('span', { class: 'connection-status', text: 'Connected' }),
      ]),
      el('div', {
        class: 'connection-card-meta',
        text: [
          connection.scopes.length > 0 ? `Scopes: ${connection.scopes.join(', ')}` : '',
          connection.expires_at ? `Token expires ${connection.expires_at}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    ]);
    return card;
  };

  const render = async (): Promise<void> => {
    body.replaceChildren(note('Loading…'));
    try {
      const user = await fetchCurrentUser();
      if (cancelled) return;
      if (!user) {
        body.replaceChildren(
          heading('Flaxia account'),
          note('Sign in with your Flaxia account to see the services linked to it.'),
          button('Sign in with Flaxia', () => void signIn(), true),
          button('Open Flaxia settings', manage),
        );
        return;
      }

      const connections = await listConnections();
      if (cancelled) return;
      const active = connections.filter((connection) => connection.status === 'active');

      body.replaceChildren(
        heading(`Signed in as @${user.username}`),
        note('Connections are created and removed in Flaxia settings. Studio only reads the metadata.'),
      );
      if (active.length === 0) {
        body.appendChild(note('No services are connected yet.'));
      } else {
        const list = el('div', { class: 'connections-list' });
        for (const connection of active) list.appendChild(renderConnection(connection));
        body.appendChild(list);
      }
      body.appendChild(button('Manage connections in Flaxia', manage, true));
      body.appendChild(button('Refresh', () => void render()));
    } catch (error) {
      if (cancelled) return;
      body.replaceChildren(
        heading('Could not load connections'),
        note(error instanceof Error ? error.message : 'Something went wrong.'),
        button('Retry', () => void render()),
        button('Open Flaxia settings', manage),
      );
    }
  };

  void render();
  void closed;
}
