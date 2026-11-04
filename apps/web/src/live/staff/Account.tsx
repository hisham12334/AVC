import { useState } from 'react';
import { api } from '../api';
import { Field, Page, messageOf } from './common';

// Change-password form. With `forced` it is the only screen a new or reset account can reach.
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const mismatch = form.again !== '' && form.next !== form.again;

  const body = (
    <form
      className={forced ? 'form' : 'card form'}
      onSubmit={async (e) => {
        e.preventDefault();
        if (mismatch) return;
        setBusy(true);
        setMessage(null);
        try {
          await api('/api/auth/password', {
            method: 'POST',
            staff: true,
            body: { currentPassword: form.current, newPassword: form.next },
          });
          setForm({ current: '', next: '', again: '' });
          setMessage({ ok: true, text: 'Password changed. Other devices have been signed out.' });
          onDone();
        } catch (err) {
          setMessage({ ok: false, text: messageOf(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{forced ? 'Choose your own password' : 'Change password'}</h2>
      {forced && (
        <p className="muted">You signed in with a temporary password. Set a new one to continue.</p>
      )}
      <Field label="Current password">
        <input
          type="password"
          required
          autoComplete="current-password"
          value={form.current}
          onChange={(e) => setForm({ ...form, current: e.target.value })}
        />
      </Field>
      <Field label="New password" hint="At least 10 characters.">
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={form.next}
          onChange={(e) => setForm({ ...form, next: e.target.value })}
        />
      </Field>
      <Field label="New password again">
        <input
          type="password"
          required
          autoComplete="new-password"
          value={form.again}
          onChange={(e) => setForm({ ...form, again: e.target.value })}
          aria-invalid={mismatch}
        />
      </Field>
      {mismatch && <p className="note warn">The two passwords do not match.</p>}
      {message && (
        <p className={message.ok ? 'banner' : 'banner banner-critical'} role="alert">
          {message.text}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={busy || mismatch}>
        {busy ? 'Saving…' : 'Save password'}
      </button>
    </form>
  );
  return forced ? (
    <div className="gate">
      <div className="card gate-card">{body}</div>
    </div>
  ) : (
    <Page title="Account" eyebrow="Security">
      {body}
    </Page>
  );
}
