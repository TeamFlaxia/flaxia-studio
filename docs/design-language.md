# Design language

Synced from `flaxia/src/styles/main.css` (v5 "quiet craft"). Do not invent a new
palette.

## Tokens

| Token            | Light                      | Dark      |
| ---------------- | -------------------------- | --------- |
| `--bg-primary`   | `#ffffff`                  | `#181d28` |
| `--bg-secondary` | `#f8fafc`                  | `#212736` |
| `--bg-input`     | `#ffffff`                  | `#1b212e` |
| `--border`       | `#e2e8f0`                  | `#2e374d` |
| `--text-primary` | `#0f172a`                  | `#f8fafc` |
| `--text-muted`   | `#64748b`                  | `#94a3b8` |
| `--accent`       | `#10b981`                  | `#10b981` |
| `--accent-text`  | `#047857`                  | `#34d399` |
| radius           | 4/6/8/10/12px              | same      |
| motion           | 100/150/200ms              | same      |
| ease             | `cubic-bezier(.2,.8,.2,1)` | same      |

Font: Noto Sans JP + system. Code: `ui-monospace, SFMono-Regular, Menlo…`.

## Rules

- 1px hairlines, flat surfaces, no gradients, no glass, no glow.
- Emerald is an accent, not a fill: focus rings, active tab underline, VM
  status, selection.
- Radius is 6–12px; dense rows are 26–30px.
- Motion is compositor-friendly (opacity/transform). Respect
  `prefers-reduced-motion`.
- Focus visible: 2px neutral ring; accent ring on command inputs.
- Command palette keeps the Flaxia behavior: grouped actions, arrow keys,
  `aria-activedescendant`, Esc to close.

## Monaco themes

`flaxia-light` uses `#ffffff` editor / `#f8fafc` background; `flaxia-dark` uses
`#1b212e` editor inside the `#181d28` shell. Tokens map to emerald, slate, and
the same accent used by the chrome.
