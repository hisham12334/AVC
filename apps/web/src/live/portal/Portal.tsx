import { useEffect, useState } from 'react';
import { STAGES } from '../../ui/model';
import { Icon } from '../../ui/ui';
import { api, ApiError, customerToken, useApi, type ApiPortalMe } from '../api';
import { BillScreen, PortalJobTracker } from '../LiveTrack';
import { Field, messageOf } from '../staff/common';

function useHash(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Bar({ active }: { active: 'home' | 'users' | '' }) {
  return (
    <header className="pbar no-print">
      <a href="#/" className="pbar-brand">
        <span className="brand-mark">AVC</span>
        <strong>My AVC</strong>
      </a>
      <nav aria-label="Profile">
        <a href="#/" className={active === 'home' ? 'on' : ''}>
          My cars
        </a>
        <a href="#/users" className={active === 'users' ? 'on' : ''}>
          Users
        </a>
      </nav>
    </header>
  );
}

function Login({ onDone, notice }: { onDone: () => void; notice?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="gate">
      <form
        className="card gate-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ token: string }>('/api/portal/login', {
              method: 'POST',
              body: { email, password },
            });
            customerToken.set(r.token);
            onDone();
          } catch (err) {
            setError(messageOf(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="brand-mark">AVC</span>
        <h1>Sign in to your profile</h1>
        {notice && <p className="muted">{notice}</p>}
        <p className="muted small">
          Use the email you gave AVC. Your starting password is your mobile number. You can change
          it after you sign in.
        </p>
        <Field label="Email">
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <p className="banner banner-critical" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const customerStage = (key: string) => STAGES.find((s) => s.key === key)?.customerLabel ?? key;

function Home({ onExpired }: { onExpired: () => void }) {
  const { state, reload } = useApi(
    () => api<ApiPortalMe>('/api/portal/me', { auth: 'customer' }),
    'me',
    30_000,
  );
  useEffect(() => {
    if (state.kind === 'error' && state.error.status === 401) onExpired();
  }, [state, onExpired]);
  if (state.kind === 'loading') return <p className="empty p-pad">Loading your profile…</p>;
  if (state.kind === 'error')
    return (
      <div className="p-pad">
        <p className="banner banner-critical" role="alert">
          {state.error.message}{' '}
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </p>
      </div>
    );
  const { customer, vehicles, jobs } = state.data;
  const active = jobs.filter((j) => j.stage !== 'delivered');
  const past = jobs.filter((j) => j.stage === 'delivered');
  return (
    <main className="p-pad">
      <h1>Hello, {customer.fullName.split(' ')[0]}</h1>
      {customer.passwordIsDefault && (
        <p
          className="banner"
          style={{ background: 'var(--yellow-tint)', color: 'var(--yellow-ink)' }}
        >
          <Icon name="lock" size={16} /> Your password is still your mobile number.{' '}
          <a href="#/users" className="link">
            Change it
          </a>
        </p>
      )}
      <h2 className="mini">In our care</h2>
      {active.length === 0 && <p className="empty">None of your cars are with us right now.</p>}
      <ul className="queue">
        {active.map((j) => (
          <li key={j.id}>
            <a href={`#/job/${j.id}`} className={`qcard ${j.awaitingYou ? 'hot' : ''}`}>
              <div className="qcard-top">
                <strong>
                  {j.make} {j.model} · {j.licensePlate ?? ''}
                </strong>
                <span className="muted small">AVC-{j.jobNumber}</span>
              </div>
              <div className="qcard-foot">
                <span className="chip">{customerStage(j.stage)}</span>
                {j.awaitingYou && (
                  <span className="sev sev-moderate">
                    <i />
                    Needs your decision
                  </span>
                )}
                <span className="qcard-go">
                  Open <Icon name="arrow" size={14} />
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>
      {past.length > 0 && (
        <>
          <h2 className="mini">Past visits</h2>
          <ul className="queue">
            {past.map((j) => (
              <li key={j.id}>
                <a href={`#/job/${j.id}`} className="qcard">
                  <div className="qcard-top">
                    <strong>
                      {j.make} {j.model}
                    </strong>
                    <span className="muted small">
                      {new Date(j.updatedAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2 className="mini">My cars</h2>
      <ul className="mini-list">
        {vehicles.map((v) => (
          <li key={v.id}>
            {[v.modelYear, v.make, v.model].filter(Boolean).join(' ')}
            {v.licensePlate ? ` · ${v.licensePlate}` : ''}
          </li>
        ))}
      </ul>
    </main>
  );
}

function Users({ onSignOut }: { onSignOut: () => void }) {
  const { state, reload } = useApi(
    () => api<ApiPortalMe>('/api/portal/me', { auth: 'customer' }),
    'me-users',
  );
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (state.kind !== 'ready') return <p className="empty p-pad">Loading…</p>;
  const { customer } = state.data;
  const mismatch = form.again !== '' && form.next !== form.again;
  return (
    <main className="p-pad">
      <h1>Users</h1>
      <section className="card">
        <h2>Your details</h2>
        <dl className="dl">
          <div>
            <dt>Name</dt>
            <dd>{customer.fullName}</dd>
          </div>
          <div>
            <dt>Email (your username)</dt>
            <dd>{customer.email}</dd>
          </div>
          <div>
            <dt>Mobile</dt>
            <dd>{customer.mobileNumber}</dd>
          </div>
        </dl>
      </section>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage(null);
          try {
            await api('/api/portal/password', {
              method: 'POST',
              auth: 'customer',
              body: { currentPassword: form.current, newPassword: form.next },
            });
            setForm({ current: '', next: '', again: '' });
            setMessage({ ok: true, text: 'Password changed. Other devices have been signed out.' });
            reload();
          } catch (err) {
            setMessage({
              ok: false,
              text:
                err instanceof ApiError && err.code === 'VALIDATION_ERROR'
                  ? 'Use at least 8 characters.'
                  : messageOf(err),
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>Change password</h2>
        {customer.passwordIsDefault && (
          <p className="muted small">Your current password is the mobile number you gave AVC.</p>
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
        <Field label="New password" hint="At least 8 characters, and not your phone number.">
          <input
            type="password"
            required
            minLength={8}
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
          <p
            className={message.ok ? 'banner' : 'banner banner-critical'}
            role="alert"
            style={
              message.ok ? { background: 'var(--blue-tint)', color: 'var(--blue-ink)' } : undefined
            }
          >
            {message.text}
          </p>
        )}
        <button
          type="submit"
          className="btn primary"
          disabled={busy || mismatch || form.next.length < 8}
        >
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
      <button type="button" className="btn ghost" onClick={onSignOut}>
        Sign out
      </button>
    </main>
  );
}

export default function PortalApp() {
  const [signedIn, setSignedIn] = useState(() => !!customerToken.get());
  const [expired, setExpired] = useState(false);
  const [section, id] = useHash();
  if (!signedIn)
    return (
      <Login
        notice={expired ? 'Your session ended. Please sign in again.' : undefined}
        onDone={() => {
          setExpired(false);
          setSignedIn(true);
        }}
      />
    );
  const signOut = () => {
    void api('/api/portal/logout', { method: 'POST', auth: 'customer' }).catch(() => undefined);
    customerToken.set(null);
    setSignedIn(false);
  };
  const expire = () => {
    customerToken.set(null);
    setExpired(true);
    setSignedIn(false);
  };

  if (section === 'job' && id)
    return (
      <>
        <Bar active="" />
        <PortalJobTracker jobId={id} />
      </>
    );
  if (section === 'bill' && id)
    return (
      <>
        <Bar active="" />
        <BillScreen path={`/api/portal/jobs/${id}/bill`} auth="customer" back={`#/job/${id}`} />
      </>
    );
  return (
    <>
      <Bar active={section === 'users' ? 'users' : 'home'} />
      {section === 'users' ? <Users onSignOut={signOut} /> : <Home onExpired={expire} />}
    </>
  );
}
