import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

export { monaco };

export interface CursorPosition {
  line: number;
  column: number;
  selected: number;
}

export interface EditorCallbacks {
  onChange(path: string): void;
  onCursor(position: CursorPosition): void;
  onFocus(): void;
}

export class EditorManager {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly savedVersions = new Map<string, number>();
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private activePath: string | null = null;
  private suppressChange = false;
  private callbacks: EditorCallbacks | null = null;
  private currentSettings = {
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    minimap: true,
  };

  constructor(private readonly host: HTMLElement) {
    defineThemes();
  }

  init(callbacks: EditorCallbacks): void {
    this.callbacks = callbacks;
    this.editor = monaco.editor.create(this.host, {
      model: null,
      theme: document.documentElement.dataset.theme === 'dark' ? 'flaxia-dark' : 'flaxia-light',
      automaticLayout: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: this.currentSettings.fontSize,
      lineHeight: 22,
      tabSize: this.currentSettings.tabSize,
      insertSpaces: true,
      wordWrap: this.currentSettings.wordWrap ? 'on' : 'off',
      minimap: { enabled: this.currentSettings.minimap, renderCharacters: false, maxColumn: 90 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'phase',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      padding: { top: 10, bottom: 24 },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      glyphMargin: false,
      folding: true,
      links: true,
      contextmenu: true,
      stickyScroll: { enabled: true, maxLineCount: 3 },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      fixedOverflowWidgets: true,
      ariaLabel: 'Code editor',
    });

    this.editor.onDidChangeCursorPosition((event) => {
      const model = this.editor?.getModel();
      const selected = model
        ? (this.editor
            ?.getSelections()
            ?.reduce((total, selection) => total + model.getValueInRange(selection).length, 0) ?? 0)
        : 0;
      this.callbacks?.onCursor({ line: event.position.lineNumber, column: event.position.column, selected });
    });

    this.editor.onDidFocusEditorText(() => this.callbacks?.onFocus());

    configureTypeScript();
  }

  setSettings(settings: { fontSize: number; tabSize: number; wordWrap: boolean; minimap: boolean }): void {
    this.currentSettings = settings;
    this.editor?.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
    });
    for (const model of this.models.values()) {
      model.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
    }
  }

  setTheme(resolved: 'light' | 'dark'): void {
    monaco.editor.setTheme(resolved === 'dark' ? 'flaxia-dark' : 'flaxia-light');
  }

  open(path: string, content: string, language: string): void {
    if (this.activePath && this.activePath !== path) {
      this.viewStates.set(this.activePath, this.editor?.saveViewState() ?? null);
    }

    let model = this.models.get(path);
    if (!model) {
      const uri = monaco.Uri.parse(`inmemory://workspace/${encodePath(path)}`);
      model = monaco.editor.createModel(content, language, uri);
      this.models.set(path, model);
      this.savedVersions.set(path, model.getAlternativeVersionId());
      if (language === 'typescript' || language === 'javascript') {
        model.updateOptions({ tabSize: this.currentSettings.tabSize, insertSpaces: true });
      }
      model.onDidChangeContent(() => {
        if (this.suppressChange) return;
        this.callbacks?.onChange(path);
      });
    }

    this.activePath = path;
    this.editor?.setModel(model);
    const state = this.viewStates.get(path);
    if (state) this.editor?.restoreViewState(state);
    this.editor?.focus();
  }

  setValue(path: string, content: string): void {
    const model = this.models.get(path);
    if (!model || model.getValue() === content) return;
    this.suppressChange = true;
    model.setValue(content);
    this.suppressChange = false;
    this.savedVersions.set(path, model.getAlternativeVersionId());
  }

  markSaved(path: string): void {
    const model = this.models.get(path);
    if (model) this.savedVersions.set(path, model.getAlternativeVersionId());
  }

  isDirty(path: string): boolean {
    const model = this.models.get(path);
    if (!model) return false;
    return model.getAlternativeVersionId() !== this.savedVersions.get(path);
  }

  getValue(path: string): string | null {
    return this.models.get(path)?.getValue() ?? null;
  }

  getActivePath(): string | null {
    return this.activePath;
  }

  hasModel(path: string): boolean {
    return this.models.has(path);
  }

  close(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    this.viewStates.delete(path);
    this.models.delete(path);
    this.savedVersions.delete(path);
    model.dispose();
    if (this.activePath === path) {
      this.activePath = null;
      this.editor?.setModel(null);
    }
  }

  show(value: boolean): void {
    this.host.classList.toggle('hidden', !value);
    if (value) this.editor?.layout();
  }

  focus(): void {
    this.editor?.focus();
  }

  revealLine(path: string, line: number, column = 1): void {
    if (this.activePath !== path) return;
    const model = this.models.get(path);
    if (!model) return;
    const target = Math.min(Math.max(1, line), Math.max(1, model.getLineCount()));
    this.editor?.setPosition({ lineNumber: target, column });
    this.editor?.revealLineInCenter(target);
    this.editor?.focus();
  }

  layout(): void {
    this.editor?.layout();
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function configureTypeScript(): void {
  const compilerOptions = {
    target: monaco.typescript.ScriptTarget.ES2020,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    esModuleInterop: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  monaco.typescript.typescriptDefaults.setEagerModelSync(true);
}

function defineThemes(): void {
  monaco.editor.defineTheme('flaxia-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '0f172a', background: 'ffffff' },
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
      { token: 'keyword', foreground: '047857', fontStyle: 'bold' },
      { token: 'string', foreground: '0f766e' },
      { token: 'number', foreground: 'b45309' },
      { token: 'type', foreground: '1d4ed8' },
      { token: 'type.identifier', foreground: '1d4ed8' },
      { token: 'delimiter', foreground: '475569' },
      { token: 'tag', foreground: '047857' },
      { token: 'attribute.name', foreground: '1d4ed8' },
      { token: 'attribute.value', foreground: '0f766e' },
      { token: 'variable', foreground: '0f172a' },
      { token: 'function', foreground: '7e22ce' },
      { token: 'regexp', foreground: 'be185d' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#0f172a',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#334155',
      'editorCursor.foreground': '#10b981',
      'editor.selectionBackground': '#10b98120',
      'editor.inactiveSelectionBackground': '#10b98112',
      'editor.lineHighlightBackground': '#f8fafc',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#e2e8f0',
      'editorIndentGuide.activeBackground1': '#cbd5e1',
      'editorBracketMatch.background': '#10b98118',
      'editorBracketMatch.border': '#10b981',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e2e8f0',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e2e8f0',
      'editorSuggestWidget.selectedBackground': '#f1f5f9',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#e2e8f0',
      'editorGutter.background': '#ffffff',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#cbd5e166',
      'scrollbarSlider.hoverBackground': '#cbd5e199',
      'scrollbarSlider.activeBackground': '#94a3b8aa',
      'minimap.background': '#ffffff',
      'menu.background': '#ffffff',
      'menu.border': '#e2e8f0',
      'quickInput.background': '#ffffff',
      'quickInputList.focusBackground': '#f1f5f9',
    },
  });

  monaco.editor.defineTheme('flaxia-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'f8fafc', background: '1b212e' },
      { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
      { token: 'keyword', foreground: '34d399', fontStyle: 'bold' },
      { token: 'string', foreground: '6ee7b7' },
      { token: 'number', foreground: 'fbbf24' },
      { token: 'type', foreground: '60a5fa' },
      { token: 'type.identifier', foreground: '60a5fa' },
      { token: 'delimiter', foreground: 'cbd5e1' },
      { token: 'tag', foreground: '34d399' },
      { token: 'attribute.name', foreground: '60a5fa' },
      { token: 'attribute.value', foreground: '6ee7b7' },
      { token: 'variable', foreground: 'f8fafc' },
      { token: 'function', foreground: 'c084fc' },
      { token: 'regexp', foreground: 'f472b6' },
    ],
    colors: {
      'editor.background': '#1b212e',
      'editor.foreground': '#f8fafc',
      'editorLineNumber.foreground': '#64748b',
      'editorLineNumber.activeForeground': '#cbd5e1',
      'editorCursor.foreground': '#34d399',
      'editor.selectionBackground': '#10b98138',
      'editor.inactiveSelectionBackground': '#10b98122',
      'editor.lineHighlightBackground': '#212736',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#2e374d',
      'editorIndentGuide.activeBackground1': '#3d4966',
      'editorBracketMatch.background': '#10b98128',
      'editorBracketMatch.border': '#34d399',
      'editorWidget.background': '#242c3d',
      'editorWidget.border': '#2e374d',
      'editorSuggestWidget.background': '#242c3d',
      'editorSuggestWidget.border': '#2e374d',
      'editorSuggestWidget.selectedBackground': '#2a3246',
      'editorHoverWidget.background': '#242c3d',
      'editorHoverWidget.border': '#2e374d',
      'editorGutter.background': '#1b212e',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#3d496666',
      'scrollbarSlider.hoverBackground': '#3d496699',
      'scrollbarSlider.activeBackground': '#64748baa',
      'minimap.background': '#1b212e',
      'menu.background': '#242c3d',
      'menu.border': '#2e374d',
      'quickInput.background': '#242c3d',
      'quickInputList.focusBackground': '#2a3246',
    },
  });
}
