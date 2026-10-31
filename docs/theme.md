# Theme

The TUI's color palette lives in one place, `atelier-cli/src/tui/theme.ts`, as a theme: named tokens instead of raw colors. Elements created or reworked from now on paint with these tokens; the existing ones keep their styles in `atelier-cli/src/tui/style.ts` until they are reworked. The first to use them is the fullscreen header (see [Fullscreen header](cli.md#fullscreen-header)).

## Tokens

The one theme today is `atelierDark`, the active one (`activeTheme`), with no setting to pick another.

| Token                   | `atelierDark`            | Use                                                           |
| ----------------------- | ------------------------ | ------------------------------------------------------------- |
| `background`            | `#252D33`                | Main background                                               |
| `surface`               | `#2F383F`                | Editor and secondary surfaces                                 |
| `border`                | `#87939C`                | Borders of controls and separations that need presence        |
| `separator`             | `#46525B`                | Discreet separators; never informative text on the background |
| `text`                  | `#FFFFFF`                | Main text                                                     |
| `textSecondary`         | `#A3ADB5`                | Metadata, pending states, secondary content                   |
| `running`               | alias of `textSecondary` | Work in progress, always with a symbol or indicator           |
| `brand`                 | `#E58F72`                | Atelier's identity                                            |
| `focus`                 | `#B1B9F9`                | Focus, selection, links                                       |
| `success`               | `#4EBA65`                | Completed, successful result                                  |
| `warning`               | `#FFC107`                | Attention; not work in progress by itself                     |
| `error`                 | `#FF7A8C`                | Errors, deletion counters on the normal background            |
| `diffAddedBackground`   | `#225C2B`                | Band of added lines                                           |
| `diffRemovedBackground` | `#7A2936`                | Band of removed lines                                         |
| `diffAddedText`         | `#9FEBB0`                | Signs, numbers and highlights inside the added band           |
| `diffRemovedText`       | `#FFC2CB`                | Signs, numbers and highlights inside the removed band         |

`running` is an alias: a theme does not supply it, and it always takes the value of `textSecondary`.

## Painting with a token

`ink(theme, color, mode)` gives `fg(token, text)` and `bg(token, text)`. `color` is the same flag `painter(color)` takes; `mode` is the terminal's color mode, `getTerminalColorMode()` from `@earendil-works/pi-tui`, which turns each HEX into truecolor or the nearest of the 256-color palette.

```ts
const paint = ink(activeTheme, color, getTerminalColorMode());
paint.fg("textSecondary", `3 files ${paint.fg("brand", "atelier")} changed`);
paint.bg("diffAddedBackground", line);
```

Without color both give the text back as it is. Both nest: `fg` sets its color again after every reset of the text's color inside it (`\x1b[39m`, `\x1b[0m`, `\x1b[m`), and `bg` its background after every reset of the background (`\x1b[49m`, `\x1b[0m`, `\x1b[m`), so painted text can sit inside painted text. `hexOf(theme, token)` gives a token's HEX, an alias's being the one of the token it stands for.

## Adding a theme

1. Declare it in `theme.ts` with every token of `Theme`, without the aliases: `export const atelierLight = { background: "#…", … } as const satisfies Theme;`.
2. Add it to `themes`: `{ atelierDark, atelierLight }`.
3. Pin its HEX values in `atelier-cli/test/tui-theme.test.ts`.

A new token goes into `Theme`, so every theme has to give it a value; a new alias goes into `ALIASES`, naming the token it stands for. Picking a theme other than `activeTheme` needs a setting that does not exist yet.
