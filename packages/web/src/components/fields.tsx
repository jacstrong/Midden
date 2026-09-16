import type { ReactNode } from 'react';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  span,
  children,
}: {
  label: string;
  htmlFor?: string | undefined;
  hint?: ReactNode;
  error?: string | undefined;
  span?: 2 | 3 | undefined;
  children: ReactNode;
}) {
  return (
    <div className={'field' + (span ? ` span${span}` : '')}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
      {error !== undefined && <div className="err">{error}</div>}
    </div>
  );
}

export function Fieldset({
  legend,
  cols,
  children,
}: {
  legend: string;
  cols: 2 | 3;
  children: ReactNode;
}) {
  return (
    <fieldset className="fs">
      <legend>{legend}</legend>
      <div className={cols === 2 ? 'grid2' : 'grid3'}>{children}</div>
    </fieldset>
  );
}

export function Datalist({ id, values }: { id: string; values: readonly string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}
