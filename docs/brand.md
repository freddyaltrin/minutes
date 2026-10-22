# Minutes — brand notes

## The mark

A single short tick at 12 o'clock sweeps through a quarter arc into the first
line of a note; two shorter rules sit beneath it. Read top-down it is a clock
hand starting its sweep; read as a block it is three lines of notes. That is
the whole product: the minute you sit down, and the notes you take.

Three stroked paths, round caps and joins, one weight. No fill shapes, no
gradients, no transparency, no sparkle. Geometry lives in one place
(`scripts/build-icons.py`, mirrored in `src/renderer/src/components/Logo.tsx`):

| Element      | Path (512 space)                            |
| ------------ | ------------------------------------------- |
| Tick + rule 1 | `M160 104 V112 A96 96 0 0 0 256 208 H352`  |
| Rule 2       | `M160 304 H320`                             |
| Rule 3       | `M160 400 H288`                             |
| Stroke       | 56 units, `round` caps and joins            |

**Why it holds at 16 px.** Rule pitch is 96 units (3 px at 16 px) against a
56-unit stroke (1.75 px), so the three rules stay separate instead of merging
into a blob. The tick is the only vertical element, so it survives as a
distinct 1-2 px stub even when the arc softens. For the 16 px and 24 px raster
layers the script substitutes a *hinted* variant (2 px strokes, 48-unit corner)
that sits on the pixel grid; above 24 px the master arc is used as drawn.

## Application icon

Rounded square, corner radius 113 units (22 % of 512) — Windows-friendly,
does not fight the Windows 11 taskbar corner. The mark is paper on near-black
by default (`build/icon.svg`); the inverse (ink on paper) is also valid and is
what the in-app `Logo` component resolves to on a light theme.

Clear space: the mark occupies the central 50 % of the icon (x 128-384 with
caps). Keep at least 48 units (one stroke width) between the mark and anything
else, and do not place the mark closer to a container edge than its own
stroke width.

## Palette

| Name  | Hex       | Use                                        |
| ----- | --------- | ------------------------------------------ |
| Ink   | `#1F1D1A` | warm near-black; icon shell, tray glyph, text |
| Paper | `#F4F1EA` | warm paper; icon mark on dark shell, app background |

Nothing else. The recording state in the tray uses the same ink; it is a
small filled dot, not red.

## In-app usage

```tsx
import { Logo } from './components/Logo'

<Logo size={20} />                       // mark only, follows currentColor
<Logo size={20} variant="wordmark" />    // mark + "Minutes" in the system font
```

The wordmark sets "Minutes" at 0.92 × the mark height, weight 500,
letter-spacing -0.01em, in the system font stack
(`-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, …`). It is
never an image. `LogoMarkSvg` exports the mark as a raw SVG string for
non-React contexts.

## Generated files

All raster assets are produced by **`scripts/build-icons.py`** (Python 3,
Pillow, cairosvg). Re-run it after any change to the geometry:

```
pip install --break-system-packages pillow cairosvg
python3 scripts/build-icons.py
```

| File                                      | Notes                                     |
| ----------------------------------------- | ----------------------------------------- |
| `build/icon.svg`                          | master, 512 viewBox                       |
| `build/icon.png`                          | 1024 × 1024                               |
| `build/icon-256.png`                      | 256 × 256                                 |
| `build/icon.ico`                          | 16, 24, 32, 48, 64, 128, 256 px layers, each rasterised from vector at its own size (PNG-compressed entries, 256 px layer present for electron-builder) |
| `resources/tray-icon.png`                 | 32 × 32, ink on transparent, mark only    |
| `resources/tray-icon-recording.png`       | 32 × 32, mark + filled dot                |
| `resources/tray-icon-16.png`              | 16 × 16, hinted mark                      |
| `resources/tray-icon-recording-16.png`    | 16 × 16, hinted mark + dot                |

Verify the ICO layers with:

```
python3 -c "from PIL import Image; im=Image.open('build/icon.ico'); print(im.info.get('sizes'))"
```
