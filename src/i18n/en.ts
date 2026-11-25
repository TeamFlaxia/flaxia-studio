/**
 * English is the source of truth for translation keys.
 *
 * Every value is a literal (`as const`) so `index.ts` can derive the dotted
 * key union and the placeholder names used by `t()`.
 */
export const en = {
  common: {
    ok: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    close: 'Close',
    loading: 'Loading…',
    retry: 'Retry',
    warning: 'Warning',
    error: 'Error',
  },
  command: {
    undo: 'Undo',
    redo: 'Redo',
    publish: 'Publish',
    checkCompatibility: 'Check compatibility',
    exportForArcade: 'Export for Arcade',
    newProjectFromTemplate: 'New project from template',
    openPianoRoll: 'Open Piano Roll',
    exportFrames: 'Export frames',
    addNoteTrack: 'Add note track',
  },
  play: {
    entryPoint: 'Entry point',
    viewport: 'Viewport',
    console: 'Console',
    noProblems: 'No problems detected',
    problemsFound: '{count} problem(s) found',
    runtimeError: 'Runtime error',
    compatibilityWarning: 'Compatibility warning',
    bpm: 'BPM',
    scale: 'Scale',
    noteTrack: 'Note track',
  },
  publish: {
    title: 'Publish project',
    prepare: 'Prepare',
    uploading: 'Uploading…',
    commit: 'Commit changes',
    success: 'Published successfully',
    newVersion: 'New version',
    notConnected: 'Not connected',
    tokenRequired: 'An access token is required',
  },
  template: {
    canvas: 'Canvas',
    sdkStarter: 'SDK starter',
    saveData: 'Save data',
    apply: 'Apply template',
  },
  workspace: {
    switch: 'Switch workspace',
    create: 'Create workspace',
    duplicate: 'Duplicate workspace',
    deleteConfirm: 'Delete workspace "{name}"? This cannot be undone.',
    conflictTitle: 'Workspace conflict',
    conflictMine: 'My version',
    conflictTheirs: 'Their version',
    otherTabChanged: 'This workspace was changed in another tab.',
  },
} as const;

/** The literal shape every other locale is checked against. */
export type EnResource = typeof en;
