// Flaxia Auth client for Studio.
//
// Studio is a first-party sibling of flaxia.app, so it uses the Auth session
// cookie directly instead of running its own OIDC client. The cookie is
// `SameSite=Lax`; both origins share the `flaxia.app` site, so the browser
// sends it on credentialed fetches. Auth allows these origins explicitly
// (`src/origin.ts` in flaxia-auth).
//
// Connections are created and removed in Flaxia settings. Studio only reads
// the metadata so it can show the account state and link to the manager.

export const AUTH_ORIGIN = (
  (import.meta.env.VITE_AUTH_ORIGIN as string | undefined) ?? 'https://auth.flaxia.app'
).replace(/\/+$/, '');

export const FLAXIA_SETTINGS_CONNECTIONS = 'https://flaxia.app/settings?category=connections';

export class AuthApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error_description === 'string') return body.error_description;
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON.
  }
  return `Request failed (${response.status})`;
};

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${AUTH_ORIGIN}${path}`, {
    ...init,
    credentials: 'include',
    mode: 'cors',
    headers,
  });
}

async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new AuthApiError(response.status, await errorMessage(response));
  return (await response.json()) as T;
}

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const response = await authFetch('/api/auth/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new AuthApiError(response.status, await errorMessage(response));
  const body = (await response.json()) as { user?: AuthUser };
  return body.user ?? null;
}

const AUTH_TXN_KEY = 'flaxia_studio_auth_txn';

const randomToken = (bytes: number): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

const sha256Base64Url = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

/**
 * Send the browser to the Auth login UI.
 *
 * The login UI expects an RP-shaped request (PKCE challenge + state), sets the
 * Auth session cookie, and returns a short-lived code to the callback. Studio
 * only needs the cookie for the connection list, so it verifies the state and
 * discards the code. Keeping the code PKCE-bound means nobody else can
 * redeem it.
 */
export async function signIn(returnTo = `${window.location.origin}/auth/callback`): Promise<void> {
  const verifier = randomToken(32);
  const state = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem(AUTH_TXN_KEY, JSON.stringify({ verifier, state }));
  const url = new URL('/login', AUTH_ORIGIN);
  url.searchParams.set('return_uri', returnTo);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  window.location.assign(url.toString());
}

/**
 * Consume the login callback. Returns true when the state matches the
 * transaction this tab started.
 */
export function completeSignInFromUrl(): boolean {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState) return false;

  let expected: string | null = null;
  try {
    const raw = sessionStorage.getItem(AUTH_TXN_KEY);
    if (raw) expected = (JSON.parse(raw) as { state?: unknown }).state as string | null;
  } catch {
    expected = null;
  }
  sessionStorage.removeItem(AUTH_TXN_KEY);

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState(null, '', url.toString());
  return expected !== null && expected === returnedState;
}

export interface ConnectionMetadata {
  id: string;
  provider: string;
  provider_sub: string | null;
  scopes: string[];
  status: 'active' | 'revoked';
  vault_item_id: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listConnections(): Promise<ConnectionMetadata[]> {
  const body = await authJson<{ connections: ConnectionMetadata[] }>('/api/connections');
  return body.connections;
}
