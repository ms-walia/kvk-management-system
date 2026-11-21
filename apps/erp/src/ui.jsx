import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Load data from the API; returns [data, error, reload]. */
export function useLoad(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    if (!path) return;
    setError(null);
    api(path).then(setData).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(load, [load]);
  return [data, error, load];
}

const STATUS_LABEL = {
  requested: 'Requested', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
  issued: 'Out with farmer', returned: 'Returned', pending: 'Needs verification', verified: 'Verified', new: 'Profile incomplete',
  in: 'In stock', low: 'Low', out: 'Out of stock',
};
export const Badge = ({ s }) => <span className={`badge b-${s}`}>{STATUS_LABEL[s] || s}</span>;

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** A form whose submit calls an async action and shows its error. */
export function ActionForm({ onSubmit, submitLabel = 'Save', children, danger }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try { await onSubmit(Object.fromEntries(new FormData(e.currentTarget))); }
        catch (x) { setErr(x.message); }
        finally { setBusy(false); }
      }}
    >
      {children}
      {err && <div className="error">{err}</div>}
      <button className={danger ? 'danger' : 'primary'} disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}

export const Field = ({ label, children }) => <label className="field"><span>{label}</span>{children}</label>;

export function ErrorBox({ error }) { return error ? <div className="error">{error}</div> : null; }
export function Loading() { return <div className="muted pad">Loading…</div>; }
export function Empty({ children }) { return <div className="empty">{children}</div>; }

export function Tabs({ value, onChange, options }) {
  return (
    <div className="tabs">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'tab active' : 'tab'} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}
