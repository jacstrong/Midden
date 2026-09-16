import { attackHits, TACTICS } from '@midden/core';
import { useUiStore } from '../store/useUiStore';
import { useFilteredEvents } from '../lib/selectors';

export function MatrixView() {
  const events = useFilteredEvents();
  const { matrixOnly, setMatrixOnly } = useUiStore();
  const hits = attackHits(events);
  const observed = Object.keys(hits.techniques).length;
  const tacticsHit = TACTICS.filter((t) => hits.tactics[t.id]).length;
  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button className={matrixOnly ? '' : 'on'} onClick={() => setMatrixOnly(false)}>
            Full matrix
          </button>
          <button className={matrixOnly ? 'on' : ''} onClick={() => setMatrixOnly(true)}>
            Observed only
          </button>
        </div>
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {observed} TECHNIQUES OBSERVED ACROSS {tacticsHit} TACTICS
        </span>
      </div>
      <div className="matrix">
        {TACTICS.map((t) => {
          const cells = t.tech.filter((p) => !matrixOnly || hits.techniques[p[0]]);
          return (
            <div key={t.id} className="mcol">
              <h5 style={{ color: t.color }}>
                {t.name}
                {hits.tactics[t.id] && (
                  <span style={{ float: 'right', color: 'var(--mg)' }}>{hits.tactics[t.id]}</span>
                )}
              </h5>
              {cells.length ? (
                cells.map((p) => {
                  const n = hits.techniques[p[0]];
                  return (
                    <div
                      key={p[0]}
                      className={'mcell' + (n ? ' hit' : '')}
                      title={`${p[0]} ${p[1]}`}
                    >
                      {n && <span className="c">{n}</span>}
                      <b>{p[0]}</b>
                      {p[1]}
                    </div>
                  );
                })
              ) : (
                <div className="mcell" style={{ opacity: 0.35 }}>
                  —
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
