import { useEffect, useState } from 'react';
import { definedKeys, type Op } from '@midden/core';
import { api, ApiError, type OpHistoryItem } from '../lib/api';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';

function describe(op: Op, state: ReturnType<typeof useCaseStore.getState>['state']): string {
  const hostName = (id: string): string => state.hosts[id]?.name ?? id;
  const eventName = (id: string): string =>
    state.events[id]?.activity || state.events[id]?.indicator || id;
  switch (op.type) {
    case 'case.set':
      return `Case details: ${definedKeys(op.patch).join(', ')}`;
    case 'host.add':
      return `Added host ${op.host.name}`;
    case 'host.set':
      return `Host ${hostName(op.id)}: ${definedKeys(op.patch).join(', ')}`;
    case 'host.remove':
      return `Removed host ${hostName(op.id)}`;
    case 'event.add':
      return `Added event "${(op.event.activity || op.event.indicator || '').slice(0, 60)}"`;
    case 'event.set':
      return `Event "${eventName(op.id).slice(0, 40)}": ${definedKeys(op.patch).join(', ')}`;
    case 'event.remove':
      return `Removed event ${eventName(op.id).slice(0, 40)}`;
    case 'scan.add':
      return `Added scan ${op.scan.name}`;
    case 'scan.set':
      return `Scan ${op.id}: ${definedKeys(op.patch).join(', ')}`;
    case 'scan.remove':
      return `Removed scan ${op.id}`;
    case 'link.set':
      return `Linked ${hostName(op.hostId)} to ${op.ip}`;
    case 'link.remove':
      return `Unlinked ${hostName(op.hostId)} from ${op.ip}`;
    case 'attachment.add':
      return `Attached ${op.att.name}`;
    case 'attachment.remove':
      return `Removed attachment ${op.id}`;
    case 'batch':
      return `Batch of ${op.ops.length}: ${[...new Set(op.ops.map((o) => o.type))].join(', ')}`;
    case 'op.revert':
      return `Reverted change #${op.targetSeq}`;
    case 'noop':
      return 'No change';
  }
}

function values(op: Op): Record<string, unknown> | null {
  if (
    op.type === 'host.set' ||
    op.type === 'event.set' ||
    op.type === 'case.set' ||
    op.type === 'scan.set'
  )
    return op.patch as Record<string, unknown>;
  return null;
}

export function HistoryView() {
  const caseId = useCaseStore((s) => s.caseId);
  const seq = useCaseStore((s) => s.seq);
  const state = useCaseStore((s) => s.state);
  const access = useCaseStore((s) => s.access);
  const confirm = useUiStore((s) => s.confirm);
  const [items, setItems] = useState<OpHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const [olderThan, setOlderThan] = useState<number | null>(null);

  useEffect(() => {
    if (!caseId) return;
    let alive = true;
    api<{ ops: OpHistoryItem[]; seq: number }>(
      'GET',
      `/api/cases/${caseId}/ops?limit=100${olderThan ? `&before=${olderThan}` : ''}`,
    )
      .then((r) => {
        if (!alive) return;
        const page = [...r.ops].reverse();
        setItems((cur) => (olderThan ? [...cur, ...page] : page));
        setHasMore(page.length === 100);
      })
      .catch((err: unknown) =>
        toast(err instanceof ApiError ? err.message : 'Could not load history', 'bad'),
      );
    return () => {
      alive = false;
    };
  }, [caseId, seq, olderThan]);

  const revert = (it: OpHistoryItem): void => {
    confirm(
      'Revert change',
      `Undo #${it.seq} by ${it.actor.name} (${describe(it.op, state)})? This adds a new change that reverses it.`,
      'Revert',
      () => {
        void api('POST', `/api/cases/${caseId}/revert`, { seq: it.seq })
          .then(() => toast(`Reverted #${it.seq}`))
          .catch((err: unknown) =>
            toast(err instanceof ApiError ? err.message : 'Revert failed', 'bad'),
          );
      },
    );
  };

  return (
    <>
      <div className="toolbar">
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {items.length ? `${items.length} OF ${seq} CHANGES · NEWEST FIRST` : 'NO CHANGES YET'}
        </span>
        <span className="sp" />
        <a className="btn ghost" href={`/api/cases/${caseId}/ops?format=csv&limit=2000`} download>
          Export .csv
        </a>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>#</th>
            <th>When (UTC)</th>
            <th>Who</th>
            <th>Change</th>
            <th>Before → after</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const after = values(it.op);
            const before = it.inverse ? values(it.inverse) : null;
            return (
              <tr key={it.seq} style={{ cursor: 'default' }} data-testid="history-row">
                <td className="num">{it.seq}</td>
                <td className="ts">{it.ts.replace('T', ' ').slice(0, 19)}</td>
                <td>
                  <span className="usr">{it.actor.name}</span>
                </td>
                <td className="tw">
                  <div className="wrap">{describe(it.op, state)}</div>
                </td>
                <td className="tw">
                  {after && (
                    <dl className="kv" style={{ fontSize: 10.5 }}>
                      {Object.keys(after).map((k) => (
                        <div key={k} style={{ display: 'contents' }}>
                          <dt>{k}</dt>
                          <dd>
                            {before && k in before && (
                              <>
                                <s style={{ color: 'var(--dimmer)' }}>{String(before[k] ?? '')}</s>{' '}
                                →{' '}
                              </>
                            )}
                            {String(after[k] ?? '')}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
                <td>
                  {access.edit && it.inverse && it.type !== 'noop' && (
                    <button
                      className="btn sm ghost"
                      onClick={() => revert(it)}
                      data-testid="revert"
                    >
                      Revert
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && (
        <div style={{ padding: 12, textAlign: 'center' }}>
          <button className="btn ghost" onClick={() => setOlderThan(items[items.length - 1]!.seq)}>
            Load older
          </button>
        </div>
      )}
    </>
  );
}
