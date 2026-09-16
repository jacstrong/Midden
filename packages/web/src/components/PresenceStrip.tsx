import { useCaseStore } from '../store/useCaseStore';
import { initials } from '../lib/format';
import { LANE_COLORS } from '@midden/core';

const colorFor = (id: string): string => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length]!;
};

export function PresenceStrip() {
  const presence = useCaseStore((s) => s.presence);
  const me = useCaseStore((s) => s.me);
  const seen = new Map<string, { name: string; views: Set<string> }>();
  for (const p of presence) {
    const e = seen.get(p.user.id) ?? { name: p.user.name, views: new Set<string>() };
    e.views.add(p.view);
    seen.set(p.user.id, e);
  }
  if (!seen.size) return null;
  return (
    <div className="presence" title="Who is in this case" data-testid="presence">
      {[...seen.entries()].map(([id, e]) => (
        <span
          key={id}
          className="avatar"
          style={{
            background: colorFor(id),
            outline: id === me?.id ? '1px solid #eaf6ff' : 'none',
          }}
          title={`${e.name} · ${[...e.views].join(', ')}`}
        >
          {initials(e.name)}
        </span>
      ))}
    </div>
  );
}
