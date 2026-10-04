import { visibleBox, type Box, type View } from './mapMotion';

/**
 * Labels that appear as the analyst zooms in. Whether a label fits is decided in screen pixels,
 * not raw zoom, because the fitted view of a /16 starts far smaller than a six-host lab scan.
 * Text stays the same size on screen at any zoom, and only nodes in view get a label.
 */

export interface Size {
  w: number;
  h: number;
}

/** Zoom never stops short of this many screen pixels per map unit, however big the map. */
const MAX_PX_PER_UNIT = 4;
const NAME_PX = 11;
const DETAIL_PX = 10;
const GAP_PX = 3;

/** Screen pixels per map unit at the base fit (preserveAspectRatio="xMidYMid meet"). */
function fitScale(vb: Box, size: Size): number {
  return Math.min(size.w / vb.w, size.h / vb.h);
}

/** Screen pixels per map unit once the pan and zoom are applied. */
export function pxPerUnit(vb: Box, size: Size, v: View): number {
  return v.k * fitScale(vb, size);
}

/** The scene rectangle the screen actually shows, including the margins `meet` adds. */
export function onScreen(vb: Box, size: Size, v: View): Box {
  const s = fitScale(vb, size);
  const w = size.w / s;
  const h = size.h / s;
  return visibleBox({ x: vb.x + (vb.w - w) / 2, y: vb.y + (vb.h - h) / 2, w, h }, v);
}

/** Highest zoom: the usual 9x, or more when the map is so large that 9x would leave hosts unreadable. */
export function maxZoom(vb: Box, size: Size): number {
  return Math.max(9, MAX_PX_PER_UNIT / fitScale(vb, size));
}

/** 0 = no label, 1 = short label, 2 = full label; from how far apart nodes sit on screen. */
export type LabelTier = 0 | 1 | 2;
export function labelTier(spacingPx: number, [short, full]: readonly [number, number]): LabelTier {
  return spacingPx >= full ? 2 : spacingPx >= short ? 1 : 0;
}

export interface MapLabel {
  id: string;
  x: number;
  y: number;
  /** Node radius in map units; the label sits just below it. */
  r: number;
  name: string;
  detail?: string | undefined;
}

/** Text drawn under each node in `labels` that is on screen, at a constant screen size. */
export function MapLabels({ labels, ppu, view }: { labels: MapLabel[]; ppu: number; view: Box }) {
  if (!labels.length || !(ppu > 0)) return null;
  const u = 1 / ppu;
  const margin = 60 * u;
  const inView = (l: MapLabel): boolean =>
    l.x >= view.x - margin &&
    l.x <= view.x + view.w + margin &&
    l.y >= view.y - margin &&
    l.y <= view.y + view.h + margin;
  return (
    <g pointerEvents="none" data-testid="map-labels">
      {labels.filter(inView).map((l) => {
        const y1 = l.y + l.r + (GAP_PX + NAME_PX) * u;
        return (
          <text
            key={l.id}
            x={l.x}
            y={y1}
            textAnchor="middle"
            fontSize={NAME_PX * u}
            fill="#cfdae8"
            stroke="#05070d"
            strokeWidth={3 * u}
            strokeLinejoin="round"
            paintOrder="stroke"
            data-testid="map-label"
          >
            {l.name}
            {l.detail && (
              <tspan x={l.x} dy={(GAP_PX + DETAIL_PX) * u} fontSize={DETAIL_PX * u} fill="#8593a5">
                {l.detail}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

export interface MapBadge {
  id: string;
  x: number;
  y: number;
  /** Radius to clear, in map units; the pill sits just to the right of it. */
  r: number;
  text: string;
}

const BADGE_PX = 10;
/** Rough advance of one character at BADGE_PX, enough to size the pill around its text. */
const BADGE_CHAR_PX = 6.4;

/** Count pills beside nodes in `badges` that are on screen, at a constant screen size. */
export function MapBadges({ badges, ppu, view }: { badges: MapBadge[]; ppu: number; view: Box }) {
  if (!badges.length || !(ppu > 0)) return null;
  const u = 1 / ppu;
  const h = (BADGE_PX + 6) * u;
  const margin = 120 * u;
  return (
    <g pointerEvents="none" data-testid="map-badges">
      {badges
        .filter(
          (b) =>
            b.x >= view.x - margin &&
            b.x <= view.x + view.w + margin &&
            b.y >= view.y - margin &&
            b.y <= view.y + view.h + margin,
        )
        .map((b) => {
          const x = b.x + b.r + 5 * u;
          const w = (b.text.length * BADGE_CHAR_PX + 12) * u;
          return (
            <g key={b.id} data-testid="map-badge">
              <rect
                x={x}
                y={b.y - h / 2}
                width={w}
                height={h}
                rx={h / 2}
                fill="#16324a"
                stroke="#22e8ff"
                strokeOpacity={0.55}
                strokeWidth={u}
              />
              <text
                x={x + w / 2}
                y={b.y + BADGE_PX * 0.36 * u}
                textAnchor="middle"
                fontSize={BADGE_PX * u}
                fill="#cfeef6"
              >
                {b.text}
              </text>
            </g>
          );
        })}
    </g>
  );
}
