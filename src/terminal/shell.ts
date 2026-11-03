import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { basename, dirname, joinPath, normalizePath } from '../fs/path';
import type { Workspace } from '../fs/workspace';
import { el, formatBytes } from '../lib/dom';

export interface ShellHost {
  workspace: Workspace;
  openFile(path: string): void;
  bootLinux(): void;
  clearLinuxCache(): void;
  exportWorkspace(): void;
  linuxReady(): boolean;
  runLinux(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
  ): Promise<{ exitCode: number; durationMs: number }>;
}

const LOCAL_ONLY = new Set(['help', 'cd', 'clear', 'boot', 'vm', 'clear-cache', 'export', 'edit']);

interface CommandContext {
  args: string[];
  raw: string;
}

interface ShellCommand {
  name: string;
  summary: string;
  usage?: string;
  run(context: CommandContext): string | undefined;
}

export class StudioShell {
  readonly host: HTMLElement;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private input = '';
  private history: string[] = [];
  private historyIndex = 0;
  private cwd = '';
  private running = false;
  private commands: ShellCommand[];
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly shellHost: ShellHost) {
    this.host = el('div', { class: 'terminal-host', attrs: { 'aria-label': 'Workspace terminal' } });
    this.commands = this.createCommands();
  }

  mount(): void {
    if (this.terminal) return;
    const theme = readTerminalTheme();
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 4000,
      convertEol: true,
      allowTransparency: true,
      theme,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(this.host);
    this.terminal = terminal;
    this.fitAddon = fit;
    this.fit();

    terminal.write(this.banner());
    this.prompt();

    terminal.onData((data) => this.handleData(data));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.host);
    terminal.onTitleChange((title) => {
      if (title) this.host.setAttribute('aria-label', title);
    });
  }

  focus(): void {
    this.terminal?.focus();
  }

  fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // The panel may be hidden; fitting is best-effort.
    }
  }

  setTheme(resolved: 'light' | 'dark'): void {
    if (this.terminal) this.terminal.options.theme = readTerminalTheme(resolved);
  }

  clear(): void {
    this.terminal?.clear();
    this.terminal?.write('\x1b[2J\x1b[H');
    this.prompt();
  }

  writeLine(text: string): void {
    this.terminal?.writeln(text);
  }

  private banner(): string {
    return [
      '\x1b[38;2;16;185;129mFlaxia Studio\x1b[0m  workspace shell',
      '\x1b[38;2;100;116;139mType `help` for commands. The Linux VM is booted separately from the container panel.\x1b[0m',
      '',
    ].join('\r\n');
  }

  private prompt(): void {
    const location = this.cwd ? `/workspace/${this.cwd}` : '/workspace';
    const short = location.length > 52 ? `…${location.slice(-50)}` : location;
    this.terminal?.write(`\x1b[38;2;16;185;129mflaxia@studio\x1b[0m:\x1b[38;2;96;165;250m${short}\x1b[0m$ `);
    this.input = '';
  }

  private handleData(data: string): void {
    const terminal = this.terminal;
    if (!terminal) return;

    if (this.running) {
      if (data === '\u0003') terminal.write('^C\r\n');
      return;
    }

    if (data === '\r') {
      terminal.write('\r\n');
      const line = this.input;
      this.input = '';
      if (line.trim()) {
        this.history.unshift(line);
        this.history = this.history.slice(0, 100);
      }
      this.historyIndex = 0;
      void this.execute(line).finally(() => this.prompt());
      return;
    }

    if (data === '\u007f') {
      if (this.input.length > 0) {
        this.input = this.input.slice(0, -1);
        terminal.write('\b \b');
      }
      return;
    }

    if (data === '\u0003') {
      terminal.write('^C\r\n');
      this.input = '';
      this.prompt();
      return;
    }

    if (data === '\u000c') {
      this.clear();
      return;
    }

    if (data === '\u001b[A') {
      if (this.history.length === 0) return;
      this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
      this.replaceInput(this.history[this.historyIndex] ?? '');
      return;
    }

    if (data === '\u001b[B') {
      if (this.history.length === 0) return;
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.replaceInput(this.history[this.historyIndex] ?? '');
      return;
    }

    if (data.startsWith('\u001b')) return;
    if (data === '\t') {
      this.complete();
      return;
    }

    const printable = Array.from(data)
      .filter((char) => {
        const code = char.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join('');
    if (!printable) return;
    this.input += printable;
    terminal.write(printable);
  }

  private replaceInput(value: string): void {
    const terminal = this.terminal;
    if (!terminal) return;
    for (let i = 0; i < this.input.length; i += 1) terminal.write('\b \b');
    this.input = value;
    terminal.write(value);
  }

  private complete(): void {
    const parts = this.input.split(/\s+/);
    if (parts.length <= 1) {
      const matches = this.commands
        .map((command) => command.name)
        .filter((name) => name.startsWith(this.input))
        .sort();
      if (matches.length === 1) this.replaceInput(`${matches[0]} `);
      else if (matches.length > 1) {
        this.terminal?.write(`\r\n${matches.join('  ')}\r\n`);
        this.prompt();
        this.replaceInput(this.input);
      }
      return;
    }

    const prefix = parts.at(-1) ?? '';
    const directory = normalizePath(joinPath(this.cwd, ...parts.slice(1, -1)));
    const children = this.childrenOf(directory).filter((name) => name.startsWith(prefix));
    if (children.length === 1) {
      const completed = [...parts.slice(0, -1), children[0]].join(' ');
      this.replaceInput(completed);
    }
  }

  private async execute(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;

    if (line === '!!') {
      const previous = this.history[1];
      if (previous) {
        this.history.shift();
        await this.execute(previous);
      }
      return;
    }

    if (/^\d+$/.test(line)) {
      const index = Number.parseInt(line, 10);
      const command = this.history[index];
      if (command) await this.execute(command);
      else this.error(`history: ${line}: not found`);
      return;
    }

    const tokens = tokenize(line);
    const [name, ...args] = tokens;
    if (this.shellHost.linuxReady() && !LOCAL_ONLY.has(name ?? '')) {
      await this.runRemote(line);
      return;
    }

    const command = this.commands.find((candidate) => candidate.name === name);
    if (!command) {
      this.error(`command not found: ${name}. Try \`help\`.`);
      return;
    }
    try {
      const result = command.run({ args, raw: line });
      if (typeof result === 'string' && result) this.terminal?.write(result.replace(/\n/g, '\r\n'));
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async runRemote(command: string): Promise<void> {
    const terminal = this.terminal;
    if (!terminal) return;
    this.running = true;
    terminal.write('\x1b[38;2;100;116;139m[linux]\x1b[0m ');
    try {
      const result = await this.shellHost.runLinux(command, this.cwd, (text) => {
        terminal.write(text.replace(/\r?\n/g, '\r\n'));
      });
      if (result.exitCode !== 0) {
        this.error(`[exit ${result.exitCode}]`);
      }
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private error(message: string): void {
    this.terminal?.writeln(`\x1b[38;2;248;113;113m${message}\x1b[0m`);
  }

  private resolve(path: string | undefined): string {
    if (!path || path === '.') return this.cwd;
    if (path.startsWith('/workspace')) {
      return normalizePath(path.slice('/workspace'.length));
    }
    if (path === '~') return '';
    return normalizePath(joinPath(this.cwd, path));
  }

  private childrenOf(directory: string): string[] {
    const prefix = directory ? `${directory}/` : '';
    const children = new Set<string>();
    for (const entry of this.shellHost.workspace.list()) {
      if (!entry.path.startsWith(prefix) || entry.path === '') continue;
      const rest = entry.path.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      children.add(entry.type === 'dir' ? `${rest}/` : rest);
    }
    return [...children].sort();
  }

  private formatEntry(entryPath: string, type: 'file' | 'dir', size = 0): string {
    const name = type === 'dir' ? `${basename(entryPath)}/` : basename(entryPath);
    const kind = type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
    const sizeText = type === 'dir' ? '   -' : formatBytes(size).padStart(6);
    return `${kind}  ${sizeText}  ${name}`;
  }

  private createCommands(): ShellCommand[] {
    const workspace = this.shellHost.workspace;
    return [
      {
        name: 'help',
        summary: 'List available commands',
        run: () => {
          const rows = this.commands.map((command) => `  ${command.name.padEnd(12)} ${command.summary}`);
          return [
            'Flaxia Studio workspace shell',
            '',
            ...rows,
            '',
            'The shell edits the same browser workspace as Monaco. Type `boot` to start Linux.',
          ].join('\n');
        },
      },
      {
        name: 'pwd',
        summary: 'Print the working directory',
        run: () => `/workspace${this.cwd ? `/${this.cwd}` : ''}`,
      },
      {
        name: 'ls',
        summary: 'List directory contents',
        usage: 'ls [path]',
        run: ({ args }) => {
          const target = this.resolve(args[0]);
          const entry = workspace.get(target);
          if (target && entry?.type === 'file') return this.formatEntry(target, 'file', entry.content.length);
          if (target && !entry) throw new Error(`ls: ${args[0]}: no such file or directory`);
          const children = this.childrenOf(target);
          if (children.length === 0) return '';
          return children
            .map((child) => {
              const path = joinPath(target, child.replace(/\/$/, ''));
              const current = workspace.get(path);
              return this.formatEntry(
                path,
                current?.type ?? (child.endsWith('/') ? 'dir' : 'file'),
                current?.content.length ?? 0,
              );
            })
            .join('\n');
        },
      },
      {
        name: 'cd',
        summary: 'Change directory',
        usage: 'cd [path]',
        run: ({ args }) => {
          const target = this.resolve(args[0] ?? '');
          if (target && workspace.get(target)?.type !== 'dir')
            throw new Error(`cd: ${args[0]}: not a directory`);
          this.cwd = target;
        },
      },
      {
        name: 'cat',
        summary: 'Print a file',
        usage: 'cat <file>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('cat: missing file operand');
          const path = this.resolve(args[0]);
          const content = workspace.readFile(path);
          if (content === null) throw new Error(`cat: ${args[0]}: no such file`);
          return content;
        },
      },
      {
        name: 'edit',
        summary: 'Open a file in Monaco',
        usage: 'edit <file>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('edit: missing file operand');
          const path = this.resolve(args[0]);
          if (!workspace.readFile(path)) throw new Error(`edit: ${args[0]}: no such file`);
          this.shellHost.openFile(path);
          return `Opened /workspace/${path}`;
        },
      },
      {
        name: 'touch',
        summary: 'Create an empty file',
        usage: 'touch <file>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('touch: missing file operand');
          const path = this.resolve(args[0]);
          if (workspace.has(path)) return '';
          void workspace.createFile(path, '');
          return '';
        },
      },
      {
        name: 'mkdir',
        summary: 'Create a directory',
        usage: 'mkdir <dir>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('mkdir: missing operand');
          void workspace.createFolder(this.resolve(args[0]));
          return '';
        },
      },
      {
        name: 'rm',
        summary: 'Remove a file or directory',
        usage: 'rm <path>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('rm: missing operand');
          const path = this.resolve(args[0]);
          if (!path) throw new Error('rm: refusing to remove /workspace');
          void workspace.remove(path);
          return '';
        },
      },
      {
        name: 'echo',
        summary: 'Print arguments',
        usage: 'echo <text>',
        run: ({ args }) => args.join(' '),
      },
      {
        name: 'find',
        summary: 'Find workspace paths',
        usage: 'find [pattern]',
        run: ({ args }) => {
          const pattern = (args[0] ?? '').toLowerCase();
          return workspace
            .filePaths()
            .filter((path) => path.toLowerCase().includes(pattern))
            .map((path) => `/workspace/${path}`)
            .join('\n');
        },
      },
      {
        name: 'wc',
        summary: 'Count lines, words, and characters',
        usage: 'wc <file>',
        run: ({ args }) => {
          if (!args[0]) throw new Error('wc: missing file operand');
          const content = workspace.readFile(this.resolve(args[0]));
          if (content === null) throw new Error(`wc: ${args[0]}: no such file`);
          const lines = content.split('\n').length;
          const words = content.trim() ? content.trim().split(/\s+/).length : 0;
          return `${lines} ${words} ${content.length} ${args[0]}`;
        },
      },
      {
        name: 'tree',
        summary: 'Show the workspace tree',
        run: () => {
          const rows: string[] = ['/workspace'];
          const walk = (directory: string, indent: string) => {
            const children = this.childrenOf(directory);
            children.forEach((child, index) => {
              const last = index === children.length - 1;
              const path = joinPath(directory, child.replace(/\/$/, ''));
              const entry = workspace.get(path);
              rows.push(`${indent}${last ? '└─' : '├─'} ${child}`);
              if (entry?.type === 'dir') walk(path, `${indent}${last ? '  ' : '│ '}`);
            });
          };
          walk('', '');
          return rows.join('\n');
        },
      },
      {
        name: 'boot',
        summary: 'Boot the container2wasm Linux image',
        run: () => {
          this.shellHost.bootLinux();
          return 'Requested Linux boot. Watch the VM status pill and the container panel.';
        },
      },
      {
        name: 'vm',
        summary: 'Show Linux runtime status',
        run: () => {
          const status = document.querySelector<HTMLElement>('[data-vm-detail]')?.dataset.vmDetail;
          return status ?? 'Linux runtime status unavailable.';
        },
      },
      {
        name: 'clear-cache',
        summary: 'Delete the cached Linux image',
        run: () => {
          this.shellHost.clearLinuxCache();
          return 'Cleared the cached Linux image.';
        },
      },
      {
        name: 'export',
        summary: 'Export the workspace as a ZIP',
        run: () => {
          this.shellHost.exportWorkspace();
          return 'Export started.';
        },
      },
      {
        name: 'date',
        summary: 'Print the current date',
        run: () => new Date().toString(),
      },
      {
        name: 'uname',
        summary: 'Print shell information',
        run: () => 'Flaxia-Studio browser shell (Linux VM not attached)',
      },
      {
        name: 'clear',
        summary: 'Clear the terminal',
        run: () => {
          this.clear();
        },
      },
    ];
  }
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function readTerminalTheme(resolved?: 'light' | 'dark'): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
} {
  const mode = resolved ?? (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  if (mode === 'dark') {
    return {
      background: '#1b212e',
      foreground: '#f8fafc',
      cursor: '#34d399',
      selectionBackground: '#10b98138',
      black: '#181d28',
      red: '#f87171',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#67e8f9',
      white: '#e2e8f0',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#6ee7b7',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#a5f3fc',
      brightWhite: '#f8fafc',
    };
  }
  return {
    background: '#ffffff',
    foreground: '#0f172a',
    cursor: '#10b981',
    selectionBackground: '#10b98120',
    black: '#0f172a',
    red: '#dc2626',
    green: '#047857',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0e7490',
    white: '#e2e8f0',
    brightBlack: '#64748b',
    brightRed: '#ef4444',
    brightGreen: '#10b981',
    brightYellow: '#d97706',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  };
}

export function pathForTerminal(path: string): string {
  return dirname(path) ? `${dirname(path)}/${basename(path)}` : basename(path);
}
