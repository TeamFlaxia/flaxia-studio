import { EditorManager } from './editor/monaco';
import { basename, dirname, isPathInside, joinPath, languageForPath } from './fs/path';
import type { WorkspaceEntry } from './fs/workspace';
import { Workspace } from './fs/workspace';
import { el, formatBytes, iconButton } from './lib/dom';
import { fileIcon, type IconName, icon } from './lib/icons';
import { loadSettings, type Settings, saveSettings } from './lib/settings';
import { matchesShortcut, modShortcut } from './lib/shortcut';
import { cycleTheme, getTheme, initTheme, setTheme, themeLabel } from './lib/theme';
import { LinuxRuntime, type LinuxStatus } from './linux/runtime';
import { StudioShell } from './terminal/shell';
import { showContextMenu } from './ui/context-menu';
import { confirmDialog, openDialog, promptDialog } from './ui/dialog';
import { isPaletteOpen, openPalette, type PaletteItem } from './ui/palette';
import { toast } from './ui/toast';

type SidebarView = 'explorer' | 'search' | 'linux';
type PanelView = 'terminal' | 'output' | 'problems';

interface SearchResult {
  path: string;
  line: number;
  text: string;
}

interface TreeNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  children: TreeNode[];
}

const MAX_OUTPUT_LINES = 600;

