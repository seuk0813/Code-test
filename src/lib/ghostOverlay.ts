import type { DurationValue } from '../types/score';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GHOST_GROUP_ID = 'ghost-overlay-group';

export interface NoteGhostSpec {
  kind: 'note';
  x: number;
  y: number;
  duration: DurationValue;
  isRest: boolean;
  stemUp: boolean;
  accidental: '#' | 'b' | 'n' | '';
  ledgerLineYs: number[];
  opacity: number;
  color: string;
}

export interface ChordGhostSpec {
  kind: 'chord';
  x: number;
  y: number;
  label: string;
  opacity: number;
  color: string;
}

export type GhostSpec = NoteGhostSpec | ChordGhostSpec | null;

function ensureGroup(svg: SVGSVGElement): SVGGElement {
  let group = svg.querySelector<SVGGElement>(`#${GHOST_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', GHOST_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  return group;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

/**
 * Number of stave lines a note beyond the 5-line staff needs a ledger line
 * through. The staff spans line 1 (bottom) to line 5 (top) in this app's
 * "line" convention (see CLEF_LINE0_REFERENCE in scoreUtils.ts) — verified
 * against real VexFlow-rendered ledger lines for both clefs.
 */
export function ledgerLinePositions(line: number): number[] {
  if (line <= 0) {
    const count = Math.floor(1 - line);
    return Array.from({ length: count }, (_, i) => -i);
  }
  if (line >= 6) {
    const count = Math.floor(line - 5);
    return Array.from({ length: count }, (_, i) => 6 + i);
  }
  return [];
}

export function renderGhost(svg: SVGSVGElement | null, spec: GhostSpec): void {
  if (!svg) return;
  const group = ensureGroup(svg);
  group.replaceChildren();
  if (!spec) return;

  if (spec.kind === 'chord') {
    const text = el('text', {
      x: spec.x,
      y: spec.y,
      'text-anchor': 'middle',
      'font-size': 15,
      'font-weight': 700,
      fill: spec.color,
      opacity: spec.opacity,
    });
    text.textContent = spec.label;
    group.appendChild(text);
    return;
  }

  const { x, y, opacity, color } = spec;

  spec.ledgerLineYs.forEach((ly) => {
    group.appendChild(
      el('line', { x1: x - 9, y1: ly, x2: x + 9, y2: ly, stroke: color, 'stroke-width': 1.2, opacity }),
    );
  });

  if (spec.isRest) {
    group.appendChild(el('rect', { x: x - 5, y: y - 3, width: 10, height: 6, rx: 1.5, fill: color, opacity }));
    return;
  }

  const filled = spec.duration !== 'w' && spec.duration !== 'h';
  group.appendChild(
    el('ellipse', {
      cx: x,
      cy: y,
      rx: 6,
      ry: 4.5,
      transform: `rotate(-18 ${x} ${y})`,
      fill: filled ? color : 'white',
      stroke: color,
      'stroke-width': 1.4,
      opacity,
    }),
  );

  if (spec.duration !== 'w') {
    const stemX = x + (spec.stemUp ? 5.7 : -5.7);
    const stemY2 = y + (spec.stemUp ? -34 : 34);
    group.appendChild(
      el('line', { x1: stemX, y1: y, x2: stemX, y2: stemY2, stroke: color, 'stroke-width': 1.4, opacity }),
    );

    const flagCount = spec.duration === '8' ? 1 : spec.duration === '16' ? 2 : 0;
    const dir = spec.stemUp ? 1 : -1;
    for (let i = 0; i < flagCount; i++) {
      const baseY = stemY2 + i * dir * 7;
      const d = `M ${stemX} ${baseY} Q ${stemX + 8} ${baseY + dir * 5} ${stemX + 2} ${baseY + dir * 13}`;
      group.appendChild(
        el('path', { d, stroke: color, 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round', opacity }),
      );
    }
  }

  if (spec.accidental) {
    const symbol = spec.accidental === '#' ? '♯' : spec.accidental === 'b' ? '♭' : '♮';
    const text = el('text', { x: x - 14, y: y + 4, 'font-size': 13, fill: color, opacity });
    text.textContent = symbol;
    group.appendChild(text);
  }
}

export function clearGhost(svg: SVGSVGElement | null): void {
  renderGhost(svg, null);
}

const TOOLTIP_GROUP_ID = 'tooltip-overlay-group';

/**
 * A small custom hover/tap tooltip, used instead of the native SVG <title>
 * (which is slow to appear and easy to miss on a tiny marker) — e.g. the
 * "measure is full" warning.
 */
export function renderTooltip(svg: SVGSVGElement | null, spec: { x: number; y: number; text: string } | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${TOOLTIP_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', TOOLTIP_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!spec) return;

  const paddingX = 8;
  // Generous per-character estimate (Korean glyphs render close to the font
  // size wide at 12px) — underestimating this let the bubble render narrower
  // than the actual text, which could then spill past the SVG's own edge and
  // get clipped by its default overflow:hidden.
  const charWidth = 11;
  const w = Math.min(spec.text.length * charWidth + paddingX * 2, 280);
  const h = 24;
  const margin = 4;
  const svgWidth = Number(svg.getAttribute('width')) || w + margin * 2;
  // Center on the marker, but clamp so the bubble never runs past either edge
  // of the SVG canvas — otherwise a marker near the left/right border clips
  // the message instead of just shifting the bubble to stay fully visible.
  const x = Math.min(Math.max(spec.x - w / 2, margin), svgWidth - w - margin);
  const y = spec.y - h - 10;

  group.appendChild(el('rect', { x, y, width: w, height: h, rx: 5, fill: '#2b2b2b', opacity: 0.94 }));
  const text = el('text', {
    x: x + w / 2,
    y: y + h / 2 + 4,
    'text-anchor': 'middle',
    'font-size': 12,
    fill: '#fff',
  });
  text.textContent = spec.text;
  group.appendChild(text);
}

export function clearTooltip(svg: SVGSVGElement | null): void {
  renderTooltip(svg, null);
}

const PLAYBACK_GROUP_ID = 'playback-overlay-group';

export interface PlaybackVisual {
  /** Vertical playhead bars (one per staff being played), snapped exactly to the sounding note's real X — never interpolated, so it can't drift out of alignment. */
  bars: { x: number; y0: number; y1: number }[];
}

/**
 * Draws only the playback playhead bars. The "currently sounding" note
 * highlight itself is NOT drawn here — it's rendered by recoloring the real
 * VexFlow note (same styling path as note selection) in renderScore, so it
 * is pixel-perfectly aligned by construction instead of relying on a
 * separately-computed overlay position.
 */
export function renderPlayback(svg: SVGSVGElement | null, visual: PlaybackVisual | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${PLAYBACK_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', PLAYBACK_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!visual) return;

  visual.bars.forEach((b) => {
    group!.appendChild(
      el('line', { x1: b.x, y1: b.y0, x2: b.x, y2: b.y1, stroke: '#e03131', 'stroke-width': 2, opacity: 0.55 }),
    );
  });
}

export function clearPlayback(svg: SVGSVGElement | null): void {
  renderPlayback(svg, null);
}

const SEEK_GROUP_ID = 'seek-bar-group';

export interface SeekBarSpec {
  x: number;
  y0: number;
  y1: number;
}

/** The draggable "start playback here" bar. Its knob is pointer-events:auto
 * (the overlay itself is not) so it can be grabbed; hit-testing for the drag
 * is handled in StaffEditor via findSeekHandleAt against the same geometry. */
export function renderSeekBar(svg: SVGSVGElement | null, spec: SeekBarSpec | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${SEEK_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', SEEK_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!spec) return;
  group.appendChild(el('line', { x1: spec.x, y1: spec.y0, x2: spec.x, y2: spec.y1, stroke: '#2f9e44', 'stroke-width': 2.5 }));
  // Grab knob at the top of the bar.
  group.appendChild(
    el('path', {
      d: `M${spec.x - 7} ${spec.y0 - 12} L${spec.x + 7} ${spec.y0 - 12} L${spec.x} ${spec.y0} Z`,
      fill: '#2f9e44',
    }),
  );
}

export function clearSeekBar(svg: SVGSVGElement | null): void {
  renderSeekBar(svg, null);
}

const MEASURE_FLASH_GROUP_ID = 'measure-flash-group';

export interface MeasureFlashSpec {
  /** Stable per-flash identity, so a still-active flash's DOM node (and its
   * already-running CSS fade animation) is left untouched across re-renders
   * instead of being recreated and restarted from full opacity. */
  id: number;
  x: number;
  y: number;
}

/** Green checkmarks that fade out over ~3s, flashed over a measure the
 * moment its beat count exactly fills the time signature (see StaffEditor's
 * measure-completion tracking). Reconciles by id rather than replacing all
 * children each call, since the fade is a real CSS animation that must keep
 * running across the score's normal re-renders. */
export function renderMeasureCompleteFlashes(svg: SVGSVGElement | null, specs: MeasureFlashSpec[]): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${MEASURE_FLASH_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', MEASURE_FLASH_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  const liveIds = new Set(specs.map((s) => String(s.id)));
  Array.from(group.children).forEach((child) => {
    if (!liveIds.has(child.getAttribute('data-flash-id') ?? '')) child.remove();
  });
  specs.forEach((spec) => {
    const key = String(spec.id);
    if (group!.querySelector(`[data-flash-id="${key}"]`)) return;
    const mark = el('g', { 'data-flash-id': key, class: 'measure-flash-check' });
    mark.setAttribute('transform', `translate(${spec.x}, ${spec.y})`);
    mark.appendChild(
      el('path', {
        d: 'M-7 0 L-2 6 L8 -8',
        stroke: '#2f9e44',
        'stroke-width': 3,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        fill: 'none',
      }),
    );
    group!.appendChild(mark);
  });
}
