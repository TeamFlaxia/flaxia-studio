(() => {
  try {
    const stored = localStorage.getItem('flaxia_theme');
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const theme = stored === 'light' || stored === 'dark' ? stored : dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#181d28' : '#ffffff';
  } catch {
    /* theme boot is best-effort */
  }
})();
