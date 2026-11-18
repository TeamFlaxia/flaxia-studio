// The Flaxia account + OpenCode connection surface.
//
// Studio keeps the OAuth devices flow here: Auth polls OpenCode, returns a
// sealed token response, and Studio writes it to the Personal Vault as an
// `oauth_connection` item. VK only lives in this module's memory for the
// lifetime of the page.

import {
  type ConnectionMetadata,
  completeConnection,
  type DevicePollResult,
  deleteConnection,
  fetchCurrentUser,
  listConnections,
  type OpenCodeOrg,
  pollOpenCodeDevice,
  signIn,
  startOpenCodeDevice,
} from '../lib/auth';
import { el } from '../lib/dom';
import { createSealKeyPair, openSealed } from '../lib/seal';
import {
  deleteVaultItem,
  fetchVaultKeys,
  saveOAuthItem,
  unlockVault,
  type VaultKeys,
  VaultUnlockError,
} from '../lib/vault';
import { openDialog } from './dialog';
import { toast } from './toast';

let sessionVk: Uint8Array | null = null;
let sessionVkVersion: number | null = null;

const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement =>
  el('button', {
    class: `btn ${primary ? 'btn-primary' : ''}`.trim(),
    type: 'button',
    text: label,
    on: { click: onClick },
  });

const note = (text: string): HTMLElement => el('p', { class: 'field-hint', text });

