import { useState } from 'react';
import { Card } from '../../ui/ui';
import { api, useApi } from '../api';
import { Loading, Page, Problem, messageOf, stageLabel } from './common';

type Followup = {
  id: string;
  kind: string;
  title: string;
  dueAt: string;
  status: string;
  customerId: string;
  customerName: string;
  mobileNumber: string;
  remindersOptIn: boolean;
  make: string;
  model: string;
  licensePlate: string | null;
  jobNumber: string;
  jobId: string;
};
type Message = {
  id: string;
  kind: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  customerName: string;
  jobNumber: string | null;
};
type TowerJob = {
  id: string;
  jobNumber: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  make: string;
  model: string;
  licensePlate: string | null;
  nextAction: string | null;
  promisedAt: string | null;
  ownerStaffId: string | null;
  needsAttention: boolean;
  ownerName: string;
  blocker: string;
  overdue: boolean;
};

const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = (value: string) =>
  new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function Followups({ canManage }: { canManage: boolean }) {
  const { state, reload } = useApi(
    () => api<{ followups: Followup[] }>('/api/engagement/followups', { staff: true }),
    'followups',
    30_000,
  );
  const messages = useApi(
    () => api<{ messages: Message[] }>('/api/engagement/messages', { staff: true }),
    'messages',
    30_000,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const update = async (id: string, body: unknown) => {
    setSaving(id);
    setError(null);
    try {
      await api(`/api/engagement/followups/${id}`, { method: 'PATCH', body, staff: true });
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(null);
    }
  };
  return (
    <Page title="Customer follow-ups" eyebrow="Repeat visits">
      <p className="muted">
        Declined work and future service reminders appear here after a car is delivered. Customers
        choose whether to receive reminder emails in their profile.
      </p>
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}
      {state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'error' ? (
        <Problem error={state.error} retry={reload} />
      ) : (
        <Card
          title={`${state.data.followups.filter((f) => f.status === 'open').length} open follow-ups`}
        >
          {state.data.followups.length === 0 ? (
            <p className="empty">No follow-ups yet.</p>
          ) : (
            <ul className="queue">
              {state.data.followups.map((f) => (
                <li className="qcard" key={f.id}>
                  <div className="qcard-top">
                    <strong>{f.title}</strong>
                    <span className="chip">{f.status}</span>
                  </div>
                  <p>
                    <a href={`#/customers/${f.customerId}`}>{f.customerName}</a> · {f.make}{' '}
                    {f.model} {f.licensePlate || ''} ·{' '}
                    <a href={`#/jobs/${f.jobId}`}>AVC-{f.jobNumber}</a>
                  </p>
                  <p className="muted small">
                    {f.kind === 'declined_work' ? 'Previously declined' : 'Next service'} · Due{' '}
                    {date(f.dueAt)} ·{' '}
                    {f.remindersOptIn ? 'Email reminders enabled' : 'Staff follow-up only'}
                  </p>
                  <div className="actions">
                    <a className="btn ghost" href={`tel:${f.mobileNumber}`}>
                      Call customer
                    </a>
                    {canManage && f.status === 'open' && (
                      <label className="field">
                        <span>Follow up on</span>
                        <input
                          key={f.dueAt}
                          type="date"
                          defaultValue={f.dueAt.slice(0, 10)}
                          onChange={(event) => {
                            if (event.target.value)
                              void update(f.id, {
                                dueAt: new Date(`${event.target.value}T09:00:00`).toISOString(),
                              });
                          }}
                        />
                      </label>
                    )}
                    {canManage && f.status === 'open' && (
                      <button
                        className="btn"
                        type="button"
                        disabled={saving === f.id}
                        onClick={() => void update(f.id, { status: 'contacted' })}
                      >
                        Mark contacted
                      </button>
                    )}
                    {canManage && f.status !== 'booked' && (
                      <button
                        className="btn primary"
                        type="button"
                        disabled={saving === f.id}
                        onClick={() => void update(f.id, { status: 'booked' })}
                      >
                        Mark booked
                      </button>
                    )}
                    {canManage && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={saving === f.id}
                        onClick={() => void update(f.id, { status: 'dismissed' })}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {messages.state.kind === 'ready' && (
        <Card title="Customer message delivery">
          <p className="muted small">
            Pending messages need the customer email delivery endpoint configured on the server.
          </p>
          {messages.state.data.messages.length === 0 ? (
            <p className="empty">No messages queued yet.</p>
          ) : (
            <ul className="mini-list">
              {messages.state.data.messages.slice(0, 30).map((m) => (
                <li key={m.id}>
                  <strong>{m.subject}</strong> · {m.customerName}{' '}
                  {m.jobNumber ? `· AVC-${m.jobNumber}` : ''} · {m.status}
                  {m.lastError && <span className="muted small"> · {m.lastError}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Page>
  );
}

export function ControlTower({ canManage }: { canManage: boolean }) {
  const { state, reload } = useApi(
    () => api<{ jobs: TowerJob[] }>('/api/control-tower', { staff: true }),
    'tower',
    20_000,
  );
  const staff = useApi(
    () =>
      api<{ staff: { id: string; displayName: string }[] }>('/api/control-tower/staff', {
        staff: true,
      }),
    'tower-staff',
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ nextAction: '', ownerStaffId: '', promisedAt: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const start = (j: TowerJob) => {
    setEditing(j.id);
    setError(null);
    setForm({
      nextAction: j.nextAction ?? '',
      ownerStaffId: j.ownerStaffId ?? '',
      promisedAt: j.promisedAt
        ? new Date(
            new Date(j.promisedAt).getTime() - new Date(j.promisedAt).getTimezoneOffset() * 60_000,
          )
            .toISOString()
            .slice(0, 16)
        : '',
    });
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/control-tower/${editing}`, {
        method: 'PATCH',
        staff: true,
        body: {
          nextAction: form.nextAction,
          ownerStaffId: form.ownerStaffId || null,
          promisedAt: form.promisedAt ? new Date(form.promisedAt).toISOString() : null,
        },
      });
      setEditing(null);
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Page title="Control tower" eyebrow="Next actions and handovers">
      <p className="muted">
        Every active car has a current blocker. Set the next action, owner and promised handover
        time so the team can act before a job becomes late.
      </p>
      {state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'error' ? (
        <Problem error={state.error} retry={reload} />
      ) : (
        <Card
          title={`${state.data.jobs.filter((j) => j.overdue).length} overdue · ${state.data.jobs.filter((j) => j.needsAttention).length} stalled · ${state.data.jobs.length} active cars`}
        >
          {state.data.jobs.length === 0 ? (
            <p className="empty">No active jobs.</p>
          ) : (
            <ul className="queue">
              {state.data.jobs.map((j) => (
                <li className={`qcard ${j.overdue || j.needsAttention ? 'hot' : ''}`} key={j.id}>
                  <div className="qcard-top">
                    <strong>
                      <a href={`#/jobs/${j.id}`}>
                        AVC-{j.jobNumber} · {j.make} {j.model}
                      </a>
                    </strong>
                    <span className="chip">{stageLabel(j.stage)}</span>
                  </div>
                  <p>
                    {j.customerName} · {j.licensePlate || 'No plate'} · {j.blocker}{' '}
                    {j.needsAttention ? '· Stalled' : ''}
                  </p>
                  <p className="muted small">
                    Owner: {j.ownerName} ·{' '}
                    {j.promisedAt
                      ? `${j.overdue ? 'Overdue since' : 'Promised'} ${dateTime(j.promisedAt)}`
                      : 'No handover time set'}{' '}
                    · Updated {date(j.updatedAt)}
                  </p>
                  {j.nextAction && (
                    <p>
                      <strong>Next:</strong> {j.nextAction}
                    </p>
                  )}
                  {editing === j.id ? (
                    <div className="form subform">
                      <label className="field">
                        <span>Next action</span>
                        <input
                          value={form.nextAction}
                          onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
                          maxLength={500}
                        />
                      </label>
                      <div className="row">
                        <label className="field">
                          <span>Owner</span>
                          <select
                            value={form.ownerStaffId}
                            onChange={(e) => setForm({ ...form, ownerStaffId: e.target.value })}
                          >
                            <option value="">Responsible advisor</option>
                            {staff.state.kind === 'ready' &&
                              staff.state.data.staff.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.displayName}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>Promised handover</span>
                          <input
                            type="datetime-local"
                            value={form.promisedAt}
                            onChange={(e) => setForm({ ...form, promisedAt: e.target.value })}
                          />
                        </label>
                      </div>
                      {error && (
                        <p className="banner banner-critical" role="alert">
                          {error}
                        </p>
                      )}
                      <div className="actions">
                        <button
                          className="btn primary"
                          type="button"
                          disabled={saving}
                          onClick={() => void save()}
                        >
                          Save plan
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : canManage ? (
                    <button className="btn ghost" type="button" onClick={() => start(j)}>
                      Set next action
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </Page>
  );
}
