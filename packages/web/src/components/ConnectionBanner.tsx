import { useCaseStore } from '../store/useCaseStore';

export function ConnectionBanner() {
  const connection = useCaseStore((s) => s.connection);
  const access = useCaseStore((s) => s.access);
  if (connection === 'offline')
    return (
      <div className="banner bad" data-testid="banner-offline">
        Connection lost — reconnecting. Changes are blocked until the case is back online.
      </div>
    );
  if (connection === 'connecting')
    return (
      <div className="banner warn" data-testid="banner-connecting">
        Connecting to the case…
      </div>
    );
  if (!access.edit)
    return (
      <div className="banner warn" data-testid="banner-readonly">
        View only — you do not have edit access to this case.
      </div>
    );
  return null;
}
