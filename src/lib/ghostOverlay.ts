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
