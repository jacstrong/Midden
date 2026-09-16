import type { ReactNode } from 'react';

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <b>{title}</b>
      <p>{body}</p>
      {children}
    </div>
  );
}