const heading = (text: string): HTMLElement => el('div', { class: 'connection-heading', text });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function messageFor(error: unknown): string {
  if (error instanceof VaultUnlockError) {
    if (error.reason === 'wrong') return 'That password did not open the Vault.';
    if (error.reason === 'malformed') return 'The Vault envelope is unreadable. Open Flaxia to repair it.';
    return 'The Vault is unavailable. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

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
      // Locking on close keeps VK out of memory after the dialog is gone.
      sessionVk = null;
      sessionVkVersion = null;
    },
  });

  const render = async (): Promise<void> => {
    body.replaceChildren(note('Loading…'));
    try {
      const user = await fetchCurrentUser();
      if (cancelled) return;
      if (!user) {
        renderSignedOut();
        return;
      }
      const connections = await listConnections();
      if (cancelled) return;
      const opencode = connections.find(
        (connection) => connection.provider === 'opencode' && connection.status === 'active',
      );
      if (opencode) renderConnected(opencode);
      else renderDisconnected(user.display_name || user.username);
    } catch (error) {
      renderError(error, () => void render());
    }
  };

  const renderSignedOut = (): void => {
    body.replaceChildren(
      heading('Flaxia account'),
      note('Sign in with your Flaxia account to use the Personal Vault and connect OpenCode.'),
      button('Sign in with Flaxia', () => void signIn(), true),
    );
  };

  const renderDisconnected = (displayName: string): void => {
    body.replaceChildren(
      heading(`OpenCode · ${displayName}`),
      note(
        'Connect OpenCode with a device code. Studio asks Flaxia Auth to poll the Console, then stores the sealed token in your Personal Vault.',
      ),
      note('The token stays encrypted in the Vault; Studio decrypts it only in this tab.'),
      button('Connect OpenCode', () => void connect(), true),
    );
  };

  const renderVaultMissing = (): void => {
    body.replaceChildren(
      heading('Personal Vault is locked out'),
      note(
        'Studio stores connections in the Flaxia Personal Vault. Enable the Vault in Flaxia settings first, then come back.',
      ),
      button('Open Flaxia settings', () => window.open('https://flaxia.app/settings', '_blank', 'noopener')),
      button('Retry', () => void connect()),
    );
  };

  const renderUnlock = (keys: VaultKeys): void => {
    const password = el('input', {
      class: 'input',
      type: 'password',
      attrs: {
        autocomplete: 'current-password',
        placeholder: 'Flaxia password',
        'aria-label': 'Flaxia password',
      },
    });
    const status = note('Unlocking derives the Vault key locally (PBKDF2, 600,000 iterations).');
    const unlock = button(
      'Unlock and connect',
      () => {
        unlock.disabled = true;
        status.textContent = 'Unlocking…';
        void (async () => {
          try {
            const opened = await unlockVault(password.value, keys);
            sessionVk = opened.vk;
            sessionVkVersion = opened.version;
            await connect();
          } catch (error) {
            unlock.disabled = false;
            status.textContent = messageFor(error);
          }
        })();
      },
      true,
    );
    body.replaceChildren(
      heading('Unlock the Personal Vault'),
      note('Your password is used in this tab only. It is never sent to Auth or OpenCode.'),
      password,
      status,
      unlock,
    );
    window.setTimeout(() => password.focus(), 20);
  };

  const connect = async (): Promise<void> => {
    try {
      const keys = await fetchVaultKeys();
      if (cancelled) return;
      if (!keys) {
        renderSignedOut();
        return;
      }
      if (!keys.enabled) {
        renderVaultMissing();
        return;
      }
      if (!sessionVk || sessionVkVersion === null) {
        renderUnlock(keys);
        return;
      }
      await startFlow(sessionVk, sessionVkVersion);
    } catch (error) {
      renderError(error, () => void connect());
    }
  };

  const startFlow = async (vk: Uint8Array, version: number): Promise<void> => {
    const { pair, publicKey } = await createSealKeyPair();
    const state = randomToken(32);
    const start = await startOpenCodeDevice(state);
    if (cancelled) return;

    const status = note('Waiting for approval…');
    const link = start.verification_uri_complete ?? start.verification_uri;
    body.replaceChildren(
      heading('Approve OpenCode'),
      note('Open the OpenCode Console and enter this code:'),
      el('div', { class: 'connection-code', text: start.user_code }),
      button('Open OpenCode Console', () => window.open(link, '_blank', 'noopener')),
      status,
    );

    let intervalMs = Math.max(1, start.interval) * 1000;
    const deadline = Date.now() + Math.max(1, start.expires_in) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await sleep(intervalMs);
      if (cancelled) return;
      let result: DevicePollResult;
      try {
        result = await pollOpenCodeDevice({
          transaction_id: start.transaction_id,
          state,
          device_code: start.device_code,
          client_public_key: publicKey,
        });
      } catch (error) {
        renderError(error, () => void connect());
        return;
      }
      if (result.status === 'pending') {
        status.textContent = 'Waiting for approval…';
        continue;
      }
      if (result.status === 'slow_down') {
        intervalMs = Math.max(intervalMs, (result.interval || 10) * 1000);
        status.textContent = 'OpenCode asked us to slow down…';
        continue;
      }
      if (result.status === 'complete') {
        await finish(start, state, pair, result.sealed, result.orgs, vk, version);
        return;
      }
    }
    if (!cancelled) renderError(new Error('The device code expired. Start again.'), () => void connect());
  };

  const finish = async (
    start: Awaited<ReturnType<typeof startOpenCodeDevice>>,
    state: string,
    pair: CryptoKeyPair,
    sealed: Parameters<typeof openSealed>[0],
    orgs: OpenCodeOrg[],
    vk: Uint8Array,
    version: number,
  ): Promise<void> => {
    const status = note('Saving the connection to your Vault…');
    body.replaceChildren(heading('Finishing…'), status);
    try {
      const plaintext = await openSealed(sealed, pair.privateKey);
      const token = JSON.parse(new TextDecoder().decode(plaintext)) as {
        access_token?: unknown;
        refresh_token?: unknown;
        token_type?: unknown;
        scope?: unknown;
        expires_in?: unknown;
      };
      if (typeof token.access_token !== 'string') throw new Error('OpenCode returned no access token.');
      const org = await pickOrg(orgs);
      if (cancelled) return;
      const expiresIn =
        typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) ? token.expires_in : 3600;
      const expiresAt = new Date(Date.now() + Math.max(1, expiresIn) * 1000).toISOString();
      const itemId = `item_${randomToken(24)}`;
      const payload = {
        version: 1,
        provider: 'opencode',
        access_token: token.access_token,
        refresh_token: typeof token.refresh_token === 'string' ? token.refresh_token : null,
        token_type: typeof token.token_type === 'string' ? token.token_type : 'Bearer',
        scope: typeof token.scope === 'string' ? token.scope : 'inference',
        expires_at: expiresAt,
        org: org ? { id: org.id, name: org.name } : null,
        orgs,
        connected_at: new Date().toISOString(),
      };
      await saveOAuthItem(vk, version, itemId, payload);
      await completeConnection('opencode', {
        transaction_id: start.transaction_id,
        state,
        vault_item_id: itemId,
        scopes: ['inference'],
        expires_at: expiresAt,
        refresh_expires_at: null,
      });
      sessionVk = vk;
      sessionVkVersion = version;
      toast(
        'OpenCode connected',
        org ? `Workspace: ${org.name}` : 'Token saved in your Vault',
        'success',
        2400,
      );
      await render();
    } catch (error) {
      renderError(error, () => void connect());
    }
  };

  const pickOrg = async (orgs: OpenCodeOrg[]): Promise<OpenCodeOrg | null> => {
    if (orgs.length <= 1) return orgs[0] ?? null;
    return new Promise((resolve) => {
      const select = el(
        'select',
        { class: 'select', attrs: { 'aria-label': 'OpenCode workspace' } },
        orgs.map((org) => el('option', { text: org.name, attrs: { value: org.id } })),
      );
      body.replaceChildren(
        heading('Choose a workspace'),
        note('OpenCode models are scoped to a workspace. Choose where this connection should run.'),
        select,
        button(
          'Use this workspace',
          () => {
            const chosen = orgs.find((org) => org.id === select.value) ?? orgs[0] ?? null;
            resolve(chosen);
          },
          true,
        ),
      );
    });
  };

  const renderConnected = (connection: ConnectionMetadata): void => {
    body.replaceChildren(
      heading('OpenCode is connected'),
      note(connection.scopes.length > 0 ? `Scopes: ${connection.scopes.join(', ')}` : 'No scopes recorded.'),
      note(
        connection.expires_at
          ? `Access token expires ${connection.expires_at}`
          : 'Token expiry is managed by OpenCode.',
      ),
      note(
        'The token is encrypted in your Personal Vault. Disconnecting revokes the link and removes the item.',
      ),
      button('Disconnect OpenCode', () => void disconnect(connection), true),
    );
  };

  const disconnect = async (connection: ConnectionMetadata): Promise<void> => {
    try {
      const keys = await fetchVaultKeys();
      if (connection.vault_item_id && keys?.enabled && Number.isSafeInteger(keys.vk_version)) {
        await deleteVaultItem(connection.vault_item_id, keys.vk_version as number);
      }
      await deleteConnection('opencode');
      toast('Disconnected', 'OpenCode is no longer linked to Studio.', 'success', 2000);
      await render();
    } catch (error) {
      renderError(error, () => void render());
    }
  };

  const renderError = (error: unknown, retry?: () => void): void => {
    body.replaceChildren(
      heading('Something went wrong'),
      note(messageFor(error)),
      ...(retry ? [button('Retry', retry)] : []),
    );
  };

  void render();
  void closed;
}