export class App implements ShellHostish {
  readonly workspace: Workspace;
  settings: Settings;
  private root!: HTMLElement;
  private topbar!: HTMLElement;
  private rail!: HTMLElement;
  private sidebar!: HTMLElement;
  private sidebarTitle!: HTMLElement;
  private sidebarActions!: HTMLElement;
  private sidebarBody!: HTMLElement;
  private editorArea!: HTMLElement;
  private tabsBar!: HTMLElement;
  private breadcrumbs!: HTMLElement;
  private editorHost!: HTMLElement;
  private welcome!: HTMLElement;
  private panel!: HTMLElement;
  private panelHead!: HTMLElement;
  private panelBody!: HTMLElement;
  private terminalView!: HTMLElement;
  private outputView!: HTMLElement;
  private problemsView!: HTMLElement;
  private statusbar!: HTMLElement;
  private vmPill!: HTMLButtonElement;
  private vmDetail!: HTMLElement;
  private commandTrigger!: HTMLButtonElement;
  private themeButton!: HTMLButtonElement;
  private importInput!: HTMLInputElement;
  private editor: EditorManager;
  private shell: StudioShell;
  private linux = new LinuxRuntime();
  private readonly openTabs: string[] = [];
  private activePath: string | null = null;
  private selectedPath: string | null = null;
  private collapsedDirs = new Set<string>();
  private sidebarView: SidebarView = 'explorer';
  private panelView: PanelView = 'terminal';
  private panelVisible = true;
  private sidebarVisible = !window.matchMedia?.('(max-width: 720px)').matches;
  private searchQuery = '';
  private searchResults: SearchResult[] = [];
  private cursor = { line: 1, column: 1, selected: 0 };
  private outputLines: Array<{ time: string; message: string }> = [];
  private saveTimers = new Map<string, number>();
  private lastLinuxStatus: LinuxStatus;
  private linuxUnsubscribe: (() => void) | null = null;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    this.settings = loadSettings();
    this.lastLinuxStatus = this.linux.status();
    this.editorHost = el('div', { class: 'editor-host', attrs: { 'aria-label': 'Editor' } });
    this.editor = new EditorManager(this.editorHost);
    this.shell = new StudioShell(this);
    this.linux.setManifestUrl(this.settings.linuxManifestUrl);
    this.linux.setNetworkEnabled(this.settings.linuxNetwork);
  }

  static async create(): Promise<App> {
    const workspace = await Workspace.openDefault();
    return new App(workspace);
  }

  mount(root: HTMLElement): void {
    initTheme();
    setTheme(this.settings.theme);
    this.root = root;
    this.buildShell();
    this.editor.init({
      onChange: (path) => this.handleEditorChange(path),
      onCursor: (position) => {
        this.cursor = position;
        this.renderStatus();
      },
      onFocus: () => undefined,
    });
    this.editor.setSettings({
      fontSize: this.settings.fontSize,
      tabSize: this.settings.tabSize,
      wordWrap: this.settings.wordWrap,
      minimap: this.settings.minimap,
    });
    this.editor.setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    this.shell.mount();
    this.shell.setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    this.linuxUnsubscribe = this.linux.subscribe((status) => this.handleLinuxStatus(status));
    this.bindKeys();
    window.addEventListener('flaxia:theme', () => {
      const resolved = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      this.editor.setTheme(resolved);
      this.shell.setTheme(resolved);
      this.renderTopbarTheme(this.themeButton);
    });
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('pagehide', () => {
      this.linuxUnsubscribe?.();
      this.linux.dispose();
    });
    this.showWelcome();
    this.render();
    this.log('Flaxia Studio ready. Workspace is stored in IndexedDB.');
    this.log(`Linux manifest: ${this.settings.linuxManifestUrl}`);
    window.setTimeout(() => this.shell.fit(), 80);
  }

  // ------------------------------------------------------------
  // Shell construction
  // ------------------------------------------------------------
  private buildShell(): void {
    this.topbar = el('header', { class: 'topbar' });
    this.rail = el('nav', { class: 'activity-rail', attrs: { 'aria-label': 'Activity' } });
    this.sidebar = el('aside', { class: 'sidebar', attrs: { 'aria-label': 'Sidebar' } });
    this.sidebarTitle = el('div', { class: 'sidebar-title', text: 'Explorer' });
    this.sidebarActions = el('div', { class: 'sidebar-actions' });
    this.sidebarBody = el('div', { class: 'sidebar-body' });
    this.sidebar.append(
      el('div', { class: 'sidebar-header' }, [this.sidebarTitle, this.sidebarActions]),
      this.sidebarBody,
    );

    this.tabsBar = el('div', { class: 'tabs', role: 'tablist', attrs: { 'aria-label': 'Open editors' } });
    this.breadcrumbs = el('div', { class: 'breadcrumbs' });
    this.welcome = el('div', { class: 'welcome' });
    this.editorArea = el('main', { class: 'editor-area' }, [
      this.tabsBar,
      this.breadcrumbs,
      this.editorHost,
      this.welcome,
    ]);

    const body = el('div', { class: 'studio-body' }, [this.rail, this.sidebar, this.editorArea]);

    this.panel = el('section', { class: 'panel', attrs: { 'aria-label': 'Panel' } });
    this.panelHead = el('div', { class: 'panel-head' });
    this.panelBody = el('div', { class: 'panel-body' });
    this.terminalView = el('div', { class: 'panel-view is-active', dataset: { view: 'terminal' } }, [
      this.shell.host,
    ]);
    this.outputView = el('div', { class: 'panel-view output-view', dataset: { view: 'output' } });
    this.problemsView = el('div', { class: 'panel-view problems-view', dataset: { view: 'problems' } }, [
      el('div', { class: 'terminal-note' }, [
        icon('check', 15),
        'No problems have been detected in the workspace.',
      ]),
    ]);
    this.panelBody.append(this.terminalView, this.outputView, this.problemsView);
    const resizer = el('div', { class: 'panel-resizer', attrs: { 'aria-hidden': 'true' } });
    this.panel.append(resizer, this.panelHead, this.panelBody);

    this.statusbar = el('footer', { class: 'statusbar', attrs: { 'aria-label': 'Status bar' } });
    this.importInput = el('input', {
      type: 'file',
      attrs: { accept: '.zip,application/zip', hidden: 'true' },
    });
    this.importInput.addEventListener('change', () => void this.handleImportFile());

    this.root.append(this.topbar, body, this.panel, this.statusbar, this.importInput);
    this.buildTopbar();
    this.buildRail();
    this.renderSidebarHeader();
    this.buildPanelHead();
    this.buildStatusbar();
    this.bindResizer(resizer);
  }

  private buildTopbar(): void {
    const brand = el(
      'button',
      { class: 'brand', type: 'button', title: 'Flaxia Studio', on: { click: () => this.showWelcome() } },
      [
        el('span', { class: 'brand-mark' }, [icon('flame', 14)]),
        el('span', { class: 'brand-text' }, [
          el('span', { class: 'brand-name', text: 'Flaxia' }),
          el('span', { class: 'brand-sub', text: 'Studio' }),
        ]),
      ],
    );

    const workspaceChip = el(
      'button',
      {
        class: 'workspace-chip',
        type: 'button',
        title: 'Rename workspace',
        on: { click: () => void this.renameWorkspace() },
      },
      [icon('hard-drive', 14), el('span', { class: 'workspace-name', text: this.workspace.name })],
    );

    this.commandTrigger = el(
      'button',
      {
        class: 'command-trigger',
        type: 'button',
        on: { click: () => this.openCommands() },
        attrs: { 'aria-label': 'Open command palette' },
      },
      [
        icon('search', 14),
        el('span', { class: 'command-trigger-label', text: 'Search commands and files' }),
        el('span', { class: 'kbd', text: modShortcut('K') }),
      ],
    );

    this.vmPill = el(
      'button',
      {
        class: 'vm-pill',
        type: 'button',
        dataset: { state: 'idle' },
        title: 'Boot Linux (container2wasm)',
        on: { click: () => void this.bootLinux() },
      },
      [el('span', { class: 'vm-dot' }), el('span', { class: 'vm-pill-label', text: 'Linux' })],
    ) as HTMLButtonElement;
    this.vmDetail = el('span', { class: 'hidden', dataset: { vmDetail: 'Not booted' } });

    const themeButton = iconButton('sun', `Theme: ${themeLabel(getTheme())}`, () => {
      const next = cycleTheme();
      this.settings.theme = next;
      this.saveSettings();
      toast('Theme', themeLabel(next), 'info', 1600);
      this.renderTopbarTheme(themeButton);
    });
    this.themeButton = themeButton;
    this.renderTopbarTheme(themeButton);

    const settingsButton = iconButton('settings', 'Settings', () => void this.openSettings());
    const actions = el('div', { class: 'topbar-actions' }, [
      this.vmPill,
      iconButton('terminal', 'Toggle panel', () => this.togglePanel()),
      themeButton,
      settingsButton,
    ]);

    this.topbar.append(
      brand,
      el('span', { class: 'topbar-sep' }),
      workspaceChip,
      this.commandTrigger,
      actions,
      this.vmDetail,
    );
  }

  private renderTopbarTheme(button: HTMLButtonElement): void {
    const theme = getTheme();
    button.replaceChildren(icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor', 16));
    button.title = `Theme: ${themeLabel(theme)}`;
    button.setAttribute('aria-label', `Theme: ${themeLabel(theme)}`);
  }

  private buildRail(): void {
    const entries: Array<{ view: SidebarView; icon: IconName; label: string }> = [
      { view: 'explorer', icon: 'layers', label: 'Explorer' },
      { view: 'search', icon: 'search', label: 'Search' },
      { view: 'linux', icon: 'container', label: 'Linux' },
    ];
    for (const entry of entries) {
      const button = el(
        'button',
        {
          class: 'rail-button',
          type: 'button',
          title: entry.label,
          attrs: { 'aria-label': entry.label, 'aria-pressed': String(this.sidebarView === entry.view) },
          dataset: { view: entry.view },
          on: { click: () => this.selectSidebar(entry.view) },
        },
        [icon(entry.icon, 18)],
      );
      this.rail.appendChild(button);
    }
    this.rail.append(
      el('div', { class: 'rail-spacer' }),
      el(
        'button',
        {
          class: 'rail-button',
          type: 'button',
          title: 'Settings',
          attrs: { 'aria-label': 'Settings' },
          on: { click: () => void this.openSettings() },
        },
        [icon('settings', 18)],
      ),
    );
  }

  private selectSidebar(view: SidebarView): void {
    if (this.sidebarView === view && this.sidebarVisible) {
      this.sidebarVisible = false;
    } else {
      this.sidebarView = view;
      this.sidebarVisible = true;
    }
    this.render();
    window.setTimeout(() => this.layout(), 0);
  }

  private render(): void {
    this.renderRail();
    this.renderSidebar();
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderWelcome();
    this.renderPanelHead();
    this.renderOutput();
    this.renderStatus();
    this.sidebar.classList.toggle('hidden', !this.sidebarVisible);
    this.root.classList.toggle('is-panel-hidden', !this.panelVisible);
    this.renderLinuxCard();
  }

  private renderRail(): void {
    this.rail.querySelectorAll<HTMLElement>('[data-view]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(this.sidebarView === button.dataset.view && this.sidebarVisible),
      );
    });
  }

  // ------------------------------------------------------------
  // Sidebar
  // ------------------------------------------------------------
  private renderSidebarHeader(): void {
    const titles: Record<SidebarView, string> = {
      explorer: 'Explorer',
      search: 'Search',
      linux: 'Linux',
    };
    this.sidebarTitle.textContent = titles[this.sidebarView];
    this.sidebarActions.replaceChildren();
    if (this.sidebarView === 'explorer') {
      this.sidebarActions.append(
        iconButton('file', 'New file', () => void this.newFile(), { size: 15 }),
        iconButton('folder-plus', 'New folder', () => void this.newFolder(), { size: 15 }),
        iconButton('download', 'Import ZIP', () => this.importInput.click(), { size: 15 }),
        iconButton('upload', 'Export ZIP', () => this.exportWorkspace(), { size: 15 }),
        iconButton('refresh', 'Refresh', () => this.renderSidebar(), { size: 15 }),
      );
    } else if (this.sidebarView === 'linux') {
      this.sidebarActions.append(
        iconButton('play', 'Boot Linux', () => void this.bootLinux(), { size: 15 }),
        iconButton('refresh', 'Refresh status', () => this.handleLinuxStatus(this.linux.status()), {
          size: 15,
        }),
      );
    }
  }

  private renderSidebar(): void {
    this.renderSidebarHeader();
    if (this.sidebarView === 'explorer') this.renderExplorer();
    else if (this.sidebarView === 'search') this.renderSearch();
    else this.renderLinuxPanel();
  }

  private renderExplorer(): void {
    const tree = buildTree(this.workspace.list());
    this.sidebarBody.replaceChildren();
    if (tree.length === 0) {
      this.sidebarBody.appendChild(
        el('div', { class: 'sidebar-empty', text: 'This workspace is empty. Create a file to begin.' }),
      );
      return;
    }
    const list = el('div', { class: 'tree', role: 'tree' });
    const renderNodes = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        const open = node.type === 'dir' && !this.collapsedDirs.has(node.path);
        const row = el(
          'button',
          {
            class:
              `tree-row ${this.activePath === node.path || this.selectedPath === node.path ? 'is-selected' : ''}`.trim(),
            type: 'button',
            role: 'treeitem',
            dataset: { type: node.type, depth: String(depth), open: String(open), path: node.path },
            attrs: {
              'aria-selected': String(this.activePath === node.path),
              'aria-expanded': node.type === 'dir' ? String(open) : undefined,
              title: node.path,
              style: `--depth:${depth}`,
            },
            on: {
              click: () => {
                this.selectedPath = node.path;
                if (node.type === 'dir') {
                  if (open) this.collapsedDirs.add(node.path);
                  else this.collapsedDirs.delete(node.path);
                  this.renderExplorer();
                } else {
                  this.openFile(node.path);
                }
              },
              contextmenu: (event) => {
                event.preventDefault();
                this.selectedPath = node.path;
                this.renderExplorer();
                showContextMenu(event.clientX, event.clientY, this.explorerContextItems(node));
              },
            },
          },
          [
            el(
              'span',
              { class: `tree-caret ${node.type === 'file' || node.children.length === 0 ? 'is-empty' : ''}` },
              [icon(open ? 'chevron-down' : 'chevron-right', 13)],
            ),
            el('span', { class: 'tree-icon' }, [
              icon(node.type === 'dir' ? (open ? 'folder-open' : 'folder') : fileIcon(node.path), 15),
            ]),
            el('span', { class: 'tree-label', text: node.name }),
          ],
        );
        list.appendChild(row);
        if (node.type === 'dir' && open) renderNodes(node.children, depth + 1);
      }
    };
    renderNodes(tree, 0);
    this.sidebarBody.appendChild(list);
  }

  private explorerContextItems(node: TreeNode) {
    const items = [];
    if (node.type === 'file') {
      items.push({ label: 'Open', icon: 'file' as IconName, run: () => this.openFile(node.path) });
    } else {
      items.push(
        { label: 'New File', icon: 'file' as IconName, run: () => void this.newFile(node.path) },
        { label: 'New Folder', icon: 'folder-plus' as IconName, run: () => void this.newFolder(node.path) },
      );
    }
    items.push(
      { label: 'Rename…', icon: 'pencil' as IconName, run: () => void this.renamePath(node.path) },
      {
        label: 'Delete…',
        icon: 'trash' as IconName,
        danger: true,
        run: () => void this.deletePath(node.path),
      },
      {
        label: 'Copy Path',
        icon: 'copy' as IconName,
        run: () => {
          void navigator.clipboard?.writeText(node.path);
          toast('Copied path', node.path, 'info', 1600);
        },
      },
    );
    return items;
  }

  private renderSearch(): void {
    this.sidebarBody.replaceChildren();
    const input = el('input', {
      class: 'search-input',
      type: 'search',
      attrs: { placeholder: 'Search workspace…', value: this.searchQuery, spellcheck: 'false' },
      on: {
        input: () => {
          this.searchQuery = input.value;
          this.runSearch();
        },
      },
    });
    const form = el('div', { class: 'search-form' }, [input]);
    this.sidebarBody.appendChild(form);
    this.sidebarBody.appendChild(
      el('div', {
        class: 'search-summary',
        text: this.searchQuery
          ? `${this.searchResults.length} result${this.searchResults.length === 1 ? '' : 's'}`
          : 'Search every text file in the workspace.',
      }),
    );
    for (const result of this.searchResults) {
      const row = el(
        'button',
        {
          class: 'search-result',
          type: 'button',
          title: `${result.path}:${result.line}`,
          on: {
            click: () => {
              this.openFile(result.path, result.line);
            },
          },
        },
        [
          el('span', { class: 'search-result-path' }, [icon('file', 13), `${result.path}:${result.line}`]),
          el('span', { class: 'search-result-line', text: result.text }),
        ],
      );
      this.sidebarBody.appendChild(row);
    }
    window.setTimeout(() => input.focus(), 0);
  }

  private runSearch(): void {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) {
      this.searchResults = [];
      this.renderSearch();
      return;
    }
    const results: SearchResult[] = [];
    for (const path of this.workspace.filePaths()) {
      const content = this.workspace.readFile(path) ?? '';
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(query)) continue;
        results.push({ path, line: index + 1, text: line.trim().slice(0, 160) });
        if (results.length >= 100) break;
      }
      if (results.length >= 100) break;
    }
    this.searchResults = results;
    this.renderSearch();
  }

  private renderLinuxPanel(): void {
    this.sidebarBody.replaceChildren();
    const status = this.lastLinuxStatus;
    const card = el('div', { class: 'sidebar-section' });
    const image = status.image;
    card.append(
      el('div', { class: 'sidebar-section-label', text: 'Container' }),
      el('div', { class: 'linux-card' }, [
        el('div', { class: 'linux-card-head' }, [
          el('span', { class: 'linux-card-title', text: status.label }),
          el('span', { class: 'kbd', text: status.state }),
        ]),
        el('div', { class: 'linux-card-meta', text: status.detail }),
        status.progress
          ? el('div', { class: 'linux-progress' }, [
              el('div', {
                class: 'linux-progress-fill',
                attrs: {
                  style: `width:${status.progress.total > 0 ? Math.round((status.progress.loaded / status.progress.total) * 100) : 0}%`,
                },
              }),
            ])
          : null,
        image
          ? el('div', {
              class: 'linux-card-meta',
              text: `${image.version} · ${image.chunks} chunks · ${formatBytes(image.totalBytes)}`,
            })
          : el('div', { class: 'linux-card-meta', text: 'No image manifest loaded yet.' }),
        el('div', { class: 'linux-card-head' }, [
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              on: { click: () => void this.bootLinux() },
              attrs: { disabled: status.state === 'loading' || status.state === 'running' },
            },
            [icon('power', 14), status.state === 'ready' ? 'Restart check' : 'Boot Linux'],
          ),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              on: { click: () => void this.clearLinuxCache() },
            },
            [icon('trash', 14), 'Cache'],
          ),
        ]),
      ]),
    );

    const info = el('div', { class: 'sidebar-section' }, [
      el('div', { class: 'sidebar-section-label', text: 'Workspace' }),
      el('div', { class: 'linux-card-meta', text: `${this.workspace.filePaths().length} files · IndexedDB` }),
      el('div', {
        class: 'linux-card-meta',
        text: 'Linux mounts the workspace at /workspace. Text files are synced after each command.',
      }),
    ]);

    const help = el('div', { class: 'sidebar-section' }, [
      el('div', { class: 'sidebar-section-label', text: 'Manifest' }),
      el('div', { class: 'linux-card-meta mono', text: this.settings.linuxManifestUrl }),
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          on: { click: () => void this.openSettings() },
        },
        [icon('settings', 14), 'Change in Settings'],
      ),
    ]);
    this.sidebarBody.append(card, info, help);
  }

  private renderLinuxCard(): void {
    if (this.sidebarView === 'linux') this.renderLinuxPanel();
  }

  // ------------------------------------------------------------
  // Editor / tabs
  // ------------------------------------------------------------
  private renderTabs(): void {
    this.tabsBar.replaceChildren();
    for (const path of this.openTabs) {
      const active = path === this.activePath;
      const dirty = this.editor.isDirty(path);
      const tab = el(
        'div',
        {
          class: `tab ${active ? 'is-active' : ''} ${dirty ? 'is-dirty' : ''}`.trim(),
          role: 'tab',
          attrs: { 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: path },
          dataset: { path },
          on: {
            click: () => this.openFile(path),
            keydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') this.openFile(path);
            },
            contextmenu: (event) => {
              event.preventDefault();
              showContextMenu(event.clientX, event.clientY, [
                { label: 'Close', icon: 'x', run: () => void this.closeFile(path) },
                {
                  label: 'Close Others',
                  icon: 'x',
                  run: () => void this.closeOthers(path),
                },
                { label: 'Copy Path', icon: 'copy', run: () => void navigator.clipboard?.writeText(path) },
              ]);
            },
          },
        },
        [
          el('span', { class: 'tab-icon' }, [icon(fileIcon(path), 14)]),
          el('span', { class: 'tab-label', text: basename(path) }),
          dirty
            ? el('span', { class: 'tab-dot', title: 'Unsaved changes' })
            : el(
                'button',
                {
                  class: 'tab-close',
                  type: 'button',
                  attrs: { 'aria-label': `Close ${path}` },
                  on: {
                    click: (event) => {
                      event.stopPropagation();
                      void this.closeFile(path);
                    },
                  },
                },
                [icon('x', 13)],
              ),
        ],
      );
      this.tabsBar.appendChild(tab);
    }
    this.tabsBar.appendChild(el('div', { class: 'tab-spacer' }));
    this.tabsBar.appendChild(
      iconButton('plus', 'New file', () => void this.newFile(), { size: 14, className: 'tab-new' }),
    );
  }

  private renderBreadcrumbs(): void {
    this.breadcrumbs.replaceChildren();
    if (!this.activePath) {
      this.breadcrumbs.appendChild(el('span', { text: this.workspace.name }));
      return;
    }
    const parts = this.activePath.split('/');
    let current = '';
    parts.forEach((part, index) => {
      current = current ? `${current}/${part}` : part;
      if (index > 0) this.breadcrumbs.appendChild(el('span', { class: 'breadcrumb-sep', text: '/' }));
      if (index === parts.length - 1) {
        this.breadcrumbs.appendChild(el('span', { text: part }));
      } else {
        this.breadcrumbs.appendChild(
          el('button', {
            type: 'button',
            text: part,
            on: {
              click: () => {
                this.selectedPath = current;
                this.renderExplorer();
              },
            },
          }),
        );
      }
    });
  }

  private renderWelcome(): void {
    const hidden = this.activePath !== null;
    this.welcome.classList.toggle('hidden', hidden);
    if (hidden) return;
    if (this.welcome.childElementCount > 0) return;

    const actions: Array<{ icon: IconName; title: string; desc: string; run: () => void }> = [
      {
        icon: 'file-code',
        title: 'New File',
        desc: 'Create a file in the current workspace',
        run: () => void this.newFile(),
      },
      {
        icon: 'search',
        title: 'Quick Open',
        desc: `${modShortcut('P')} to jump to any file`,
        run: () => this.openQuickOpen(),
      },
      {
        icon: 'download',
        title: 'Import ZIP',
        desc: 'Bring an existing project into Flaxia Studio',
        run: () => this.importInput.click(),
      },
      {
        icon: 'container',
        title: 'Boot Linux',
        desc: 'Run a container2wasm Debian image in this tab',
        run: () => void this.bootLinux(),
      },
    ];

    const inner = el('div', { class: 'welcome-inner' }, [
      el('span', { class: 'welcome-kicker' }, [icon('flame', 12), 'Flaxia Studio']),
      el('h1', {}, ['Code with the ', el('span', { text: 'Flaxia' }), ' feel.']),
      el('p', {
        class: 'welcome-lede',
        text: 'A Monaco editor with a real Linux workspace running in WebAssembly. Quiet surfaces, emerald accents, and a command palette that stays out of your way.',
      }),
      el(
        'div',
        { class: 'welcome-grid' },
        actions.map((action) =>
          el('button', { class: 'welcome-card', type: 'button', on: { click: action.run } }, [
            el('span', { class: 'welcome-card-icon' }, [icon(action.icon, 16)]),
            el('span', {}, [
              el('div', { class: 'welcome-card-title', text: action.title }),
              el('div', { class: 'welcome-card-desc', text: action.desc }),
            ]),
          ]),
        ),
      ),
      el('div', { class: 'welcome-meta' }, [
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('K') }), 'Commands']),
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('S') }), 'Save']),
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('`') }), 'Terminal']),
        el('span', { text: 'Workspace: IndexedDB · Linux: container2wasm' }),
      ]),
    ]);
    this.welcome.replaceChildren(inner);
  }

  private showWelcome(): void {
    this.activePath = null;
    this.editor.show(false);
    this.welcome.classList.remove('hidden');
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderWelcome();
    this.renderStatus();
  }

  openFile(path: string, line?: number): void {
    const content = this.workspace.readFile(path);
    if (content === null) {
      toast('Cannot open file', `${path} does not exist.`, 'warning');
      return;
    }
    if (!this.openTabs.includes(path)) this.openTabs.push(path);
    this.activePath = path;
    this.selectedPath = path;
    this.editor.show(true);
    this.welcome.classList.add('hidden');
    this.editor.open(path, content, languageForPath(path));
    if (line) window.setTimeout(() => this.editor.revealLine(path, line), 30);
    if (window.matchMedia?.('(max-width: 720px)').matches) this.sidebarVisible = false;
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderExplorer();
    this.renderSidebar();
    this.renderStatus();
    window.setTimeout(() => this.layout(), 0);
  }

  private async closeFile(path: string, discard = false): Promise<void> {
    if (!discard && this.editor.isDirty(path)) await this.saveFile(path);
    this.editor.close(path);
    const index = this.openTabs.indexOf(path);
    if (index >= 0) this.openTabs.splice(index, 1);
    if (this.activePath === path) {
      const next = this.openTabs[Math.max(0, index - 1)];
      if (next) this.openFile(next);
      else this.showWelcome();
    }
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderExplorer();
    this.renderStatus();
  }

  private async closeOthers(keep: string): Promise<void> {
    for (const path of [...this.openTabs]) {
      if (path === keep) continue;
      await this.closeFile(path);
    }
    this.openFile(keep);
  }

  private handleEditorChange(path: string): void {
    this.renderTabs();
    if (!this.settings.autoSave) return;
    const existing = this.saveTimers.get(path);
    if (existing) window.clearTimeout(existing);
    this.saveTimers.set(
      path,
      window.setTimeout(() => {
        this.saveTimers.delete(path);
        void this.saveFile(path, true);
      }, 650),
    );
  }

  private async saveFile(path: string, quiet = false): Promise<void> {
    const value = this.editor.getValue(path);
    if (value === null) return;
    await this.workspace.writeFile(path, value);
    this.editor.markSaved(path);
    this.renderTabs();
    if (!quiet) {
      this.log(`Saved ${path}`);
      toast('Saved', path, 'success', 1400);
    }
  }

  private async saveAll(): Promise<void> {
    for (const path of [...this.openTabs]) {
      if (this.editor.isDirty(path)) await this.saveFile(path, true);
    }
    this.log('Saved all open files.');
    toast('Saved all', `${this.openTabs.length} open file(s)`, 'success', 1600);
  }

  // ------------------------------------------------------------
  // File actions
  // ------------------------------------------------------------
  private targetDirectory(): string {
    if (this.selectedPath) {
      const entry = this.workspace.get(this.selectedPath);
      if (entry?.type === 'dir') return this.selectedPath;
      return dirname(this.selectedPath);
    }
    if (this.activePath) return dirname(this.activePath);
    return '';
  }

  private async newFile(directory?: string): Promise<void> {
    const base = directory ?? this.targetDirectory();
    const name = await promptDialog('New File', 'File name', '', {
      hint: base ? `Created in ${base}/` : 'Created at the workspace root',
      placeholder: 'example.ts',
      confirmLabel: 'Create',
    });
    if (!name) return;
    try {
      const path = await this.workspace.createFile(joinPath(base, name), '');
      this.renderExplorer();
      this.openFile(path);
      this.log(`Created ${path}`);
    } catch (error) {
      toast('Could not create file', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async newFolder(directory?: string): Promise<void> {
    const base = directory ?? this.targetDirectory();
    const name = await promptDialog('New Folder', 'Folder name', '', {
      hint: base ? `Created in ${base}/` : 'Created at the workspace root',
      placeholder: 'src',
      confirmLabel: 'Create',
    });
    if (!name) return;
    try {
      const path = await this.workspace.createFolder(joinPath(base, name));
      this.selectedPath = path;
      this.renderExplorer();
      this.log(`Created folder ${path}`);
    } catch (error) {
      toast('Could not create folder', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async renamePath(path: string): Promise<void> {
    const next = await promptDialog('Rename', 'New path', path, { confirmLabel: 'Rename' });
    if (!next || next === path) return;
    try {
      const renamed = await this.workspace.rename(path, next);
      this.remapTabs(path, renamed);
      this.selectedPath = renamed;
      this.renderExplorer();
      this.renderTabs();
      this.renderBreadcrumbs();
      if (this.activePath) {
        const content = this.workspace.readFile(this.activePath);
        if (content !== null) this.editor.open(this.activePath, content, languageForPath(this.activePath));
      }
      this.log(`Renamed ${path} → ${renamed}`);
    } catch (error) {
      toast('Rename failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private remapTabs(from: string, to: string): void {
    for (let index = 0; index < this.openTabs.length; index += 1) {
      const path = this.openTabs[index];
      if (!path || !isPathInside(path, from)) continue;
      const next = `${to}${path.slice(from.length)}`;
      this.openTabs[index] = next;
      const value = this.editor.getValue(path);
      if (value !== null) {
        this.editor.close(path);
        this.editor.open(next, value, languageForPath(next));
      }
      if (this.activePath === path) this.activePath = next;
      if (this.selectedPath === path) this.selectedPath = next;
    }
  }

  private async deletePath(path: string): Promise<void> {
    const confirmed = await confirmDialog('Delete', `Delete "${path}"? This cannot be undone.`, {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    try {
      for (const tab of [...this.openTabs]) {
        if (isPathInside(tab, path)) await this.closeFile(tab, true);
      }
      await this.workspace.remove(path);
      if (this.selectedPath && isPathInside(this.selectedPath, path)) this.selectedPath = null;
      this.renderExplorer();
      this.renderTabs();
      this.log(`Deleted ${path}`);
    } catch (error) {
      toast('Delete failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async renameWorkspace(): Promise<void> {
    const name = await promptDialog('Rename Workspace', 'Workspace name', this.workspace.name, {
      confirmLabel: 'Rename',
    });
    if (!name) return;
    await this.workspace.renameWorkspace(name);
    const chip = this.topbar.querySelector<HTMLElement>('.workspace-name');
    if (chip) chip.textContent = this.workspace.name;
    this.renderBreadcrumbs();
  }

  private async handleImportFile(): Promise<void> {
    const file = this.importInput.files?.[0];
    this.importInput.value = '';
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await this.workspace.importZipBytes(bytes);
      this.renderExplorer();
      this.log(`Imported ${result.imported} file(s) from ${file.name}.`);
      toast(
        'Import complete',
        `${result.imported} file(s) imported${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`,
        'success',
      );
    } catch (error) {
      toast('Import failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  exportWorkspace(): void {
    try {
      const bytes = this.workspace.exportZip();
      const blob = new Blob([bytes.slice().buffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${this.workspace.name || 'flaxia-studio'}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.log('Exported workspace as ZIP.');
      toast('Export started', anchor.download, 'success', 2000);
    } catch (error) {
      toast('Export failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // ------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------
  private buildPanelHead(): void {
    this.panelHead.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-panel-tab]');
      if (button) this.selectPanel(button.dataset.panelTab as PanelView);
    });
    this.panelHead.addEventListener('contextmenu', (event) => event.preventDefault());
    this.renderPanelHead();
  }

  private renderPanelHead(): void {
    const tab = (view: PanelView, label: string, count?: number) =>
      el(
        'button',
        {
          class: 'panel-tab',
          type: 'button',
          dataset: { panelTab: view },
          attrs: { 'aria-selected': String(this.panelView === view) },
        },
        [label, count !== undefined ? el('span', { class: 'count', text: String(count) }) : null],
      );
    this.panelHead.replaceChildren(
      tab('terminal', 'Terminal'),
      tab('output', 'Output'),
      tab('problems', 'Problems', 0),
      el('div', { class: 'panel-spacer' }),
      el('div', { class: 'panel-actions' }, [
        iconButton('trash', 'Clear output', () => this.clearOutput(), { size: 14 }),
        iconButton('x', 'Hide panel', () => this.togglePanel(), { size: 14 }),
      ]),
    );
  }

  private selectPanel(view: PanelView): void {
    this.panelView = view;
    this.panelVisible = true;
    this.root.classList.remove('is-panel-hidden');
    for (const node of this.panelBody.querySelectorAll<HTMLElement>('[data-view]')) {
      node.classList.toggle('is-active', node.dataset.view === view);
    }
    this.renderPanelHead();
    this.layout();
    if (view === 'terminal') this.shell.focus();
  }

  private togglePanel(): void {
    this.panelVisible = !this.panelVisible;
    this.root.classList.toggle('is-panel-hidden', !this.panelVisible);
    this.layout();
    if (this.panelVisible) this.shell.fit();
  }

  private showTerminal(): void {
    this.panelVisible = true;
    this.root.classList.remove('is-panel-hidden');
    this.selectPanel('terminal');
  }

  private log(message: string): void {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.outputLines.push({ time, message });
    if (this.outputLines.length > MAX_OUTPUT_LINES) this.outputLines.shift();
    this.renderOutput();
  }

  private renderOutput(): void {
    this.outputView.replaceChildren(
      ...this.outputLines.map((line) =>
        el('div', { class: 'output-line' }, [
          el('span', { class: 'output-time', text: line.time }),
          el('span', { text: line.message }),
        ]),
      ),
    );
    this.outputView.scrollTop = this.outputView.scrollHeight;
  }

  private clearOutput(): void {
    this.outputLines = [];
    this.renderOutput();
  }

  private bindResizer(resizer: HTMLElement): void {
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startHeight = this.panel.getBoundingClientRect().height;
      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.max(
          110,
          Math.min(window.innerHeight * 0.7, startHeight + (startY - moveEvent.clientY)),
        );
        document.documentElement.style.setProperty('--panel-h', `${Math.round(next)}px`);
        this.layout();
      };
      const onUp = () => {
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onUp);
        this.layout();
        this.shell.fit();
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', onUp);
    });
  }

  private layout(): void {
    this.editor.layout();
    this.shell.fit();
  }

  // ------------------------------------------------------------
  // Status bar
  // ------------------------------------------------------------
  private buildStatusbar(): void {
    this.statusbar.replaceChildren();
    const item = (name: IconName, text: string, title?: string) =>
      el('span', { class: 'status-item', title: title ?? text }, [icon(name, 12), text]);
    this.statusbar.append(
      item('hard-drive', 'Local', 'Workspace stored in IndexedDB'),
      item('layers', 'main', 'Browser workspace'),
      el('div', { class: 'status-spacer' }),
    );
    const cursor = el('span', { class: 'status-item', dataset: { status: 'cursor' } });
    const language = el('span', { class: 'status-item', dataset: { status: 'language' } });
    const vm = el('button', {
      class: 'status-item',
      type: 'button',
      dataset: { status: 'vm' },
      on: { click: () => void this.bootLinux() },
    });
    this.statusbar.append(
      cursor,
      language,
      el('span', { class: 'status-item', text: 'UTF-8' }),
      el('span', { class: 'status-item', dataset: { status: 'spaces' }, text: 'Spaces: 2' }),
      vm,
    );
    this.renderStatus();
  }

  private renderStatus(): void {
    const cursor = this.statusbar.querySelector<HTMLElement>('[data-status="cursor"]');
    if (cursor) {
      cursor.replaceChildren(
        icon('arrow-up', 11),
        `Ln ${this.cursor.line}, Col ${this.cursor.column}${this.cursor.selected ? ` (${this.cursor.selected} selected)` : ''}`,
      );
    }
    const language = this.statusbar.querySelector<HTMLElement>('[data-status="language"]');
    if (language) {
      language.replaceChildren(
        icon(fileIcon(this.activePath ?? ''), 11),
        this.activePath ? languageForPath(this.activePath) : 'Plain Text',
      );
    }
    const vm = this.statusbar.querySelector<HTMLElement>('[data-status="vm"]');
    if (vm) {
      const state = this.lastLinuxStatus.state;
      vm.dataset.state = state;
      vm.classList.toggle('status-accent', state === 'ready');
      vm.replaceChildren(
        icon('cpu', 11),
        this.lastLinuxStatus.state === 'ready' ? 'Linux ready' : 'Linux off',
      );
    }
    const spaces = this.statusbar.querySelector<HTMLElement>('[data-status="spaces"]');
    if (spaces) spaces.textContent = `Spaces: ${this.settings.tabSize}`;
  }

  // ------------------------------------------------------------
  // Linux
  // ------------------------------------------------------------
  private handleLinuxStatus(status: LinuxStatus): void {
    this.lastLinuxStatus = status;
    this.vmPill.dataset.state = status.state;
    const label = this.vmPill.querySelector<HTMLElement>('.vm-pill-label');
    if (label) {
      label.textContent =
        status.state === 'ready'
          ? 'Linux ready'
          : status.state === 'loading'
            ? 'Booting…'
            : status.state === 'running'
              ? 'Linux busy'
              : status.state === 'error'
                ? 'Linux error'
                : 'Boot Linux';
    }
    this.vmPill.title = status.detail;
    this.vmDetail.dataset.vmDetail = `${status.state}: ${status.detail}`;
    if (this.sidebarView === 'linux') this.renderLinuxPanel();
    this.renderStatus();
    if (status.state === 'error') {
      this.log(`Linux error: ${status.detail}`);
      this.toastLinuxError(status.detail);
    }
  }

  private toastLinuxError(message: string): void {
    if (message.includes('No Linux image manifest')) {
      toast('Linux image not configured', message, 'warning', 7000);
    } else {
      toast('Linux error', message, 'error', 6000);
    }
  }

  async bootLinux(): Promise<void> {
    if (this.lastLinuxStatus.state === 'loading' || this.lastLinuxStatus.state === 'running') return;
    this.showTerminal();
    this.shell.writeLine('\x1b[38;2;100;116;139m[linux] starting container2wasm image…\x1b[0m');
    this.log('Booting Linux…');
    try {
      const result = await this.linux.boot((text) => this.shell.writeLine(text.trimEnd()));
      this.shell.writeLine(`\x1b[38;2;16;185;129m[linux] ready in ${result.durationMs} ms\x1b[0m`);
      this.log(`Linux ready in ${result.durationMs} ms.`);
      toast('Linux ready', 'The workspace is mounted at /workspace.', 'success', 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shell.writeLine(`\x1b[38;2;248;113;113m[linux] ${message}\x1b[0m`);
      this.log(`Linux boot failed: ${message}`);
    }
  }

  async runLinux(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
  ): Promise<{ exitCode: number; durationMs: number }> {
    this.log(`$ ${command}`);
    const network =
      this.settings.linuxNetwork &&
      /(https?:\/\/|\b(apk|pip3?|npm|yarn|pnpm)\b|\b(curl|wget)\b)/.test(command);
    const result = await this.linux.run(
      command,
      cwd,
      (text) => {
        onOutput(text);
        this.log(text.replace(/\r?\n$/, ''));
      },
      this.workspace,
      network,
    );
    await this.syncGuestFiles(result.files);
    this.log(`Linux exited ${result.exitCode} in ${result.durationMs} ms.`);
    return result;
  }

  linuxReady(): boolean {
    return this.linux.isReady();
  }

  async clearLinuxCache(): Promise<void> {
    await this.linux.clearCache();
    this.log('Cleared the Linux image cache.');
    toast('Cache cleared', 'The next boot downloads the image again.', 'info');
  }

  private async syncGuestFiles(files: Array<{ path: string; content: string }>): Promise<void> {
    const guest = new Map(files.map((file) => [file.path, file.content]));
    let changed = 0;
    const removed: string[] = [];
    for (const path of this.workspace.filePaths()) {
      if (guest.has(path)) continue;
      removed.push(path);
    }
    for (const path of removed) {
      await this.workspace.remove(path);
      if (this.openTabs.includes(path)) await this.closeFile(path, true);
      changed += 1;
    }
    for (const [path, content] of guest) {
      const current = this.workspace.readFile(path);
      if (current === content) continue;
      await this.workspace.writeFile(path, content);
      if (this.editor.hasModel(path)) {
        this.editor.setValue(path, content);
        this.editor.markSaved(path);
      }
      changed += 1;
    }
    // Command-mode sync carries files, not empty directories. Prune directories
    // that no longer contain a file so the explorer matches the guest.
    const remainingFiles = this.workspace.filePaths();
    for (const entry of this.workspace.list()) {
      if (entry.type !== 'dir' || !entry.path) continue;
      const hasChild = remainingFiles.some((path) => isPathInside(path, entry.path));
      if (hasChild) continue;
      await this.workspace.remove(entry.path);
      changed += 1;
    }
    if (changed > 0) {
      this.renderExplorer();
      this.renderTabs();
      this.log(`Synced ${changed} workspace file change(s) from Linux.`);
    }
  }

  // ------------------------------------------------------------
  // Command palette / quick open / settings
  // ------------------------------------------------------------
  private openCommands(): void {
    openPalette(this.commandItems(), {
      placeholder: 'Run a command…',
      emptyText: 'No matching commands.',
      footer: 'Flaxia Studio',
    });
  }

  private commandItems(): PaletteItem[] {
    const items: PaletteItem[] = [
      {
        id: 'file.new',
        label: 'File: New File',
        group: 'File',
        icon: 'file',
        hint: modShortcut('N'),
        run: () => void this.newFile(),
      },
      {
        id: 'file.folder',
        label: 'File: New Folder',
        group: 'File',
        icon: 'folder-plus',
        run: () => void this.newFolder(),
      },
      {
        id: 'file.quick-open',
        label: 'File: Quick Open',
        group: 'File',
        icon: 'search',
        hint: modShortcut('P'),
        run: () => this.openQuickOpen(),
      },
      {
        id: 'file.save',
        label: 'File: Save',
        group: 'File',
        icon: 'save',
        hint: modShortcut('S'),
        run: () => (this.activePath ? void this.saveFile(this.activePath) : undefined),
      },
      {
        id: 'file.save-all',
        label: 'File: Save All',
        group: 'File',
        icon: 'save',
        hint: modShortcut('Shift+S'),
        run: () => void this.saveAll(),
      },
      {
        id: 'file.rename',
        label: 'File: Rename…',
        group: 'File',
        icon: 'pencil',
        run: () => {
          const target = this.selectedPath ?? this.activePath;
          if (target) void this.renamePath(target);
        },
      },
      {
        id: 'file.delete',
        label: 'File: Delete…',
        group: 'File',
        icon: 'trash',
        run: () => {
          const target = this.selectedPath ?? this.activePath;
          if (target) void this.deletePath(target);
        },
      },
      {
        id: 'file.import',
        label: 'Workspace: Import ZIP',
        group: 'Workspace',
        icon: 'download',
        run: () => this.importInput.click(),
      },
      {
        id: 'file.export',
        label: 'Workspace: Export ZIP',
        group: 'Workspace',
        icon: 'upload',
        run: () => this.exportWorkspace(),
      },
      {
        id: 'workspace.rename',
        label: 'Workspace: Rename',
        group: 'Workspace',
        icon: 'pencil',
        run: () => void this.renameWorkspace(),
      },
      {
        id: 'view.theme',
        label: 'View: Cycle Theme',
        group: 'View',
        icon: 'sun',
        run: () => {
          const next = cycleTheme();
          this.settings.theme = next;
          this.saveSettings();
          toast('Theme', themeLabel(next), 'info', 1600);
        },
      },
      {
        id: 'view.sidebar',
        label: 'View: Toggle Sidebar',
        group: 'View',
        icon: 'panel-left',
        hint: modShortcut('B'),
        run: () => this.selectSidebar(this.sidebarView),
      },
      {
        id: 'view.panel',
        label: 'View: Toggle Panel',
        group: 'View',
        icon: 'panel-bottom',
        hint: modShortcut('J'),
        run: () => this.togglePanel(),
      },
      {
        id: 'view.terminal',
        label: 'View: Focus Terminal',
        group: 'View',
        icon: 'terminal',
        hint: modShortcut('`'),
        run: () => this.showTerminal(),
      },
      {
        id: 'view.settings',
        label: 'Preferences: Open Settings',
        group: 'Preferences',
        icon: 'settings',
        run: () => void this.openSettings(),
      },
      {
        id: 'linux.boot',
        label: 'Linux: Boot container2wasm Image',
        group: 'Linux',
        icon: 'container',
        run: () => void this.bootLinux(),
      },
      {
        id: 'linux.cache',
        label: 'Linux: Clear Image Cache',
        group: 'Linux',
        icon: 'trash',
        run: () => void this.clearLinuxCache(),
      },
      {
        id: 'linux.panel',
        label: 'Linux: Show Container Panel',
        group: 'Linux',
        icon: 'container',
        run: () => this.selectSidebar('linux'),
      },
    ];
    if (this.activePath) {
      items.push({
        id: 'file.close',
        label: 'File: Close Editor',
        group: 'File',
        icon: 'x',
        hint: modShortcut('W'),
        run: () => {
          const path = this.activePath;
          if (path) void this.closeFile(path);
        },
      });
    }
    return items;
  }

  private openQuickOpen(): void {
    const items: PaletteItem[] = this.workspace.filePaths().map((path) => ({
      id: `open:${path}`,
      label: path,
      group: dirname(path) || 'root',
      icon: fileIcon(path),
      run: () => this.openFile(path),
    }));
    openPalette(items, {
      placeholder: 'Go to file…',
      emptyText: 'No files in this workspace.',
      prefix: 'file',
      footer: `${items.length} files`,
    });
  }

  private async openSettings(): Promise<void> {
    const themeSelect = el('select', { class: 'select' }, [
      el('option', {
        text: 'System',
        attrs: { value: 'system', selected: this.settings.theme === 'system' },
      }),
      el('option', { text: 'Light', attrs: { value: 'light', selected: this.settings.theme === 'light' } }),
      el('option', { text: 'Dark', attrs: { value: 'dark', selected: this.settings.theme === 'dark' } }),
    ]);
    const fontSize = el('input', {
      class: 'input',
      type: 'number',
      attrs: { min: '10', max: '28', value: String(this.settings.fontSize) },
    });
    const tabSize = el(
      'select',
      { class: 'select' },
      [1, 2, 4, 8].map((size) =>
        el('option', {
          text: String(size),
          attrs: { value: String(size), selected: this.settings.tabSize === size },
        }),
      ),
    );
    const normalizeManifest = (value: string) => value.replace(/^\//, '');
    const manifestOptions = [
      { value: 'auto', label: 'Auto (production → lite → full)' },
      { value: 'linux/manifest-lite.json', label: 'Lite — Alpine Python (fast, ~145 MB)' },
      { value: 'linux/manifest-full.json', label: 'Full — Debian gcc (compile, ~420 MB)' },
      { value: 'linux/manifest.json', label: 'Production — built Flaxia image' },
      { value: 'custom', label: 'Custom URL' },
    ];
    const currentManifest = normalizeManifest(this.settings.linuxManifestUrl);
    const knownManifest = manifestOptions.some((option) => option.value === currentManifest);
    const manifestSelect = el(
      'select',
      { class: 'select' },
      manifestOptions.map((option) =>
        el('option', {
          text: option.label,
          attrs: {
            value: option.value,
            selected: option.value === (knownManifest ? currentManifest : 'custom'),
          },
        }),
      ),
    );
    const manifest = el('input', {
      class: 'input',
      type: 'text',
      attrs: {
        value: knownManifest ? '' : currentManifest,
        placeholder: 'https://…/manifest.json',
        spellcheck: 'false',
      },
    });
    manifest.disabled = manifestSelect.value !== 'custom';
    manifestSelect.addEventListener('change', () => {
      manifest.disabled = manifestSelect.value !== 'custom';
      if (!manifest.disabled) manifest.focus();
    });

    const switches = new Map<string, HTMLButtonElement>();
    const switchRow = (
      key: string,
      label: string,
      hint: string,
      checked: boolean,
      onChange?: (value: boolean) => void,
    ) => {
      const button = el('button', {
        class: 'switch',
        type: 'button',
        role: 'switch',
        attrs: { 'aria-checked': String(checked), 'aria-label': label },
        on: {
          click: () => {
            const next = button.getAttribute('aria-checked') !== 'true';
            button.setAttribute('aria-checked', String(next));
            onChange?.(next);
          },
        },
      });
      switches.set(key, button);
      return el('div', { class: 'checkbox-row' }, [
        el('div', { class: 'checkbox-label' }, [
          el('span', { text: label }),
          el('span', { class: 'checkbox-hint', text: hint }),
        ]),
        button,
      ]);
    };

    const body = el('div', {}, [
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Theme' }), themeSelect]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Editor font size' }),
        fontSize,
      ]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Tab size' }), tabSize]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Editor' }),
        el('div', {}, [
          switchRow(
            'autoSave',
            'Auto save',
            'Write changes to IndexedDB after 650ms',
            this.settings.autoSave,
          ),
          switchRow('wordWrap', 'Word wrap', 'Wrap long lines in the editor', this.settings.wordWrap),
          switchRow('minimap', 'Minimap', 'Show the Monaco minimap', this.settings.minimap),
          switchRow(
            'linuxNetwork',
            'Linux network',
            'Route guest HTTP(S) through the browser Fetch proxy (slow: restarts Linux with DHCP)',
            this.settings.linuxNetwork,
          ),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Linux image' }),
        manifestSelect,
        manifest,
        el('span', {
          class: 'field-hint',
          text: 'Auto prefers a production build, then the lightweight Alpine image, then the full Debian gcc image. Paths are relative to this app.',
        }),
      ]),
    ]);

    const result = await openDialog({
      title: 'Settings',
      body,
      width: 520,
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Save', value: 'save', primary: true },
      ],
    });
    if (result !== 'save') return;

    const next: Settings = {
      theme: themeSelect.value as Settings['theme'],
      fontSize: Math.max(10, Math.min(28, Number(fontSize.value) || 13)),
      tabSize: Math.max(1, Math.min(8, Number(tabSize.value) || 2)),
      wordWrap: switches.get('wordWrap')?.getAttribute('aria-checked') === 'true',
      autoSave: switches.get('autoSave')?.getAttribute('aria-checked') === 'true',
      minimap: switches.get('minimap')?.getAttribute('aria-checked') === 'true',
      linuxManifestUrl:
        manifestSelect.value === 'custom' ? manifest.value.trim() || 'auto' : manifestSelect.value,
      linuxNetwork: switches.get('linuxNetwork')?.getAttribute('aria-checked') === 'true',
    };
    this.settings = next;
    this.saveSettings();
    setTheme(next.theme);
    this.editor.setSettings({
      fontSize: next.fontSize,
      tabSize: next.tabSize,
      wordWrap: next.wordWrap,
      minimap: next.minimap,
    });
    this.linux.setManifestUrl(next.linuxManifestUrl);
    this.linux.setNetworkEnabled(next.linuxNetwork);
    this.lastLinuxStatus = this.linux.status();
    this.renderStatus();
    this.renderSidebar();
    this.log('Settings saved.');
    toast('Settings saved', 'Editor preferences applied.', 'success', 1800);
  }

  private saveSettings(): void {
    saveSettings(this.settings);
  }

  // ------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------
  private bindKeys(): void {
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing) return;
        if (isPaletteOpen() || document.querySelector('.overlay')) return;

        if (matchesShortcut(event, 'mod+k') || matchesShortcut(event, 'mod+shift+p')) {
          event.preventDefault();
          this.openCommands();
          return;
        }
        if (matchesShortcut(event, 'mod+p')) {
          event.preventDefault();
          this.openQuickOpen();
          return;
        }
        if (matchesShortcut(event, 'mod+s')) {
          event.preventDefault();
          if (event.shiftKey) void this.saveAll();
          else if (this.activePath) void this.saveFile(this.activePath);
          return;
        }
        if (matchesShortcut(event, 'mod+w')) {
          event.preventDefault();
          if (this.activePath) void this.closeFile(this.activePath);
          return;
        }
        if (matchesShortcut(event, 'mod+b')) {
          event.preventDefault();
          this.selectSidebar(this.sidebarView);
          return;
        }
        if (matchesShortcut(event, 'mod+j')) {
          event.preventDefault();
          this.togglePanel();
          return;
        }
        if (matchesShortcut(event, 'mod+`')) {
          event.preventDefault();
          this.showTerminal();
          return;
        }
        if (matchesShortcut(event, 'mod+n') && !event.shiftKey) {
          event.preventDefault();
          void this.newFile();
          return;
        }
        if (event.key === 'F1') {
          event.preventDefault();
          this.openCommands();
        }
      },
      true,
    );
    window.addEventListener('flaxia:theme', () => this.renderStatus());
  }
}

interface ShellHostish {
  workspace: Workspace;
}

function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();
  const sorted = [...entries].sort((a, b) => {
    if (a.path === '') return -1;
    if (b.path === '') return 1;
    return a.path.localeCompare(b.path, 'en', { numeric: true });
  });

  for (const entry of sorted) {
    if (!entry.path) continue;
    const node: TreeNode = {
      path: entry.path,
      name: basename(entry.path),
      type: entry.type,
      children: [],
    };
    nodes.set(entry.path, node);
    const parentPath = dirname(entry.path);
    const parent = parentPath ? nodes.get(parentPath) : null;
    if (parent && parent.type === 'dir') parent.children.push(node);
    else root.push(node);
  }

  const sortNodes = (list: TreeNode[]) => {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'en', { numeric: true });
    });
    for (const node of list) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

export function startApp(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app root element.');
  const boot = el('div', { class: 'sidebar-empty', text: 'Opening workspace…' });
  root.appendChild(boot);
  void App.create()
    .then((app) => {
      root.replaceChildren();
      app.mount(root);
      window.addEventListener('beforeunload', (event) => {
        const anyDirty = false;
        if (anyDirty) event.preventDefault();
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      root.replaceChildren(
        el('div', { class: 'sidebar-empty', text: `Flaxia Studio could not open the workspace: ${message}` }),
      );
      toast('Workspace failed to open', message, 'error', 10000);
    });
}
