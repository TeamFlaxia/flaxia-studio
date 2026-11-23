/** A change to one workspace record, broadcast to the other tabs. */
export interface WorkspaceChangeMessage {
  type: 'workspace-changed';
  workspaceId: string;
  rev: number;
}

export interface WorkspaceChannel {
  postChange(workspaceId: string, rev: number): void;
  close(): void;
}

const CHANNEL_NAME = 'flaxia-studio';

/**
 * Thin BroadcastChannel wrapper. Environments without BroadcastChannel (Node
 * tests, older browsers) get a no-op channel so callers need no guards.
 */
export function createWorkspaceChannel(
  onMessage: (message: WorkspaceChangeMessage) => void,
): WorkspaceChannel {
  if (typeof BroadcastChannel === 'undefined') {
    return { postChange: () => {}, close: () => {} };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<WorkspaceChangeMessage>) => {
    const message = event.data;
    if (message?.type === 'workspace-changed') onMessage(message);
  };
  return {
    postChange(workspaceId, rev) {
      const message: WorkspaceChangeMessage = { type: 'workspace-changed', workspaceId, rev };
      channel.postMessage(message);
    },
    close() {
      channel.onmessage = null;
      channel.close();
    },
  };
}
