import { useToasts } from '../store/useToasts';

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div id="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={'toast' + (t.kind === 'info' ? '' : ' ' + t.kind)}
          data-testid="toast"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
