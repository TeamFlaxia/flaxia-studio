import { EditorManager, installMonacoShadowStyles } from './editor/monaco';
import { base64ToBytes } from './fs/base64';
import { listWorkspaces } from './fs/indexeddb';
import {
  basename,
  dirname,
  isPathInside,
  joinPath,
  languageForPath,
  normalizePath,
  uniquePath,
} from './fs/path';
import { createWorkspaceChannel } from './fs/sync-channel';
import { ConflictError, Workspace, type WorkspaceEntry } from './fs/workspace';
import { tryDecodeText, type ZipFile } from './fs/zip';
import { buildArcadeZip } from './game/export';
import { t } from './i18n/index.ts';
import { copyText } from './lib/clipboard';
import { el, formatBytes, iconButton } from './lib/dom';
import { type Command, HistoryService } from './lib/history';
import { fileIcon, type IconName, icon } from './lib/icons';
import { randomId } from './lib/id';
import {
  applyLayoutSizes,
  clampInspectorWidth,
  clampSidebarWidth,
  type LayoutSizes,
  loadLayoutSizes,
  saveLayoutSizes,
} from './lib/layout';
import {
  DEFAULT_IMAGE_DURATION_MS,
  isMediaPath,
  mediaKind,
  mimeForMedia,
  probeMedia,
  trackKindFor,
} from './lib/media';
import type { NoteClip } from './lib/music';
import { bindDragHandle, bindSeparatorKeys } from './lib/resize';
import { loadSettings, type Settings, saveSettings } from './lib/settings';
import { matchesShortcut, modShortcut } from './lib/shortcut';
import { cycleTheme, getTheme, initTheme, setTheme, themeLabel } from './lib/theme';
import {
  addClip,
  addTrack,
  clipEnd,
  DEFAULT_TEMPO,
  type MediaAsset,
  MIN_CLIP_MS,
  setAdjustments,
  setTempo,
  type TimelineDoc,
  trackEnd,
} from './lib/timeline';
import {
  buildFrameZip,
  frameFileName,
  frameIndexAt,
  frameSequence,
  manifestForFrames,
} from './lib/video-export';
import { LinuxRuntime, type LinuxStatus } from './linux/runtime';
import { PlayHost, type PlayStatus, PlayStopped } from './play/host';
import {
  type CompatibilityIssue,
  checkArcadeCompatibility,
  isPlayPayloadPath,
  type PlayFile,
  type PlayPayload,
  validatePlayFiles,
} from './play/policy';
import type { PlayConsoleEntry } from './play/protocol';
import { StudioShell } from './terminal/shell';
import { showContextMenu } from './ui/context-menu';
import { confirmDialog, openDialog, promptDialog } from './ui/dialog';
import { InspectorView } from './ui/inspector';
import { MediaView } from './ui/media-view';
import { MusicPanel } from './ui/music-panel';
import { isPaletteOpen, openPalette, type PaletteItem } from './ui/palette';
import { PreviewView } from './ui/preview-view';
import { TimelineStore } from './ui/timeline-store';
import { TimelineView } from './ui/timeline-view';
import { toast } from './ui/toast';

type SidebarView = 'explorer' | 'search' | 'linux';
type PanelView = 'terminal' | 'output' | 'problems' | 'timeline';

interface SearchResult {
  path: string;
  line: number;
  text: string;
}

interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

interface TextHistoryCommand extends Command {
  steps: number;
}

interface TreeNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  binary?: boolean;
  children: TreeNode[];
}

