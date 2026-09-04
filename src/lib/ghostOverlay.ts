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

/** Draws several ghosts at once, replacing whatever was there — a multi-note
 * drag previews every selected note at its new position (see StaffEditor's
 * group drag). */
export function renderGhosts(svg: SVGSVGElement | null, specs: GhostSpec[]): void {
  if (!svg) return;
  const group = ensureGroup(svg);
  group.replaceChildren();
  specs.forEach((spec) => {
    if (spec) drawGhost(group, spec);
  });
}

export function renderGhost(svg: SVGSVGElement | null, spec: GhostSpec): void {
  renderGhosts(svg, [spec]);
}

function drawGhost(group: SVGGElement, spec: NonNullable<GhostSpec>): void {
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

    const flagCount = spec.duration === '8' ? 1 : spec.duration === '16' ? 2 : spec.duration === '32' ? 3 : 0;
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

const PICKUP_HANDLE_GROUP_ID = 'pickup-handle-group';

export interface PickupHandleSpec {
  x: number;
  y0: number;
  y1: number;
}

/**
 * Draggable resize handles for the boundary between a 못갖춘마디(pickup)
 * measure and the one after it, and/or the boundary before a trailing
 * partial closing measure — drawn as an orange grip line with knobs at both
 * ends so it reads as separate from the green seek bar even when both are
 * near each other. Either spec may be null if that end isn't split.
 */
export function renderPickupHandles(
  svg: SVGSVGElement | null,
  pickup: PickupHandleSpec | null,
  trailing: PickupHandleSpec | null,
): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${PICKUP_HANDLE_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', PICKUP_HANDLE_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  [pickup, trailing].forEach((spec) => {
    if (!spec) return;
    group!.appendChild(
      el('line', { x1: spec.x, y1: spec.y0, x2: spec.x, y2: spec.y1, stroke: '#f08c00', 'stroke-width': 3, opacity: 0.65 }),
    );
    [spec.y0, spec.y1].forEach((y) => {
      group!.appendChild(el('circle', { cx: spec.x, cy: y, r: 5, fill: '#f08c00' }));
    });
  });
}

export function clearPickupHandles(svg: SVGSVGElement | null): void {
  renderPickupHandles(svg, null, null);
}

const MEASURE_TOOLS_GROUP_ID = 'measure-tools-group';

export interface MeasureToolsSpec {
  /** The barline being hovered/dragged — its own measure's right edge. */
  x: number;
  /** Vertical span of the grip line (the full grand staff). */
  y0: number;
  y1: number;
  /** Centre of the 자동정렬 button, parked clear of the staff below the grip. */
  buttonX: number;
  buttonY: number;
  /** Highlights the grip while a resize drag is actually in progress. */
  dragging: boolean;
  /** Highlights the button while the pointer is over it. */
  buttonHot: boolean;
}

/** Grip + 자동정렬 button shown while the pointer is on a measure's right
 * barline: drag the grip sideways to hand-size that measure (see
 * Measure.widthScale), or press the button to throw that sizing away along
 * with every hand-dragged note X in the measure (see autoAlignMeasure).
 * Deliberately drawn on the interaction overlay rather than into the score
 * SVG itself, so it never leaks into a printed page or PDF export. */
