import type { ReactNode } from 'react';
import { STAGES, type Severity } from '../../ui/model';
import { fileUrl, staffToken, type ApiError } from '../api';

export function Page({
  title,
  eyebrow,
  aside,
  children,
}: {
  title: string;
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Problem({ error, retry }: { error: ApiError; retry?: () => void }) {
  const signedOut = error.status === 401 || error.status === 403;
  return (
    <div className="card" role="alert">
      <h2>Could not load this page</h2>
      <p className="muted">{error.message}</p>
      {signedOut ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            staffToken.set(null);
            location.reload();
          }}
        >
          Sign in again
        </button>
      ) : (
        retry && (
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        )
      )}
    </div>
  );
}

export const Loading = () => (
  <p className="empty" role="status">
    Loading…
  </p>
);

export const stageLabel = (key: string): string => STAGES.find((s) => s.key === key)?.label ?? key;
export const vehicleTitle = (v: {
  modelYear?: number | null;
  make: string;
  model: string;
}): string => [v.modelYear, v.make, v.model].filter(Boolean).join(' ');

// Staff evidence files: fetched with the sign-in and shown as blob URLs.
export const staffFile = (evidenceId: string): Promise<string> =>
  fileUrl(`/api/evidence/${evidenceId}/file`, 'staff');

export const SEVERITY_CHOICES: { key: Severity; label: string; hint: string }[] = [
  { key: 'critical', label: 'Critical', hint: 'Safety risk' },
  { key: 'moderate', label: 'Moderate', hint: 'Wearing, do soon' },
  { key: 'minor', label: 'Minor', hint: 'Not urgent' },
];

export function SeverityPicker({
  value,
  onChange,
}: {
  value: Severity;
  onChange: (v: Severity) => void;
}) {
  return (
    <div className="sev-pick" role="radiogroup" aria-label="Severity">
      {SEVERITY_CHOICES.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={value === c.key}
          className={`sev-opt sev-${c.key} ${value === c.key ? 'on' : ''}`}
          onClick={() => onChange(c.key)}
        >
          <i aria-hidden="true" />
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : 'Something went wrong. Please try again.';
