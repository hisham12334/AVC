import { useState } from 'react';
import { Icon } from '../../ui/ui';
import { api, useApi, type ApiStaffMember } from '../api';
import { Field, Loading, Page, Problem, messageOf } from './common';

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  lounge_manager: 'Lounge manager / advisor',
  workshop_manager: 'Workshop manager',
  technician: 'Technician',
  driver: 'Driver',
  finance: 'Finance',
};
const ROLES = Object.keys(ROLE_LABELS);

type Branch = { id: string; name: string };
type Revealed = { name: string; email: string; password: string };

// Staff accounts: only the super admin sees this. Creates logins, assigns roles and branches,
// resets passwords and switches people off.
export function Team({ selfId }: { selfId: string }) {
  const { state, reload } = useApi(
    () => api<{ staff: ApiStaffMember[] }>('/api/admin/staff', { staff: true }),
    'team',
  );
  const { state: branchState } = useApi(
    () => api<{ branches: Branch[] }>('/api/branches', { staff: true }),
    'team-branches',
  );
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const branches = branchState.kind === 'ready' ? branchState.data.branches : [];
  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const patch = (m: ApiStaffMember, body: Record<string, unknown>) =>
    run(async () => {
      await api(`/api/admin/staff/${m.id}`, { method: 'PATCH', staff: true, body });
    });

  if (state.kind === 'loading') return <Loading />;
  if (state.kind === 'error') return <Problem error={state.error} retry={reload} />;

  return (
    <Page title="Team" eyebrow="Super admin">
      {revealed && (
        <div className="banner" role="status">
          <p>
            <strong>{revealed.name}</strong> ({revealed.email}) signs in with this temporary
            password and must change it straight away:
          </p>
          <p>
            <code>{revealed.password}</code>{' '}
            <button type="button" className="btn ghost" onClick={() => setRevealed(null)}>
              Done
            </button>
          </p>
        </div>
      )}
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}

      <NewMember
        branches={branches}
        onCreated={(r) => {
          setRevealed(r);
          reload();
        }}
      />

      <section className="card">
        <h2>Accounts</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Branch</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.staff.map((m) => {
                const self = m.id === selfId;
                return (
                  <tr key={m.id} style={m.active ? undefined : { opacity: 0.6 }}>
                    <td>
                      <strong>{m.displayName}</strong>
                      <br />
                      <small className="muted">{m.email ?? 'No email login'}</small>
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${m.displayName}`}
                        value={m.role}
                        disabled={self}
                        onChange={(e) => void patch(m, { role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Branch for ${m.displayName}`}
                        value={m.branchId ?? ''}
                        onChange={(e) => void patch(m, { branchId: e.target.value || null })}
                      >
                        <option value="">All branches</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {m.active
                        ? m.mustChangePassword
                          ? 'Awaiting first sign-in'
                          : 'Active'
                        : 'Off'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {m.email && (
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() =>
                            void run(async () => {
                              if (!confirm(`Reset the password for ${m.displayName}?`)) return;
                              const r = await api<{ temporaryPassword: string }>(
                                `/api/admin/staff/${m.id}/reset-password`,
                                { method: 'POST', staff: true },
                              );
                              setRevealed({
                                name: m.displayName,
                                email: m.email!,
                                password: r.temporaryPassword,
                              });
                            })
                          }
                        >
                          <Icon name="lock" size={14} /> Reset
                        </button>
                      )}
                      {!self && (
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => {
                            if (
                              !confirm(
                                `Permanently delete ${m.displayName}'s account? This cannot be undone.`,
                              )
                            )
                              return;
                            void run(async () => {
                              await api(`/api/admin/staff/${m.id}`, {
                                method: 'DELETE',
                                staff: true,
                              });
                              setRevealed(null);
                            });
                          }}
                        >
                          Delete
                        </button>
                      )}
                      {!self && (
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => void patch(m, { active: !m.active })}
                        >
                          {m.active ? 'Switch off' : 'Switch on'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </Page>
  );
}

function NewMember({
  branches,
  onCreated,
}: {
  branches: Branch[];
  onCreated: (r: Revealed) => void;
}) {
  const blank = { displayName: '', email: '', role: 'technician', branchId: '' };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api<{ staff: ApiStaffMember; temporaryPassword: string }>(
            '/api/admin/staff',
            {
              method: 'POST',
              staff: true,
              body: { ...form, branchId: form.branchId || null },
            },
          );
          setForm(blank);
          onCreated({
            name: r.staff.displayName,
            email: r.staff.email ?? form.email,
            password: r.temporaryPassword,
          });
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Add a staff account</h2>
      <Field label="Full name">
        <input
          required
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
      </Field>
      <Field label="Email (their login)">
        <input
          type="email"
          required
          autoComplete="off"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field label="Role">
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Branch" hint="Pinned staff only see their own branch.">
        <select
          value={form.branchId}
          onChange={(e) => setForm({ ...form, branchId: e.target.value })}
        >
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}