export function renderMeasureTools(svg: SVGSVGElement | null, spec: MeasureToolsSpec | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${MEASURE_TOOLS_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', MEASURE_TOOLS_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!spec) return;
  const accent = '#7a5cff';
  // A soft band BEHIND the barline rather than another thin line on top of
  // it: the seek bar parks on barlines too, and two thin vertical strokes at
  // the same x were impossible to tell apart.
  const bandWidth = spec.dragging ? 11 : 8;
  group.appendChild(
    el('rect', {
      x: spec.x - bandWidth / 2,
      y: spec.y0,
      width: bandWidth,
      height: spec.y1 - spec.y0,
      rx: bandWidth / 2,
      fill: accent,
      opacity: spec.dragging ? 0.35 : 0.18,
    }),
  );

  // Drag arrows and the 자동정렬 button share one cluster in the open space
  // below the staff, so neither has to fight the staff lines for legibility.
  const arrowGap = 22;
  [-1, 1].forEach((dir) => {
    group!.appendChild(
      el('path', {
        d: `M${spec.buttonX + dir * (arrowGap + 7)} ${spec.buttonY - 6} L${spec.buttonX + dir * (arrowGap + 14)} ${spec.buttonY} L${spec.buttonX + dir * (arrowGap + 7)} ${spec.buttonY + 6} Z`,
        fill: accent,
        opacity: spec.dragging ? 1 : 0.75,
      }),
    );
    group!.appendChild(
      el('line', {
        x1: spec.buttonX + dir * arrowGap,
        y1: spec.buttonY,
        x2: spec.buttonX + dir * (arrowGap + 7),
        y2: spec.buttonY,
        stroke: accent,
        'stroke-width': 2,
        opacity: spec.dragging ? 1 : 0.75,
      }),
    );
  });

  group.appendChild(
    el('circle', {
      cx: spec.buttonX,
      cy: spec.buttonY,
      r: 13,
      fill: spec.buttonHot ? accent : '#ffffff',
      stroke: accent,
      'stroke-width': 2,
    }),
  );
  // Three stacked bars of increasing length — a "tidy these up" glyph.
  const barColor = spec.buttonHot ? '#ffffff' : accent;
  [-4.5, 0, 4.5].forEach((dy, i) => {
    const half = [3, 5, 7][i];
    group!.appendChild(
      el('line', {
        x1: spec.buttonX - half,
        y1: spec.buttonY + dy,
        x2: spec.buttonX + half,
        y2: spec.buttonY + dy,
        stroke: barColor,
        'stroke-width': 2,
        'stroke-linecap': 'round',
      }),
    );
  });
}

const MEASURE_WARNING_GROUP_ID = 'measure-warning-group';

export interface MeasureWarningSpec {
  x: number;
  y: number;
  hot: boolean;
}

/** Red "!" badges over the end of every measure left short of its time
 * signature — pressing one pads that measure out with rests (see
 * fillStaffMeasureWithRests). On the overlay, not in the score SVG, so an
 * in-progress score still prints/exports clean. */
export function renderMeasureWarnings(svg: SVGSVGElement | null, specs: MeasureWarningSpec[]): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${MEASURE_WARNING_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', MEASURE_WARNING_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  specs.forEach((spec) => {
    const red = '#e03131';
    group!.appendChild(
      el('circle', {
        cx: spec.x,
        cy: spec.y,
        r: spec.hot ? 11 : 9.5,
        fill: red,
        stroke: '#ffffff',
        'stroke-width': 1.5,
        opacity: spec.hot ? 1 : 0.85,
      }),
    );
    group!.appendChild(
      el('line', { x1: spec.x, y1: spec.y - 4.5, x2: spec.x, y2: spec.y + 1.5, stroke: '#ffffff', 'stroke-width': 2, 'stroke-linecap': 'round' }),
    );
    group!.appendChild(el('circle', { cx: spec.x, cy: spec.y + 4.5, r: 1.3, fill: '#ffffff' }));
  });
}

const MARQUEE_BOX_GROUP_ID = 'marquee-box-group';
const MARQUEE_HL_GROUP_ID = 'marquee-hl-group';

/** The dashed rectangle drawn live while shift-dragging a multi-note selection. */
export function renderMarqueeBox(svg: SVGSVGElement | null, box: { x0: number; y0: number; x1: number; y1: number } | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${MARQUEE_BOX_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', MARQUEE_BOX_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!box) return;
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  const w = Math.abs(box.x1 - box.x0);
  const h = Math.abs(box.y1 - box.y0);
  group.appendChild(
    el('rect', {
      x,
      y,
      width: w,
      height: h,
      fill: 'rgba(47, 111, 237, 0.10)',
      stroke: '#2f6fed',
      'stroke-width': 1,
      'stroke-dasharray': '4 3',
    }),
  );
}

const CHORD_SNAP_GUIDE_GROUP_ID = 'chord-snap-guide-group';

/**
 * A vertical dashed line spanning from the chord band down through the
 * staff, shown live while dragging a chord symbol onto whichever note's
 * beat it will actually attach to (see StaffEditor's chord-drag snapping) —
 * makes the otherwise-invisible "which note is this chord governing for
 * scale-degree purposes" alignment visible while the user drags, instead of
 * only being able to tell after the fact from a mislabeled degree.
 */
export function renderChordSnapGuide(svg: SVGSVGElement | null, guide: { x: number; y0: number; y1: number } | null): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${CHORD_SNAP_GUIDE_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', CHORD_SNAP_GUIDE_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  if (!guide) return;
  group.appendChild(
    el('line', {
      x1: guide.x,
      y1: guide.y0,
      x2: guide.x,
      y2: guide.y1,
      stroke: '#2f9e44',
      'stroke-width': 1.5,
      'stroke-dasharray': '5 4',
      opacity: 0.85,
    }),
  );
}

/** Persistent blue highlight blobs over each marquee-selected notehead (or chord symbol, with a wider rx/ry). */
export function renderMarqueeHighlights(svg: SVGSVGElement | null, spots: { x: number; y: number; rx?: number; ry?: number }[]): void {
  if (!svg) return;
  let group = svg.querySelector<SVGGElement>(`#${MARQUEE_HL_GROUP_ID}`);
  if (!group) {
    group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('id', MARQUEE_HL_GROUP_ID);
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);
  }
  group.replaceChildren();
  spots.forEach((s) => {
    group!.appendChild(el('ellipse', { cx: s.x, cy: s.y, rx: s.rx ?? 9, ry: s.ry ?? 7, fill: 'rgba(47, 111, 237, 0.35)' }));
  });
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