const MAX_OUTPUT_LINES = 600;
const MAX_PROBLEMS_LINES = 300;

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
  private sidebarResizer!: HTMLElement;
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
  private timelineView!: HTMLElement;
  private statusbar!: HTMLElement;
  private editorMain!: HTMLElement;
  private editorColumn!: HTMLElement;
  private mediaPane!: HTMLElement;
  private inspectorResizer!: HTMLElement;
  private inspectorButton!: HTMLButtonElement;
  private previewPane!: HTMLElement;
  private musicPane!: HTMLElement;
  private musicPanel: MusicPanel;
  private musicSaveTimer: number | undefined;
  private musicVersion = 0;
  private mediaView: MediaView;
  private inspector: InspectorView;
  private timelineStore: TimelineStore;
  private timeline: TimelineView;
  private previewView: PreviewView;
  private playPane!: HTMLElement;
  private playHead!: HTMLElement;
  private playStatus!: HTMLElement;
  private playBody!: HTMLElement;
  private playEmpty!: HTMLElement;
  private runPill!: HTMLButtonElement;
  private vmPill!: HTMLButtonElement;
  private vmDetail!: HTMLElement;
  private commandTrigger!: HTMLButtonElement;
  private themeButton!: HTMLButtonElement;
  private importInput!: HTMLInputElement;
  private mediaInput!: HTMLInputElement;
  private dropOverlay!: HTMLElement;
  private editor: EditorManager;
  private shell: StudioShell;
  private playHost: PlayHost;
  private linux = new LinuxRuntime();
  private readonly openTabs: string[] = [];
  private activePath: string | null = null;
  private selectedPath: string | null = null;
  private collapsedDirs = new Set<string>();
  private sidebarView: SidebarView = 'explorer';
  private panelView: PanelView = 'timeline';
  private panelVisible = true;
  private inspectorVisible = true;
  private sidebarVisible = !window.matchMedia?.('(max-width: 720px)').matches;
  private searchQuery = '';
  private searchResults: SearchResult[] = [];
  private cursor = { line: 1, column: 1, selected: 0 };
  private outputLines: Array<{ time: string; message: string }> = [];
  private saveTimers = new Map<string, number>();
  private readonly fileVersions = new Map<string, number>();
  private workspaceChannel: ReturnType<typeof createWorkspaceChannel> | null = null;
  private readonly tabId = randomId();
  private staleWorkspaceNotified = false;
  private readonly history = new HistoryService();
  private compatibilityDiagnostics: Diagnostic[] = [];
  private consoleDiagnostics: Diagnostic[] = [];
  private warnedApkCors = false;
  private lastLinuxStatus: LinuxStatus;
  private linuxUnsubscribe: (() => void) | null = null;
  private activeView: 'editor' | 'play' | 'media' | 'preview' | 'music' = 'editor';
  private timelinePlayheadMs = 0;
  private playHasRun = false;
  private playStatusState: PlayStatus = 'idle';
  private playReloadTimer: number | undefined;
  private layoutSizes: LayoutSizes = loadLayoutSizes();

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    this.workspace.setChangeNotifier((rev) => {
      this.workspaceChannel?.postChange(this.workspace.id, rev);
      this.staleWorkspaceNotified = false;
    });
    this.settings = loadSettings();
    this.panelView = this.settings.defaultBottomTab;
    this.lastLinuxStatus = this.linux.status();
    this.editorHost = el('div', { class: 'editor-host', attrs: { 'aria-label': 'Editor' } });
    this.editor = new EditorManager(this.editorHost);
    this.shell = new StudioShell(this);
    this.playHost = new PlayHost(
      (status, detail) => this.handlePlayStatus(status, detail),
      this.workspace.id,
      (entry) => this.handlePlayConsole(entry),
    );
    this.timelineStore = new TimelineStore(
      this.workspace,
      () => this.handleTimelineChange(),
      (previous, next, label) => this.recordTimelineChange(previous, next, label),
    );
    this.mediaView = new MediaView({
      onAddToTimeline: (path) => void this.addMediaToTimeline(path),
    });
    this.previewView = new PreviewView({
      workspace: this.workspace,
      onSeek: (ms) => {
        this.timelinePlayheadMs = ms;
        this.timeline.seekTo(ms);
      },
      onPlay: () => this.timeline.pausePlayback(),
    });
    this.timeline = new TimelineView({
      store: this.timelineStore,
      workspace: this.workspace,
      onPlayheadChange: (ms) => {
        this.timelinePlayheadMs = ms;
        this.previewView.setPlayhead(ms);
      },
      onOpenSource: (path) => this.openFile(path),
      onSelectedClipChange: (path) => {
        if (!path) {
          this.inspector.clear();
          return;
        }
        const doc = this.timelineStore.current;
        this.inspector.showSource({
          path,
          kind: mediaKind(path) ?? undefined,
          adjustments: doc?.adjustments[path],
        });
      },
      onPlaybackChange: (playing) => {
        if (playing) this.previewView.pause();
      },
      onAddFile: (startMs, trackId) => this.pickTimelineFile(startMs, trackId),
      onDropFile: (path, startMs, trackId) => void this.dropFileOnTimeline(path, startMs, trackId),
      onDropFiles: (files, startMs, trackId) => void this.addDroppedFilesToTimeline(files, startMs, trackId),
    });
    this.musicPanel = new MusicPanel({
      onTempoChange: (tempo) => {
        this.timelineStore.updateWith((doc) => setTempo(doc, tempo), 'Change tempo');
      },
      onClipChange: (clip) => this.scheduleMusicSave(clip),
    });
    this.inspector = new InspectorView({
      onAdjustmentsChange: (path, adjustments) => {
        this.timelineStore.updateWith((doc) => setAdjustments(doc, path, adjustments));
        if (this.mediaView.currentSourcePath === path) this.mediaView.setAdjustments(adjustments);
        this.previewView.refresh();
      },
    });
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
    applyLayoutSizes(this.layoutSizes);
    this.inspectorVisible =
      this.layoutSizes.inspectorVisible ?? !window.matchMedia?.('(max-width: 900px)').matches;
    this.root = root;
    this.buildShell();
    installMonacoShadowStyles();
    this.editor.init({
      onChange: (path, origin) => this.handleEditorChange(path, origin),
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
    this.playHost.mount(this.playBody);
    void this.timeline.init().then(() => {
      this.previewView.setDoc(this.timelineStore.current);
      this.musicPanel.setTempo(this.timelineStore.current?.tempo ?? DEFAULT_TEMPO);
    });
    void this.loadMusicDocument();
    this.shell.mount();
    this.shell.setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    this.linuxUnsubscribe = this.linux.subscribe((status) => this.handleLinuxStatus(status));
    this.workspaceChannel = createWorkspaceChannel((message) => {
      // BroadcastChannel never delivers to the posting object, and the sender
      // id filters out foreign channels. A rev comparison would miss changes
      // from tabs that started with the same local revision.
      if (message.workspaceId !== this.workspace.id) return;
      if (this.staleWorkspaceNotified) return;
      this.staleWorkspaceNotified = true;
      this.log(t('workspace.otherTabChanged'));
      void openDialog({
        title: t('workspace.conflictTitle'),
        body: t('workspace.otherTabChanged'),
        width: 420,
        centered: true,
        actions: [
          { label: t('common.cancel'), value: 'cancel' },
          { label: 'Reload', value: 'reload', primary: true },
        ],
      }).then((value) => {
        if (value === 'reload') window.location.reload();
      });
    }, this.tabId);
    this.bindKeys();
    window.addEventListener('flaxia:theme', () => {
      const resolved = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      this.editor.setTheme(resolved);
      this.shell.setTheme(resolved);
      this.renderTopbarTheme(this.themeButton);
    });
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('beforeunload', (event) => {
      if (this.openTabs.some((path) => this.editor.isDirty(path))) event.preventDefault();
    });
    window.addEventListener('pagehide', () => {
      void this.flushSaves({ suppressDialogs: true });
      if (this.musicSaveTimer !== undefined) {
        window.clearTimeout(this.musicSaveTimer);
        this.musicSaveTimer = undefined;
        void this.workspace
          .writeFile(
            App.MUSIC_PATH,
            JSON.stringify(this.musicPanel.getClip()),
            this.musicVersion || undefined,
          )
          .catch(() => undefined);
      }
      this.workspaceChannel?.close();
      this.workspace.setChangeNotifier(null);
      this.timeline.dispose();
      this.previewView.dispose();
      void this.timelineStore.flush();
      if (this.playReloadTimer !== undefined) window.clearTimeout(this.playReloadTimer);
      this.playHost.dispose();
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
    this.sidebarResizer = el('div', {
      class: 'sidebar-resizer',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': 'Resize explorer',
        tabindex: '0',
      },
    });

    this.tabsBar = el('div', { class: 'tabs', role: 'tablist', attrs: { 'aria-label': 'Open editors' } });
    this.breadcrumbs = el('div', { class: 'breadcrumbs' });
    this.welcome = el('div', { class: 'welcome' });
    this.editorColumn = el('div', { class: 'editor-column' }, [this.editorHost, this.welcome]);
    this.playPane = el('div', { class: 'play-pane hidden', attrs: { 'aria-label': 'Test Play preview' } });
    this.playHead = el('div', { class: 'play-head' });
    this.playStatus = el('span', { class: 'play-status', dataset: { state: 'idle' }, text: 'Idle' });
    this.playBody = el('div', { class: 'play-body' });
    this.playEmpty = el('div', { class: 'play-empty' }, [
      el('span', { class: 'play-empty-icon' }, [icon('play', 18)]),
      el('span', { class: 'play-empty-title', text: 'No preview yet' }),
      el('span', {
        class: 'play-empty-hint',
        text: 'Run Test Play to preview the workspace in a sandboxed frame.',
      }),
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: () => this.runTestPlay() },
        },
        [icon('play', 14), 'Run Test Play'],
      ),
    ]);
    this.playBody.appendChild(this.playEmpty);
    this.playPane.append(this.playHead, this.playBody);
    this.mediaPane = el('div', { class: 'media-pane hidden' }, [this.mediaView.host]);
    this.previewPane = el('div', { class: 'preview-pane hidden' }, [this.previewView.host]);
    this.musicPane = el('div', { class: 'music-pane hidden' }, [this.musicPanel.host]);
    this.editorMain = el('div', { class: 'editor-main' }, [
      this.editorColumn,
      this.mediaPane,
      this.playPane,
      this.previewPane,
      this.musicPane,
    ]);
    this.editorArea = el('main', { class: 'editor-area' }, [this.tabsBar, this.breadcrumbs, this.editorMain]);

    this.inspectorResizer = el('div', {
      class: 'inspector-resizer',
      attrs: {
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': 'Resize inspector',
        tabindex: '0',
      },
    });

    const body = el('div', { class: 'studio-body' }, [
      this.rail,
      this.sidebar,
      this.sidebarResizer,
      this.editorArea,
      this.inspectorResizer,
      this.inspector.host,
    ]);

    this.panel = el('section', { class: 'panel', attrs: { 'aria-label': 'Panel' } });
    this.panelHead = el('div', { class: 'panel-head' });
    this.panelBody = el('div', { class: 'panel-body' });
    this.terminalView = el('div', { class: 'panel-view', dataset: { view: 'terminal' } }, [this.shell.host]);
    this.outputView = el('div', { class: 'panel-view output-view', dataset: { view: 'output' } });
    this.problemsView = el('div', { class: 'panel-view problems-view', dataset: { view: 'problems' } }, [
      el('div', { class: 'terminal-note' }, [
        icon('check', 15),
        'No problems have been detected in the workspace.',
      ]),
    ]);
    this.timelineView = el('div', { class: 'panel-view timeline-view', dataset: { view: 'timeline' } }, [
      this.timeline.host,
    ]);
    this.panelBody.append(this.terminalView, this.outputView, this.problemsView, this.timelineView);
    this.applyPanelView();
    const resizer = el('div', { class: 'panel-resizer', attrs: { 'aria-hidden': 'true' } });
    this.panel.append(resizer, this.panelHead, this.panelBody);

    this.statusbar = el('footer', { class: 'statusbar', attrs: { 'aria-label': 'Status bar' } });
    this.importInput = el('input', {
      type: 'file',
      dataset: { import: 'zip' },
      attrs: { accept: '.zip,application/zip', hidden: 'true' },
    });
    this.importInput.addEventListener('change', () => void this.handleImportFile());
    this.mediaInput = el('input', {
      type: 'file',
      dataset: { import: 'media' },
      attrs: {
        accept: 'image/*,audio/*,video/*,font/*,.woff,.woff2,.ttf,.otf',
        multiple: 'true',
        hidden: 'true',
      },
    });
    this.mediaInput.addEventListener('change', () => void this.handleMediaImport());
    this.dropOverlay = el('div', { class: 'drop-overlay hidden', attrs: { 'aria-hidden': 'true' } }, [
      el('div', { class: 'drop-target' }, [
        el('span', { class: 'drop-icon' }, [icon('download', 22)]),
        el('span', { class: 'drop-title', text: 'Drop to import' }),
        el('span', {
          class: 'drop-hint',
          text: 'Media, images, audio, ZIP archives and text files land in the workspace root.',
        }),
      ]),
    ]);

    this.root.append(
      this.topbar,
      body,
      this.panel,
      this.statusbar,
      this.importInput,
      this.mediaInput,
      this.dropOverlay,
    );
    this.buildTopbar();
    this.buildRail();
    this.buildPlayHead();
    this.renderSidebarHeader();
    this.buildPanelHead();
    this.buildStatusbar();
    this.bindResizer(resizer);
    this.bindSidebarResizer();
    this.bindInspectorResizer();
    this.bindDropZone();
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
        title: t('workspace.switch'),
        on: { click: () => void this.openWorkspaceSwitcher() },
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

    this.runPill = el(
      'button',
      {
        class: 'run-pill',
        type: 'button',
        dataset: { state: 'idle' },
        title: `Test Play (${modShortcut('Shift+Enter')})`,
        on: { click: () => this.runTestPlay() },
      },
      [icon('play', 13), el('span', { class: 'run-pill-label', text: 'Test Play' })],
    ) as HTMLButtonElement;

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
    this.inspectorButton = iconButton('panel-right', 'Toggle inspector', () => this.toggleInspector(), {
      pressed: this.inspectorVisible,
    });
    const actions = el('div', { class: 'topbar-actions' }, [
      this.runPill,
      this.vmPill,
      this.inspectorButton,
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

  private buildPlayHead(): void {
    this.playHead.replaceChildren(
      el('div', { class: 'play-title' }, [icon('play', 13), el('span', { text: 'Test Play' })]),
      this.playStatus,
      el('div', { class: 'play-head-spacer' }),
      el('div', { class: 'play-actions' }, [
        iconButton('rotate-cw', 'Reload preview', () => this.runTestPlay(), { size: 14 }),
        iconButton('stop', 'Stop preview', () => this.stopTestPlay(), { size: 14 }),
        iconButton('x', 'Back to editor', () => this.setActiveView('editor'), { size: 14 }),
      ]),
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
    this.applyPanelView();
    this.renderOutput();
    this.renderStatus();
    this.sidebar.classList.toggle('hidden', !this.sidebarVisible);
    this.sidebarResizer.classList.toggle('hidden', !this.sidebarVisible);
    this.inspector.host.classList.toggle('hidden', !this.inspectorVisible);
    this.inspectorResizer.classList.toggle('hidden', !this.inspectorVisible);
    if (this.inspectorButton) {
      this.inspectorButton.setAttribute('aria-pressed', String(this.inspectorVisible));
    }
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
        iconButton('file-image', 'Import media', () => this.mediaInput.click(), { size: 15 }),
        iconButton('upload', 'Export ZIP', () => void this.exportWorkspace(), { size: 15 }),
        iconButton('package', 'Export for Arcade', () => void this.exportForArcade(), { size: 15 }),
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
              draggable: node.type === 'file' && isMediaPath(node.path) ? 'true' : undefined,
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
              dragstart: (event) => {
                if (node.type !== 'file' || !isMediaPath(node.path)) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer?.setData('application/x-flaxia-file', node.path);
                event.dataTransfer?.setData('text/plain', node.path);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
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
    if (node.type === 'file') {
      items.push({
        label: 'Download',
        icon: 'download' as IconName,
        run: () => void this.downloadFile(node.path),
      });
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
          void copyText(node.path).then((copied) => {
            if (copied) toast('Copied path', node.path, 'info', 1600);
            else toast('Copy failed', 'Clipboard access needs a secure context.', 'warning');
          });
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
      const active = this.activeView === 'editor' && path === this.activePath;
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
                {
                  label: 'Copy Path',
                  icon: 'copy',
                  run: () => {
                    void copyText(path).then((copied) => {
                      if (!copied)
                        toast('Copy failed', 'Clipboard access needs a secure context.', 'warning');
                    });
                  },
                },
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
    this.tabsBar.appendChild(this.buildMusicTab());
    this.tabsBar.appendChild(this.buildPreviewTab());
    this.tabsBar.appendChild(this.buildPlayTab());
    this.tabsBar.appendChild(el('div', { class: 'tab-spacer' }));
    this.tabsBar.appendChild(
      iconButton('plus', 'New file', () => void this.newFile(), { size: 14, className: 'tab-new' }),
    );
  }

  /** The timeline preview lives in the tab bar next to the file tabs. */
  private buildPreviewTab(): HTMLElement {
    const active = this.activeView === 'preview';
    return el(
      'div',
      {
        class: `tab tab-preview ${active ? 'is-active' : ''}`.trim(),
        role: 'tab',
        attrs: {
          'aria-selected': String(active),
          tabindex: active ? '0' : '-1',
          title: 'Timeline preview (video)',
        },
        on: {
          click: () => this.setActiveView('preview'),
          keydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') this.setActiveView('preview');
          },
        },
      },
      [
        el('span', { class: 'tab-icon' }, [icon('monitor', 14)]),
        el('span', { class: 'tab-label', text: 'Preview' }),
      ],
    );
  }

  private buildMusicTab(): HTMLElement {
    const active = this.activeView === 'music';
    return el(
      'div',
      {
        class: `tab tab-music ${active ? 'is-active' : ''}`.trim(),
        role: 'tab',
        attrs: { 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: 'Music editor' },
        on: {
          click: () => this.setActiveView('music'),
          keydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') this.setActiveView('music');
          },
        },
      },
      [
        el('span', { class: 'tab-icon' }, [icon('file-audio', 14)]),
        el('span', { class: 'tab-label', text: 'Music' }),
      ],
    );
  }

  /** The Test Play preview lives in the tab bar next to the file tabs. */
  private buildPlayTab(): HTMLElement {
    const active = this.activeView === 'play';
    const tab = el(
      'div',
      {
        class: `tab tab-play ${active ? 'is-active' : ''}`.trim(),
        role: 'tab',
        attrs: {
          'aria-selected': String(active),
          tabindex: active ? '0' : '-1',
          title: 'Test Play preview (web project)',
        },
        on: {
          click: () => this.setActiveView('play'),
          keydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') this.setActiveView('play');
          },
        },
      },
      [
        el('span', { class: 'tab-icon' }, [icon('play', 14)]),
        el('span', { class: 'tab-label', text: 'Test Play' }),
        el('span', { class: 'play-dot', dataset: { state: this.playStatusState } }),
      ],
    );
    return tab;
  }

  /**
   * The editor area shows one view at a time: the text editor, a media
   * preview, the Test Play preview, or the timeline preview monitor.
   */
  private setActiveView(view: 'editor' | 'play' | 'media' | 'preview' | 'music'): void {
    const changed = this.activeView !== view;
    this.activeView = view;
    this.previewView.setActive(view === 'preview');
    this.editorColumn.classList.toggle('hidden', view !== 'editor');
    this.mediaPane.classList.toggle('hidden', view !== 'media');
    this.playPane.classList.toggle('hidden', view !== 'play');
    this.previewPane.classList.toggle('hidden', view !== 'preview');
    this.musicPane.classList.toggle('hidden', view !== 'music');
    this.playEmpty.classList.toggle('hidden', this.playHasRun);
    if (view === 'preview') {
      this.previewView.setDoc(this.timelineStore.current);
      this.previewView.setPlayhead(this.timelinePlayheadMs);
    }
    this.renderTabs();
    this.renderBreadcrumbs();
    if (changed) this.layout();
  }

  private renderBreadcrumbs(): void {
    this.breadcrumbs.replaceChildren();
    if (this.activeView === 'play') {
      this.breadcrumbs.appendChild(el('span', { text: 'Test Play' }));
      return;
    }
    if (this.activeView === 'preview') {
      this.breadcrumbs.appendChild(el('span', { text: 'Preview' }));
      return;
    }
    if (this.activeView === 'music') {
      this.breadcrumbs.appendChild(el('span', { text: 'Music' }));
      return;
    }
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
        icon: 'play',
        title: 'Test Play',
        desc: `Run index.html in a sandboxed preview · ${modShortcut('Shift+Enter')}`,
        run: () => this.runTestPlay(),
      },
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
        text: 'A Monaco editor with sandboxed Test Play previews and a real Linux workspace in WebAssembly. Quiet surfaces, emerald accents, and a command palette that stays out of your way.',
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
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('Shift+Enter') }), 'Test Play']),
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('S') }), 'Save']),
        el('span', {}, [el('kbd', { class: 'kbd', text: modShortcut('`') }), 'Terminal']),
        el('span', { text: 'Workspace: IndexedDB · Preview: sandboxed · Linux: container2wasm' }),
      ]),
    ]);
    this.welcome.replaceChildren(inner);
  }

  private showWelcome(): void {
    this.activePath = null;
    this.editor.show(false);
    this.welcome.classList.remove('hidden');
    this.setActiveView('editor');
    this.renderWelcome();
    this.renderStatus();
  }

  openFile(path: string, line?: number, column = 1): void {
    if (this.workspace.isBinary(path)) {
      if (isMediaPath(path)) void this.openMediaFile(path);
      else void this.openBinaryFile(path);
      return;
    }
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
    this.fileVersions.set(path, this.workspace.versionOf(path));
    if (line) window.setTimeout(() => this.editor.revealLine(path, line, column), 30);
    if (window.matchMedia?.('(max-width: 720px)').matches) this.sidebarVisible = false;
    this.setActiveView('editor');
    this.renderExplorer();
    this.renderSidebar();
    this.renderStatus();
  }

  /** Opens an image/video/audio file in the media preview pane. */
  private async openMediaFile(path: string): Promise<void> {
    const blob = await this.workspace.readBlob(path);
    if (!blob) {
      toast('Cannot open media', `${path} has no payload.`, 'warning');
      return;
    }
    if (!this.openTabs.includes(path)) this.openTabs.push(path);
    this.activePath = path;
    this.selectedPath = path;
    this.welcome.classList.add('hidden');
    const doc = await this.timelineStore.load();
    const kind = mediaKind(path);
    await this.mediaView.show({
      path,
      blob,
      size: this.workspace.sizeOf(path),
      adjustments: doc.adjustments[path],
    });
    if (kind) {
      this.inspector.showSource({
        path,
        kind,
        size: this.workspace.sizeOf(path),
        mime: blob.type || mimeForMedia(path),
        width: doc.assets[path]?.width,
        height: doc.assets[path]?.height,
        durationMs: doc.assets[path]?.durationMs,
        adjustments: doc.adjustments[path],
      });
    }
    this.setActiveView('media');
    this.renderExplorer();
    this.renderSidebar();
    this.renderStatus();
    await this.ensureTimelineAsset(path, blob);
    const asset = this.timelineStore.current?.assets[path];
    this.inspector.updateDetails({
      size: this.workspace.sizeOf(path),
      mime: blob.type || mimeForMedia(path),
      width: asset?.width,
      height: asset?.height,
      durationMs: asset?.durationMs,
    });
  }

  /** Probes a media file once so the timeline can place it. */
  private async ensureTimelineAsset(path: string, blob: Blob, force = false): Promise<void> {
    const kind = mediaKind(path);
    if (!kind) return;
    if (!force && this.timelineStore.current?.assets[path]) return;
    const probe = await probeMedia(blob, kind);
    const durationMs =
      kind === 'image'
        ? DEFAULT_IMAGE_DURATION_MS
        : probe.durationMs >= MIN_CLIP_MS
          ? probe.durationMs
          : probe.durationMs;
    const asset: MediaAsset = {
      path,
      kind,
      durationMs,
      width: probe.width || undefined,
      height: probe.height || undefined,
      mime: blob.type || mimeForMedia(path),
    };
    this.timelineStore.registerAsset(asset);
  }

  /** Adds the previewed media to its track at the playhead. */
  private async addMediaToTimeline(path: string): Promise<void> {
    await this.timelineStore.load();
    let doc = this.timelineStore.current;
    if (!doc) return;
    const asset = doc.assets[path];
    if (!asset || asset.durationMs < MIN_CLIP_MS) {
      toast('Cannot add to timeline', 'The media duration is unknown.', 'warning');
      return;
    }
    const kind = trackKindFor(asset.kind);
    let track = doc.tracks.find((entry) => entry.kind === kind);
    if (!track) {
      doc = addTrack(doc, kind);
      track = doc.tracks[doc.tracks.length - 1];
    }
    if (!track) return;
    const startAt = Math.max(trackEnd(track), this.timelinePlayheadMs);
    doc = addClip(doc, track.id, path, startAt);
    this.timelineStore.update(doc);
    this.showTimeline();
    toast('Added to timeline', basename(path), 'success', 1400);
  }

  /** Opens a media picker for the timeline's "Add File…" command. */
  private pickTimelineFile(startMs: number, trackId: string | null): void {
    const paths = this.workspace.filePaths().filter((path) => isMediaPath(path));
    if (paths.length === 0) {
      toast('No media files', 'Import an image, video or audio file first.', 'warning');
      return;
    }
    const items = paths.map((path) => ({
      id: `timeline:${path}`,
      label: path,
      group: dirname(path) || 'root',
      icon: fileIcon(path),
      run: () => {
        void this.addFileToTimeline(path, startMs, trackId).then((end) => {
          if (end === null) return;
          this.showTimeline();
          toast('Added to timeline', basename(path), 'success', 1400);
        });
      },
    }));
    openPalette(items, {
      placeholder: 'Add media to timeline…',
      emptyText: 'No media files in this workspace.',
      prefix: 'file-video',
      footer: `${items.length} media file${items.length === 1 ? '' : 's'}`,
    });
  }

  /** A workspace file dropped from the explorer. */
  private async dropFileOnTimeline(path: string, startMs: number, trackId: string | null): Promise<void> {
    const end = await this.addFileToTimeline(path, startMs, trackId);
    if (end === null) return;
    this.showTimeline();
    toast('Added to timeline', basename(path), 'success', 1400);
  }

  /**
   * Places a media file on the timeline, probing and registering the asset
   * first when the file has never been opened.
   */
  private async addFileToTimeline(
    path: string,
    startMs: number,
    trackId: string | null,
  ): Promise<number | null> {
    const kind = mediaKind(path);
    if (!kind) {
      toast('Cannot add to timeline', `${basename(path)} is not an image, video or audio file.`, 'warning');
      return null;
    }
    await this.timelineStore.load();
    const blob = await this.workspace.readBlob(path);
    if (!blob) {
      toast('Cannot add to timeline', `${path} has no payload.`, 'warning');
      return null;
    }
    const existing = this.timelineStore.current?.assets[path];
    await this.ensureTimelineAsset(path, blob, !existing || existing.durationMs < MIN_CLIP_MS);

    let doc = this.timelineStore.current;
    if (!doc) return null;
    const asset = doc.assets[path];
    if (!asset || asset.durationMs < MIN_CLIP_MS) {
      toast('Cannot add to timeline', 'The media duration is unknown.', 'warning');
      return null;
    }
    const trackKind = trackKindFor(asset.kind);
    let track = trackId
      ? doc.tracks.find((entry) => entry.id === trackId && entry.kind === trackKind)
      : undefined;
    if (!track) track = doc.tracks.find((entry) => entry.kind === trackKind);
    if (!track) {
      doc = addTrack(doc, trackKind);
      track = doc.tracks[doc.tracks.length - 1];
    }
    if (!track) return null;

    const start = Math.max(0, Math.round(startMs));
    doc = addClip(doc, track.id, path, start);
    this.timelineStore.update(doc);
    const added = doc.tracks
      .flatMap((entry) => entry.clips)
      .find((clip) => clip.path === path && clip.startMs === start);
    return added ? clipEnd(added) : start + asset.durationMs;
  }

  /** Media files dropped from the operating system onto the timeline. */
  private async addDroppedFilesToTimeline(
    files: File[],
    startMs: number,
    trackId: string | null,
  ): Promise<void> {
    const existing = new Set(this.workspace.filePaths());
    let cursor = startMs;
    let added = 0;
    for (const file of files) {
      const name = normalizePath(file.name || 'media') || 'media';
      if (!isMediaPath(name)) {
        toast('Skipped', `${file.name} is not media.`, 'warning');
        continue;
      }
      const path = uniquePath(existing, name);
      existing.add(path);
      try {
        await this.workspace.writeBinaryFile(path, file, file.type || mimeForMedia(path));
        const end = await this.addFileToTimeline(path, cursor, trackId);
        if (end !== null) {
          cursor = end;
          added += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast('Drop failed', `${file.name}: ${message}`, 'error');
      }
    }
    this.renderExplorer();
    if (added > 0) {
      this.showTimeline();
      this.log(`Added ${added} dropped file(s) to the timeline.`);
      toast('Added to timeline', `${added} file(s)`, 'success', 1600);
    }
  }

  private async openBinaryFile(path: string): Promise<void> {
    const entry = this.workspace.get(path);
    if (entry?.type !== 'file') return;
    const size = this.workspace.sizeOf(path);
    const result = await openDialog({
      title: path,
      body: `Binary file — ${formatBytes(size)}\n\nCompiled artifacts and other binaries are stored in IndexedDB and included in Export ZIP. They are not opened in Monaco.`,
      width: 460,
      centered: true,
      actions: [
        { label: 'Close', value: '' },
        { label: 'Download', value: 'download', primary: true },
      ],
    });
    if (result === 'download') void this.downloadFile(path);
  }

  async downloadFile(path: string): Promise<void> {
    const blob = await this.workspace.readBlob(path);
    if (!blob) {
      toast('Download failed', `${path} is not a binary file.`, 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = basename(path);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async closeFile(path: string, discard = false): Promise<void> {
    if (!discard && this.editor.isDirty(path)) await this.saveFile(path);
    if (this.mediaView.currentSourcePath === path) this.mediaView.clear();
    this.editor.close(path);
    // The model's Monaco undo stack is disposed with it; drop its tokens so a
    // later Ctrl+Z cannot consume a step that can no longer be replayed.
    this.history.removeByKey(`text:${path}`);
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

  private handleEditorChange(path: string, origin: 'user' | 'history' = 'user'): void {
    this.renderTabs();
    if (origin === 'user') {
      // One Monaco undo stop per change; the app history groups consecutive
      // changes into a single undo step via `mergeKey`.
      this.editor.pushUndoStop(path);
      void this.history.push(this.createTextCommand(path, 1));
    }
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

  private createTextCommand(path: string, steps: number): TextHistoryCommand {
    const editor = this.editor;
    const command: TextHistoryCommand = {
      id: `text:${path}`,
      label: 'Edit text',
      mergeKey: `text:${path}`,
      steps,
      // The edit already happened; undo/redo replay Monaco's own undo stops.
      execute: () => undefined,
      undo: () => editor.undoSteps(path, steps),
      redo: () => editor.redoSteps(path, steps),
      merge: (later) => this.createTextCommand(path, steps + (later as TextHistoryCommand).steps),
      remap: (from, to) => (path === from ? this.createTextCommand(to, steps) : command),
    };
    return command;
  }

  private async undo(): Promise<void> {
    await this.history.undo();
    this.renderStatus();
  }

  private async redo(): Promise<void> {
    await this.history.redo();
    this.renderStatus();
  }

  /** Flushes pending autosaves and waits for the writes to finish. */
  private async flushSaves(options: { suppressDialogs?: boolean } = {}): Promise<void> {
    const pending = [...this.saveTimers.entries()];
    this.saveTimers.clear();
    await Promise.all(
      pending.map(([path, timer]) => {
        window.clearTimeout(timer);
        return this.saveFile(path, true, false, options.suppressDialogs === true);
      }),
    );
  }

  private async saveFile(path: string, quiet = false, force = false, suppressDialog = false): Promise<void> {
    const value = this.editor.getValue(path);
    if (value === null) return;
    const expected = force ? undefined : this.fileVersions.get(path);
    try {
      await this.workspace.writeFile(path, value, expected);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      if (suppressDialog) {
        // Never leave a blocking dialog during unload or workspace switching.
        await this.saveFile(path, quiet, true, true);
        return;
      }
      const choice = await openDialog({
        title: t('workspace.conflictTitle'),
        body: `${path}\n${t('workspace.otherTabChanged')}`,
        width: 440,
        centered: true,
        actions: [
          { label: t('common.cancel'), value: 'cancel' },
          { label: t('workspace.conflictTheirs'), value: 'theirs' },
          { label: t('workspace.conflictMine'), value: 'mine', primary: true },
        ],
      });
      if (choice === 'mine') {
        await this.saveFile(path, quiet, true, suppressDialog);
        return;
      }
      if (choice === 'theirs') {
        // Read the authoritative record from IndexedDB — the in-memory copy
        // is exactly what lost the race.
        const stored = await this.workspace.fetchStoredFile(path);
        if (stored && !stored.binary) {
          this.editor.setValue(path, stored.content);
          this.fileVersions.set(path, stored.version);
          this.editor.markSaved(path);
          this.renderTabs();
        }
      }
      return;
    }
    this.fileVersions.set(path, this.workspace.versionOf(path));
    this.editor.markSaved(path);
    this.renderTabs();
    this.schedulePlayReload();
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
  // Diagnostics
  // ------------------------------------------------------------
  private setCompatibilityDiagnostics(issues: readonly CompatibilityIssue[]): void {
    // Compatibility results replace only their own section; game console
    // diagnostics from the current run stay visible.
    this.compatibilityDiagnostics = issues.map((issue) => ({
      code: `${issue.scope}:${issue.code}`,
      severity: issue.severity,
      message: issue.message,
      path: issue.path ?? undefined,
    }));
    this.renderProblems();
  }

  private handlePlayConsole(entry: PlayConsoleEntry): void {
    const location = entry.source
      ? ` ${entry.source}${entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ''}` : ''}`
      : '';
    this.log(`Test Play [${entry.level}]${location} ${entry.message}`);
    if (entry.level !== 'error' && entry.level !== 'warn') return;
    const code = `play:${entry.level}`;
    if (
      this.consoleDiagnostics.some(
        (item) =>
          item.code === code &&
          item.message === entry.message &&
          item.path === entry.source &&
          item.line === entry.line &&
          item.column === entry.column,
      )
    ) {
      return;
    }
    this.consoleDiagnostics.push({
      code,
      severity: entry.level === 'error' ? 'error' : 'warning',
      message: entry.message,
      path: entry.source,
      line: entry.line,
      column: entry.column,
    });
    if (this.consoleDiagnostics.length > MAX_PROBLEMS_LINES) this.consoleDiagnostics.shift();
    this.renderProblems();
  }

  private renderProblems(): void {
    this.problemsView.replaceChildren();
    const items = [...this.compatibilityDiagnostics, ...this.consoleDiagnostics];
    if (items.length === 0) {
      this.problemsView.appendChild(
        el('div', { class: 'terminal-note' }, [
          icon('check', 15),
          'No problems have been detected in the workspace.',
        ]),
      );
      return;
    }
    const list = el('div', { class: 'problems-list' });
    for (const item of items) {
      const location = item.path
        ? `${item.path}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}`
        : '';
      const row = el('button', {
        class: 'problems-row',
        type: 'button',
        title: item.code,
        on: {
          click: () => {
            if (item.path) this.openFile(item.path, item.line ?? 1, item.column ?? 1);
          },
        },
      });
      row.append(
        el('span', { class: `problems-severity is-${item.severity}`, text: item.severity }),
        el('span', { class: 'problems-message', text: item.message }),
        location ? el('span', { class: 'problems-location mono', text: location }) : el('span'),
      );
      list.appendChild(row);
    }
    this.problemsView.appendChild(list);
  }

  /** Validates the workspace against Arcade rules and reports into Problems. */
  checkCompatibility(): CompatibilityIssue[] {
    const files = this.workspace
      .list()
      .filter((entry) => entry.type === 'file' && isPlayPayloadPath(entry.path))
      .map((entry) => ({
        path: entry.path,
        content: entry.binary ? undefined : entry.content,
        size: entry.size ?? (entry.binary ? undefined : new TextEncoder().encode(entry.content).length),
        binary: entry.binary === true,
      }));
    const issues = checkArcadeCompatibility(files);
    this.setCompatibilityDiagnostics(issues);
    const errors = issues.filter((issue) => issue.severity === 'error').length;
    if (errors > 0) {
      toast('Arcade compatibility', `${errors} blocking issue(s). See Problems.`, 'warning', 4000);
    } else {
      toast('Arcade compatibility', 'No blocking issues found.', 'success', 2200);
    }
    this.selectPanel('problems');
    return issues;
  }

  // ------------------------------------------------------------
  // Test Play
  // ------------------------------------------------------------
  runTestPlay(): void {
    void this.executeTestPlay(true);
  }

  private async executeTestPlay(showPreview: boolean): Promise<void> {
    const files: PlayFile[] = [];
    for (const path of this.workspace.filePaths()) {
      if (!isPlayPayloadPath(path)) continue;
      const bytes = await this.workspace.readBytes(path);
      if (bytes) files.push({ path, bytes });
    }

    let payload: PlayPayload;
    try {
      payload = validatePlayFiles(files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handlePlayStatus('error', message);
      this.log(`Test Play: ${message}`);
      toast('Test Play', message, 'error');
      return;
    }

    if (showPreview) this.setActiveView('play');
    // The shell shows its own loading and error state, so the placeholder
    // steps aside as soon as a run starts.
    this.playHasRun = true;
    this.playEmpty.classList.add('hidden');
    try {
      await this.playHost.execute(payload);
      this.log(
        `Test Play started: ${payload.entry} (${payload.files.length} files, ${formatBytes(payload.totalBytes)})`,
      );
    } catch (error) {
      if (error instanceof PlayStopped) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Test Play failed: ${message}`);
      toast('Test Play failed', message, 'error');
    }
  }

  stopTestPlay(): void {
    if (!this.playHost.busy && this.playHost.currentStatus !== 'running') return;
    this.playHost.stop();
    this.log('Test Play stopped.');
  }

  private schedulePlayReload(): void {
    if (!this.settings.playAutoReload) return;
    if (!this.playHasRun) return;
    if (this.playReloadTimer !== undefined) window.clearTimeout(this.playReloadTimer);
    this.playReloadTimer = window.setTimeout(() => {
      this.playReloadTimer = undefined;
      // Auto reload keeps the current view: saving must not steal the tab.
      void this.executeTestPlay(false);
    }, 450);
  }

  private handlePlayStatus(status: PlayStatus, detail?: string): void {
    this.runPill.dataset.state = status;
    const label =
      status === 'loading'
        ? 'Loading…'
        : status === 'running'
          ? 'Running'
          : status === 'error'
            ? 'Failed'
            : 'Test Play';
    const labelEl = this.runPill.querySelector('.run-pill-label');
    if (labelEl) labelEl.textContent = label;
    this.runPill.title = detail ? `Test Play: ${detail}` : `Test Play (${modShortcut('Shift+Enter')})`;
    this.playStatus.dataset.state = status;
    this.playStatus.textContent =
      status === 'loading'
        ? 'Loading…'
        : status === 'running'
          ? 'Running'
          : status === 'error'
            ? 'Failed'
            : 'Idle';
    this.playStatus.title = detail ?? '';
    if (this.playStatusState !== status) {
      this.playStatusState = status;
      this.renderTabs();
    }
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

  private async closeTabsInside(path: string): Promise<void> {
    for (const tab of [...this.openTabs]) {
      if (isPathInside(tab, path)) await this.closeFile(tab, true);
    }
  }

  private renderWorkspaceStructure(): void {
    this.renderExplorer();
    this.renderTabs();
    this.renderBreadcrumbs();
    this.renderStatus();
  }

  private async newFile(directory?: string): Promise<void> {
    const base = directory ?? this.targetDirectory();
    const name = await promptDialog('New File', 'File name', '', {
      hint: base ? `Created in ${base}/` : 'Created at the workspace root',
      placeholder: 'example.ts',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const path = joinPath(base, name);
    try {
      await this.history.run({
        id: `create-file:${path}`,
        label: 'Create file',
        execute: async () => {
          await this.workspace.createFile(path, '');
          this.renderWorkspaceStructure();
          this.openFile(path);
          this.log(`Created ${path}`);
        },
        undo: async () => {
          await this.closeTabsInside(path);
          await this.workspace.remove(path);
          this.renderWorkspaceStructure();
        },
      });
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
    const path = joinPath(base, name);
    try {
      await this.history.run({
        id: `create-folder:${path}`,
        label: 'Create folder',
        execute: async () => {
          await this.workspace.createFolder(path);
          this.selectedPath = path;
          this.renderWorkspaceStructure();
          this.log(`Created folder ${path}`);
        },
        undo: async () => {
          await this.closeTabsInside(path);
          await this.workspace.remove(path);
          this.renderWorkspaceStructure();
        },
      });
    } catch (error) {
      toast('Could not create folder', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async renamePath(path: string): Promise<void> {
    const next = await promptDialog('Rename', 'New path', path, { confirmLabel: 'Rename' });
    if (!next || next === path) return;
    try {
      await this.history.run({
        id: `rename:${path}:${next}`,
        label: 'Rename',
        execute: async () => {
          await this.workspace.rename(path, next);
          this.remapTabs(path, next);
          this.history.remapKey(path, next);
          this.selectedPath = next;
          this.renderWorkspaceStructure();
          this.log(`Renamed ${path} → ${next}`);
        },
        undo: async () => {
          await this.workspace.rename(next, path);
          this.remapTabs(next, path);
          this.history.remapKey(next, path);
          this.selectedPath = path;
          this.renderWorkspaceStructure();
        },
      });
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
    const confirmed = await confirmDialog('Delete', `Delete "${path}"? You can undo this with Ctrl+Z.`, {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    try {
      // Snapshot everything that is about to be removed so undo can restore it.
      const entries = this.workspace.list().filter((entry) => isPathInside(entry.path, path));
      const blobs = new Map<string, Blob>();
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.binary) continue;
        const blob = await this.workspace.readBlob(entry.path);
        if (blob) blobs.set(entry.path, blob);
      }
      await this.history.run({
        id: `delete:${path}`,
        label: 'Delete',
        execute: async () => {
          await this.closeTabsInside(path);
          await this.workspace.remove(path);
          if (this.selectedPath && isPathInside(this.selectedPath, path)) this.selectedPath = null;
          this.renderWorkspaceStructure();
          this.log(`Deleted ${path}`);
        },
        undo: async () => {
          for (const entry of entries) {
            if (entry.type === 'dir') await this.workspace.createFolder(entry.path);
          }
          for (const entry of entries) {
            if (entry.type !== 'file') continue;
            if (!entry.binary) await this.workspace.createFile(entry.path, entry.content);
            else {
              const blob = blobs.get(entry.path);
              if (blob) await this.workspace.writeBinaryFile(entry.path, blob, entry.mime);
            }
          }
          this.renderWorkspaceStructure();
        },
      });
    } catch (error) {
      toast('Delete failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async openWorkspaceSwitcher(): Promise<void> {
    const records = await listWorkspaces();
    const items: PaletteItem[] = records
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        id: `workspace:${record.id}`,
        label: record.id === this.workspace.id ? `${record.name} (current)` : record.name,
        group: 'Workspaces',
        icon: 'hard-drive',
        run: () => {
          if (record.id !== this.workspace.id) void this.switchWorkspace(record.id);
        },
      }));
    items.push({
      id: 'workspace:new',
      label: t('workspace.create'),
      group: 'Workspaces',
      icon: 'plus',
      run: () => void this.createWorkspace(),
    });
    items.push({
      id: 'workspace:rename',
      label: 'Rename current workspace',
      group: 'Workspaces',
      icon: 'pencil',
      run: () => void this.renameWorkspace(),
    });
    openPalette(items, {
      placeholder: t('workspace.switch'),
      emptyText: 'No workspaces.',
      prefix: 'hard-drive',
    });
  }

  private async createWorkspace(): Promise<void> {
    const name = await promptDialog(t('workspace.create'), 'Workspace name', '', {
      confirmLabel: t('workspace.create'),
    });
    if (!name) return;
    // Save the current workspace before Workspace.create() changes the active id.
    await this.flushSaves();
    const created = await Workspace.create(name);
    await this.switchWorkspace(created.id);
  }

  /** Switching reloads the page so every pane gets the new workspace coherently. */
  private async switchWorkspace(id: string): Promise<void> {
    if (id === this.workspace.id) return;
    await this.flushSaves();
    if (this.openTabs.some((path) => this.editor.isDirty(path))) {
      const confirmed = await confirmDialog(
        t('workspace.switch'),
        'You have unsaved changes. Switch workspace anyway?',
        { confirmLabel: 'Switch' },
      );
      if (!confirmed) return;
    }
    await Workspace.open(id);
    window.location.reload();
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
    await this.importZipFile(file);
  }

  private async importZipFile(file: File): Promise<void> {
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

  /** Drag and drop: ZIPs expand, media becomes blobs, text stays text. */
  private bindDropZone(): void {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
    const overTimeline = (event: DragEvent) =>
      (event.target as HTMLElement | null)?.closest('.timeline') !== null;

    const show = (visible: boolean) => this.dropOverlay.classList.toggle('hidden', !visible);

    window.addEventListener('dragenter', (event) => {
      if (!carriesFiles(event)) return;
      if (overTimeline(event)) {
        depth = 0;
        show(false);
        return;
      }
      event.preventDefault();
      depth += 1;
      show(true);
    });
    window.addEventListener('dragover', (event) => {
      if (!carriesFiles(event) || overTimeline(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
      if (!carriesFiles(event) || overTimeline(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || event.relatedTarget === null) {
        depth = 0;
        show(false);
      }
    });
    window.addEventListener('drop', (event) => {
      if (!carriesFiles(event)) return;
      if (overTimeline(event)) {
        depth = 0;
        show(false);
        return;
      }
      event.preventDefault();
      depth = 0;
      show(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) void this.importDroppedFiles(files);
    });
  }

  /** Imports dropped files: archives are expanded, media stored as blobs. */
  async importDroppedFiles(files: File[]): Promise<void> {
    const existing = new Set(this.workspace.filePaths());
    const failures: string[] = [];
    let first: string | null = null;
    let imported = 0;

    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
          const result = await this.workspace.importZipBytes(new Uint8Array(await file.arrayBuffer()));
          imported += result.imported;
          this.log(`Imported ${result.imported} file(s) from ${file.name}.`);
          continue;
        }
        const name = normalizePath(file.name || 'file') || 'file';
        const path = uniquePath(existing, name);
        existing.add(path);
        if (isMediaPath(path)) {
          await this.workspace.writeBinaryFile(path, file, file.type || mimeForMedia(path));
          first ??= path;
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const text = tryDecodeText(bytes);
          if (text !== null) await this.workspace.writeFile(path, text);
          else await this.workspace.writeBinaryFile(path, bytes, file.type || undefined);
        }
        imported += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${file.name}: ${message}`);
      }
    }

    this.renderExplorer();
    if (imported > 0) {
      this.log(`Imported ${imported} dropped file(s).`);
      toast('Drop import complete', `${imported} file(s) imported.`, 'success', 1800);
    }
    for (const failure of failures) toast('Import failed', failure, 'error');
    if (first) this.openFile(first);
  }

  private async handleMediaImport(): Promise<void> {
    const files = [...(this.mediaInput.files ?? [])];
    this.mediaInput.value = '';
    if (files.length === 0) return;
    await this.importMediaFiles(files);
  }

  /** Stores picked media as blobs (no ZIP round-trip, no base64). */
  async importMediaFiles(files: File[]): Promise<void> {
    const existing = new Set(this.workspace.filePaths());
    let first: string | null = null;
    let imported = 0;
    for (const file of files) {
      try {
        const name = normalizePath(file.name || 'media') || 'media';
        const path = uniquePath(existing, name);
        existing.add(path);
        await this.workspace.writeBinaryFile(path, file, file.type || undefined);
        imported += 1;
        if (!first) first = path;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast('Import failed', `${file.name}: ${message}`, 'error');
      }
    }
    if (imported === 0) return;
    this.renderExplorer();
    this.log(`Imported ${imported} media file(s).`);
    toast('Media imported', `${imported} file(s)`, 'success', 1800);
    if (first) this.openFile(first);
  }

  private async workspaceZipFiles(): Promise<ZipFile[]> {
    const files: ZipFile[] = [];
    for (const entry of this.workspace.list()) {
      if (entry.type !== 'file') continue;
      if (!entry.binary) {
        files.push({ path: entry.path, type: 'text', text: entry.content });
        continue;
      }
      const blob = await this.workspace.readBlob(entry.path);
      if (blob)
        files.push({ path: entry.path, type: 'binary', bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return files;
  }

  /** Exports only Arcade-eligible files, leaving project files behind. */
  async exportForArcade(): Promise<void> {
    try {
      const result = buildArcadeZip(await this.workspaceZipFiles());
      const blob = new Blob([result.bytes.slice().buffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${this.workspace.name || 'flaxia-studio'}-arcade.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.log(
        `Arcade export: ${result.included.length} file(s), entry ${result.entry}, ` +
          `${result.excluded.length} excluded (${result.excluded.map((item) => item.path).join(', ')})`,
      );
      toast('Export started', anchor.download, 'success', 2000);
    } catch (error) {
      toast('Arcade export failed', error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Exports the timeline as a PNG frame sequence inside a ZIP archive. */
  async exportFrames(): Promise<void> {
    const wasPlaying = this.previewView.isPlaying;
    const originalPlayhead = this.timelinePlayheadMs;
    this.previewView.pause();
    try {
      const doc = await this.timelineStore.load();
      const frames = frameSequence(doc, { maxFrames: 60 });
      if (frames.length === 0) {
        toast('Export frames', 'Add a clip to the timeline first.', 'warning', 2600);
        return;
      }
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      for (const frame of frames) {
        const blob = await this.previewView.captureFrame(frame.timeMs);
        if (!blob) continue;
        files.push({
          name: frameFileName(frameIndexAt(frame.timeMs, frame.fps), frame.fps),
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
      }
      files.push({
        name: 'manifest.json',
        bytes: new TextEncoder().encode(manifestForFrames(frames, doc.fps)),
      });
      const zip = await buildFrameZip(files);
      const url = URL.createObjectURL(new Blob([zip.slice().buffer], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${this.workspace.name || 'flaxia-studio'}-frames.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.log(`Exported ${files.length - 1} timeline frame(s) as ZIP.`);
      toast('Export frames', `${files.length - 1} frame(s) exported.`, 'success', 2600);
    } catch (error) {
      toast('Export frames failed', error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.previewView.setPlayhead(originalPlayhead);
      this.timeline.seekTo(originalPlayhead);
      if (wasPlaying) this.previewView.play();
    }
  }

  async exportWorkspace(): Promise<void> {
    try {
      const bytes = await this.workspace.exportZip();
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
      tab('timeline', 'Timeline'),
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
    this.applyPanelView();
    this.renderPanelHead();
    this.layout();
    if (view === 'terminal') this.shell.focus();
  }

  private applyPanelView(): void {
    for (const node of this.panelBody.querySelectorAll<HTMLElement>('[data-view]')) {
      node.classList.toggle('is-active', node.dataset.view === this.panelView);
    }
  }

  private togglePanel(): void {
    this.panelVisible = !this.panelVisible;
    this.root.classList.toggle('is-panel-hidden', !this.panelVisible);
    this.layout();
    if (this.panelVisible) this.shell.fit();
  }

  private static readonly MUSIC_PATH = '.flaxia/music.json';

  private async loadMusicDocument(): Promise<void> {
    const raw = this.workspace.readFile(App.MUSIC_PATH);
    this.musicVersion = this.workspace.versionOf(App.MUSIC_PATH);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as NoteClip).notes)) {
        this.musicPanel.setClip(parsed as NoteClip);
      }
    } catch {
      // A malformed music document falls back to an empty note track.
    }
  }

  private scheduleMusicSave(clip: NoteClip): void {
    if (this.musicSaveTimer !== undefined) window.clearTimeout(this.musicSaveTimer);
    this.musicSaveTimer = window.setTimeout(() => {
      this.musicSaveTimer = undefined;
      void this.workspace
        .writeFile(App.MUSIC_PATH, JSON.stringify(clip), this.musicVersion || undefined)
        .then(() => {
          this.musicVersion = this.workspace.versionOf(App.MUSIC_PATH);
        })
        .catch(() => undefined);
    }, 500);
  }

  /** Puts timeline edits on the same undo stack as text and file operations. */
  private recordTimelineChange(previous: TimelineDoc, next: TimelineDoc, label: string): void {
    if (previous === next) return;
    void this.history.push({
      id: `timeline:${Date.now().toString(36)}:${label}`,
      label,
      mergeKey: `timeline:${label}`,
      execute: () => undefined,
      undo: () => this.timelineStore.apply(previous),
      redo: () => this.timelineStore.apply(next),
    });
  }

  private handleTimelineChange(): void {
    const doc = this.timelineStore.current;
    this.timeline.render();
    this.previewView.setDoc(doc);
    const path = this.inspector.sourcePath;
    if (path) this.inspector.setAdjustments(path, doc?.adjustments[path] ?? {});
  }

  private showTimeline(): void {
    this.panelVisible = true;
    this.root.classList.remove('is-panel-hidden');
    this.selectPanel('timeline');
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
    let startHeight = 0;
    bindDragHandle(resizer, {
      onStart: () => {
        startHeight = this.panel.getBoundingClientRect().height;
      },
      onDrag: ({ y }) => {
        const next = Math.max(110, Math.min(window.innerHeight * 0.7, startHeight - y));
        document.documentElement.style.setProperty('--panel-h', `${Math.round(next)}px`);
        this.layout();
      },
      onEnd: () => {
        this.layout();
        this.shell.fit();
      },
    });
  }

  /** Dragging the explorer border changes the sidebar width. */
  private bindSidebarResizer(): void {
    const handle = this.sidebarResizer;
    let startWidth = 0;
    bindDragHandle(handle, {
      onStart: () => {
        startWidth = this.sidebar.getBoundingClientRect().width;
      },
      onDrag: ({ x }) => {
        this.setSidebarWidth(clampSidebarWidth(startWidth + x, window.innerWidth));
      },
      onEnd: () => this.saveLayout(),
    });
    bindSeparatorKeys(handle, {
      axis: 'horizontal',
      step: 16,
      onStep: (delta) => {
        const current = this.sidebar.getBoundingClientRect().width;
        this.setSidebarWidth(clampSidebarWidth(current + delta, window.innerWidth));
      },
    });
  }

  private setSidebarWidth(width: number): void {
    this.layoutSizes.sidebarWidth = width;
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
    this.syncResizerValues();
  }

  /** Dragging the inspector border changes its width (it grows leftwards). */
  private bindInspectorResizer(): void {
    const handle = this.inspectorResizer;
    let startWidth = 0;
    bindDragHandle(handle, {
      onStart: () => {
        startWidth = this.inspector.host.getBoundingClientRect().width;
      },
      onDrag: ({ x }) => {
        this.setInspectorWidth(clampInspectorWidth(startWidth - x, window.innerWidth));
      },
      onEnd: () => {
        this.saveLayout();
        this.layout();
      },
    });
    bindSeparatorKeys(handle, {
      axis: 'horizontal',
      step: 16,
      onStep: (delta) => {
        const current = this.inspector.host.getBoundingClientRect().width;
        this.setInspectorWidth(clampInspectorWidth(current - delta, window.innerWidth));
      },
    });
  }

  private setInspectorWidth(width: number): void {
    this.layoutSizes.inspectorWidth = width;
    document.documentElement.style.setProperty('--inspector-w', `${width}px`);
    this.syncResizerValues();
  }

  private toggleInspector(): void {
    this.inspectorVisible = !this.inspectorVisible;
    this.layoutSizes.inspectorVisible = this.inspectorVisible;
    this.render();
    this.saveLayout();
    this.layout();
  }

  private syncResizerValues(): void {
    this.sidebarResizer.setAttribute(
      'aria-valuenow',
      String(Math.round(this.sidebar.getBoundingClientRect().width)),
    );
    this.inspectorResizer.setAttribute(
      'aria-valuenow',
      String(Math.round(this.inspector.host.getBoundingClientRect().width)),
    );
  }

  private saveLayout(): void {
    saveLayoutSizes(this.layoutSizes);
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
      const media = this.activePath ? mediaKind(this.activePath) : null;
      language.replaceChildren(
        icon(fileIcon(this.activePath ?? ''), 11),
        this.activePath
          ? media
            ? media[0]?.toUpperCase() + media.slice(1)
            : languageForPath(this.activePath)
          : 'Plain Text',
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
      const result = await this.linux.boot((text) => this.shell.writeLine(text.trimEnd()), this.workspace);
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
    if (network && /\bapk\s+(add|update|upgrade)\b/.test(command) && !this.warnedApkCors) {
      this.warnedApkCors = true;
      const message =
        'Alpine package repositories do not send CORS headers, so the browser Fetch proxy cannot download them. Use the Full image (gcc/git included) or build packages into the image.';
      this.log(message);
      toast('apk is blocked by CORS', message, 'warning', 9000);
    }
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
    if (network && result.exitCode !== 0) {
      this.log(
        'Network hint: third-party hosts must allow this page with CORS. apk/pip mirrors usually do not; use the Full image or a server-side allowlisted proxy.',
      );
    }
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

  private async syncGuestFiles(
    files: Array<{ path: string; content: string; binary?: boolean }>,
  ): Promise<void> {
    const guest = new Map(files.map((file) => [file.path, file]));
    const binaryNames: string[] = [];
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
    for (const [path, file] of guest) {
      const entry = this.workspace.get(path);
      if (entry && entry.binary === (file.binary === true) && entry.content === file.content) continue;
      if (file.binary) {
        await this.workspace.writeBinaryFile(path, base64ToBytes(file.content));
        if (this.openTabs.includes(path)) await this.closeFile(path, true);
        else if (this.editor.hasModel(path)) this.editor.close(path);
        binaryNames.push(path);
      } else {
        await this.workspace.writeFile(path, file.content);
        if (this.editor.hasModel(path)) {
          this.editor.setValue(path, file.content);
          this.editor.markSaved(path);
        }
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
    for (const path of binaryNames) {
      this.log(`Saved binary artifact ${path}.`);
      toast('Binary saved', `${path} is in the workspace (download it from the explorer).`, 'success', 3600);
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
        id: 'edit.undo',
        label: `Edit: ${t('command.undo')}`,
        group: 'Edit',
        icon: 'undo-2',
        hint: modShortcut('Z'),
        run: () => void this.undo(),
      },
      {
        id: 'edit.redo',
        label: `Edit: ${t('command.redo')}`,
        group: 'Edit',
        icon: 'redo-2',
        hint: modShortcut('Shift+Z'),
        run: () => void this.redo(),
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
        id: 'file.download',
        label: 'File: Download',
        group: 'File',
        icon: 'download',
        run: () => {
          const target = this.selectedPath ?? this.activePath;
          if (target) void this.downloadFile(target);
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
        id: 'file.media',
        label: 'Workspace: Import Media…',
        group: 'Workspace',
        icon: 'file-image',
        run: () => this.mediaInput.click(),
      },
      {
        id: 'file.export',
        label: 'Workspace: Export ZIP',
        group: 'Workspace',
        icon: 'upload',
        run: () => void this.exportWorkspace(),
      },
      {
        id: 'workspace.switch',
        label: `Workspace: ${t('workspace.switch')}`,
        group: 'Workspace',
        icon: 'hard-drive',
        run: () => void this.openWorkspaceSwitcher(),
      },
      {
        id: 'workspace.create',
        label: `Workspace: ${t('workspace.create')}`,
        group: 'Workspace',
        icon: 'plus',
        run: () => void this.createWorkspace(),
      },
      {
        id: 'music.open-piano-roll',
        label: `Music: ${t('command.openPianoRoll')}`,
        group: 'Music',
        icon: 'file-audio',
        run: () => this.setActiveView('music'),
      },
      {
        id: 'music.add-note-track',
        label: `Music: ${t('command.addNoteTrack')}`,
        group: 'Music',
        icon: 'plus',
        run: () => {
          this.timelineStore.updateWith((doc) => addTrack(doc, 'note'), 'Add note track');
          this.setActiveView('music');
        },
      },
      {
        id: 'video.export-frames',
        label: 'Video: Export frames (ZIP)',
        group: 'Video',
        icon: 'file-video',
        run: () => void this.exportFrames(),
      },
      {
        id: 'workspace.export-arcade',
        label: `Workspace: ${t('command.exportForArcade')}`,
        group: 'Workspace',
        icon: 'upload',
        run: () => void this.exportForArcade(),
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
        id: 'view.timeline',
        label: 'View: Focus Timeline',
        group: 'View',
        icon: 'panel-bottom',
        run: () => this.showTimeline(),
      },
      {
        id: 'view.inspector',
        label: 'View: Toggle Inspector',
        group: 'View',
        icon: 'panel-right',
        run: () => this.toggleInspector(),
      },
      {
        id: 'view.preview',
        label: 'View: Toggle Video Preview',
        group: 'View',
        icon: 'monitor',
        run: () => this.setActiveView(this.activeView === 'preview' ? 'editor' : 'preview'),
      },
      {
        id: 'test.run',
        label: 'Test: Run Test Play',
        group: 'Test',
        icon: 'play',
        hint: modShortcut('Shift+Enter'),
        run: () => this.runTestPlay(),
      },
      {
        id: 'test.compatibility',
        label: `Test: ${t('command.checkCompatibility')}`,
        group: 'Test',
        icon: 'check',
        run: () => this.checkCompatibility(),
      },
      {
        id: 'test.stop',
        label: 'Test: Stop Test Play',
        group: 'Test',
        icon: 'x',
        run: () => this.stopTestPlay(),
      },
      {
        id: 'view.play',
        label: 'View: Toggle Test Play',
        group: 'View',
        icon: 'panel-right',
        run: () => this.setActiveView(this.activeView === 'play' ? 'editor' : 'play'),
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
    const bottomTabSelect = el('select', { class: 'select' }, [
      el('option', {
        text: 'Timeline',
        attrs: { value: 'timeline', selected: this.settings.defaultBottomTab === 'timeline' },
      }),
      el('option', {
        text: 'Terminal',
        attrs: { value: 'terminal', selected: this.settings.defaultBottomTab === 'terminal' },
      }),
    ]);
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
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Default bottom panel' }),
        bottomTabSelect,
      ]),
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
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Test Play' }),
        el('div', {}, [
          switchRow(
            'playAutoReload',
            'Auto reload',
            'Re-run the sandboxed preview ~450ms after a save',
            this.settings.playAutoReload,
          ),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Linux (sub-feature)' }),
        el('div', {}, [
          switchRow(
            'linuxNetwork',
            'Linux network',
            'Route guest HTTP(S) through the browser Fetch proxy (slow: restarts Linux with DHCP)',
            this.settings.linuxNetwork,
          ),
        ]),
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
      playAutoReload: switches.get('playAutoReload')?.getAttribute('aria-checked') === 'true',
      linuxManifestUrl:
        manifestSelect.value === 'custom' ? manifest.value.trim() || 'auto' : manifestSelect.value,
      linuxNetwork: switches.get('linuxNetwork')?.getAttribute('aria-checked') === 'true',
      defaultBottomTab: bottomTabSelect.value === 'terminal' ? 'terminal' : 'timeline',
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
    if (this.panelView !== next.defaultBottomTab) this.selectPanel(next.defaultBottomTab);
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
        if (matchesShortcut(event, 'mod+z') && !event.shiftKey) {
          event.preventDefault();
          // Monaco also binds Ctrl+Z; stop propagation so it does not undo a
          // second time behind the app history's back.
          event.stopPropagation();
          void this.undo();
          return;
        }
        if (matchesShortcut(event, 'mod+shift+z') || matchesShortcut(event, 'mod+y')) {
          event.preventDefault();
          event.stopPropagation();
          void this.redo();
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
        if (matchesShortcut(event, 'mod+shift+enter')) {
          event.preventDefault();
          this.runTestPlay();
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
      binary: entry.binary === true,
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
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      root.replaceChildren(
        el('div', { class: 'sidebar-empty', text: `Flaxia Studio could not open the workspace: ${message}` }),
      );
      toast('Workspace failed to open', message, 'error', 10000);
    });
}
