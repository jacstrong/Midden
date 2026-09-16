import { useEffect, useRef, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose: () => void;
  narrow?: boolean | undefined;
  head?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}

export function Modal({ title, onClose, narrow, head, children, foot }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus synchronously on mount. A delayed focus would steal the caret from a field the
    // user has already moved to, so their typing lands in the wrong box.
    ref.current?.querySelector<HTMLElement>('input,select,textarea')?.focus();
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-testid="overlay"
    >
      <div
        className={'modal' + (narrow ? ' narrow' : '')}
        ref={ref}
        role="dialog"
        aria-label={title}
      >
        <div className="mhead">
          <h3>{title}</h3>
          {head}
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mbody">{children}</div>
        {foot && <div className="mfoot">{foot}</div>}
      </div>
    </div>
  );
}

export interface ConfirmProps {
  title: string;
  message: string;
  okLabel: string;
  danger?: boolean | undefined;
  onOk: () => void;
  onClose: () => void;
}

export function ConfirmModal({ title, message, okLabel, danger, onOk, onClose }: ConfirmProps) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="alertdialog" aria-label={title}>
        <div className="mhead">
          <h3>{title}</h3>
        </div>
        <div className="mbody">
          <p style={{ margin: 0, color: 'var(--ink)', lineHeight: 1.7 }}>{message}</p>
        </div>
        <div className="mfoot">
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={'btn ' + (danger ? 'mag' : 'pri')}
            autoFocus
            onClick={() => {
              onClose();
              onOk();
            }}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
