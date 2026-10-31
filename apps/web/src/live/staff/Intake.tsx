import { useEffect, useState } from 'react';
import { type Photo, PhotoPicker, Qr } from '../../ui/evidence';
import { Card, Icon } from '../../ui/ui';
import { api, uploadEvidence, type ApiCustomer, type ApiVehicle } from '../api';
import { Field, Page, messageOf, vehicleTitle } from './common';

type Step = 'customer' | 'vehicle' | 'job' | 'done';
type Created = {
  jobId: string;
  jobNumber: string;
  stage: string;
  version: number;
  arrival: 'pickup' | 'walk_in';
  link: string | null;
  customer: ApiCustomer;
  vehicle: ApiVehicle;
};

const SOURCES = [
  ['google', 'Google'],
  ['meta', 'Instagram / Facebook'],
  ['referral', 'Referral'],
  ['partner', 'Partner studio'],
  ['repeat', 'Repeat customer'],
  ['walk_in', 'Walk-in'],
  ['other', 'Other'],
] as const;
const CORNERS = ['Front left', 'Front right', 'Rear left', 'Rear right'];

// Everything the advisor or workshop captures once: the customer, their car, and why they came.
// The customer gets a profile with a QR/link, which is what they use to follow their car.
export function Intake() {
  const [step, setStep] = useState<Step>('customer');
  const [customer, setCustomer] = useState<ApiCustomer | null>(null);
  const [profileLink, setProfileLink] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState<ApiVehicle | null>(null);
  const [done, setDone] = useState<Created | null>(null);

  const reset = () => {
    setStep('customer');
    setCustomer(null);
    setProfileLink(null);
    setVehicle(null);
    setDone(null);
  };
  const steps: [Step, string][] = [
    ['customer', 'Customer'],
    ['vehicle', 'Vehicle'],
    ['job', 'Visit'],
    ['done', 'QR & photos'],
  ];
  const at = steps.findIndex(([k]) => k === step);

  return (
    <Page title="New intake" eyebrow="Customer, vehicle and visit">
      <ol className="steps" aria-label="Intake steps">
        {steps.map(([k, label], i) => (
          <li key={k} className={i < at ? 'done' : i === at ? 'now' : ''}>
            <span>{i < at ? <Icon name="check" size={12} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {step === 'customer' && (
        <CustomerStep
          onPick={(c, link) => {
            setCustomer(c);
            setProfileLink(link);
            setStep('vehicle');
          }}
        />
      )}
      {step === 'vehicle' && customer && (
        <VehicleStep
          customer={customer}
          onBack={() => setStep('customer')}
          onPick={(v) => {
            setVehicle(v);
            setStep('job');
          }}
        />
      )}
      {step === 'job' && customer && vehicle && (
        <JobStep
          customer={customer}
          vehicle={vehicle}
          profileLink={profileLink}
          onBack={() => setStep('vehicle')}
          onCreated={(c) => {
            setDone(c);
            setStep('done');
          }}
        />
      )}
      {step === 'done' && done && <DoneStep created={done} onAnother={reset} />}
    </Page>
  );
}

function CustomerStep({ onPick }: { onPick: (c: ApiCustomer, link: string | null) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ApiCustomer[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ fullName: '', mobileNumber: '', email: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api<{ customers: ApiCustomer[] }>(
        `/api/customers?query=${encodeURIComponent(query.trim())}`,
        {
          staff: true,
        },
      )
        .then((r) => setResults(r.customers))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="grid-2 even">
      <Card title="Find an existing customer">
        <Field label="Name, mobile or email">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Start typing…"
            autoFocus
          />
        </Field>
        {results && results.length === 0 && (
          <p className="empty">No match. Add them on the right.</p>
        )}
        <ul className="pick">
          {results?.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onPick(c, null)}>
                <strong>{c.fullName}</strong>
                <span className="muted">
                  {c.mobileNumber}
                  {c.email ? ` · ${c.email}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="New customer">
        {!creating ? (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} /> Add a new customer
          </button>
        ) : (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const r = await api<{
                  customer: ApiCustomer;
                  profileLink: { path: string };
                }>('/api/customers', {
                  method: 'POST',
                  staff: true,
                  body: { ...form, email: form.email.trim() },
                });
                onPick(r.customer, `${location.origin}${r.profileLink.path}`);
              } catch (err) {
                setError(messageOf(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Full name">
              <input
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
            </Field>
            <Field label="Mobile number" hint="Also the customer's starting password.">
              <input
                required
                inputMode="tel"
                value={form.mobileNumber}
                onChange={(e) => setForm({ ...form, mobileNumber: e.target.value })}
              />
            </Field>
            <Field label="Email" hint="The customer's username for their profile.">
              <input
                required
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            {error && (
              <p className="banner banner-critical" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : 'Create profile and continue'}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

function VehicleStep({
  customer,
  onPick,
  onBack,
}: {
  customer: ApiCustomer;
  onPick: (v: ApiVehicle) => void;
  onBack: () => void;
}) {
  const [vehicles, setVehicles] = useState<ApiVehicle[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    licensePlate: '',
    vin: '',
    make: '',
    model: '',
    modelYear: '',
    color: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ vehicles: ApiVehicle[] }>(`/api/customers/${customer.id}/vehicles`, { staff: true })
      .then((r) => {
        setVehicles(r.vehicles);
        if (r.vehicles.length === 0) setAdding(true);
      })
      .catch(() => setVehicles([]));
  }, [customer.id]);

  return (
    <div className="grid-2 even">
      <Card title={`${customer.fullName}'s cars`}>
        {vehicles === null && <p className="empty">Loading…</p>}
        {vehicles?.length === 0 && <p className="empty">No cars saved yet.</p>}
        <ul className="pick">
          {vehicles?.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => onPick(v)}>
                <strong>{vehicleTitle(v)}</strong>
                <span className="muted">
                  {v.licensePlate ?? 'No plate'}
                  {v.color ? ` · ${v.color}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn ghost" onClick={onBack}>
          ← Change customer
        </button>
      </Card>
      <Card title="Add a car">
        {!adding ? (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} /> Add a car
          </button>
        ) : (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!form.licensePlate.trim() && !form.vin.trim()) {
                setError('Enter the plate or the VIN.');
                return;
              }
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ vehicle: ApiVehicle }>('/api/vehicles', {
                  method: 'POST',
                  staff: true,
                  body: {
                    customerId: customer.id,
                    make: form.make,
                    model: form.model,
                    ...(form.licensePlate.trim() && { licensePlate: form.licensePlate.trim() }),
                    ...(form.vin.trim() && { vin: form.vin.trim() }),
                    ...(form.modelYear && { modelYear: Number(form.modelYear) }),
                    ...(form.color.trim() && { color: form.color.trim() }),
                  },
                });
                onPick(r.vehicle);
              } catch (err) {
                setError(messageOf(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="row">
              <Field label="Plate">
                <input
                  value={form.licensePlate}
                  onChange={(e) => setForm({ ...form, licensePlate: e.target.value })}
                />
              </Field>
              <Field label="VIN (optional)">
                <input
                  value={form.vin}
                  onChange={(e) => setForm({ ...form, vin: e.target.value })}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Make">
                <input
                  required
                  value={form.make}
                  onChange={(e) => setForm({ ...form, make: e.target.value })}
                />
              </Field>
              <Field label="Model">
                <input
                  required
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Year">
                <input
                  inputMode="numeric"
                  value={form.modelYear}
                  onChange={(e) => setForm({ ...form, modelYear: e.target.value })}
                />
              </Field>
              <Field label="Colour">
                <input
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </Field>
            </div>
            {error && (
              <p className="banner banner-critical" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save car and continue'}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

function JobStep({
  customer,
  vehicle,
  profileLink,
  onBack,
  onCreated,
}: {
  customer: ApiCustomer;
  vehicle: ApiVehicle;
  profileLink: string | null;
  onBack: () => void;
  onCreated: (c: Created) => void;
}) {
  const [form, setForm] = useState({
    mileageKm: '',
    intakeCondition: '',
    arrival: 'walk_in' as 'walk_in' | 'pickup',
    returnMethod: 'collect' as 'collect' | 'delivery',
    leadSource: '',
    address: '',
    phone: customer.mobileNumber,
    window: '',
    driver: '',
    notes: '',
  });
  const [drivers, setDrivers] = useState<{ id: string; displayName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ drivers: { id: string; displayName: string }[] }>('/api/staff/drivers', { staff: true })
      .then((r) => setDrivers(r.drivers))
      .catch(() => setDrivers([]));
  }, []);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm({ ...form, [k]: v });

  return (
    <Card title={`${vehicleTitle(vehicle)} · ${vehicle.licensePlate ?? 'No plate'}`}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{
              job: { id: string; jobNumber: string | number; workStage: string; version: number };
            }>('/api/jobs/intake', {
              method: 'POST',
              staff: true,
              body: {
                customerId: customer.id,
                vehicleId: vehicle.id,
                mileageKm: Number(form.mileageKm),
                intakeCondition: form.intakeCondition,
                arrivalMethod: form.arrival,
                returnMethod: form.returnMethod,
                ...(form.leadSource && { leadSource: form.leadSource }),
                ...(form.arrival === 'pickup' && {
                  pickup: {
                    address: form.address,
                    contactPhone: form.phone || undefined,
                    windowStart: form.window ? new Date(form.window).toISOString() : undefined,
                    notes: form.notes,
                    driverStaffId: form.driver || undefined,
                  },
                }),
              },
            });
            onCreated({
              jobId: r.job.id,
              jobNumber: String(r.job.jobNumber),
              stage: r.job.workStage,
              version: r.job.version,
              arrival: form.arrival,
              link: profileLink,
              customer,
              vehicle,
            });
          } catch (err) {
            setError(messageOf(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="seg-field">
          <legend>How is the car arriving?</legend>
          <div className="seg" role="radiogroup">
            {(
              [
                ['walk_in', 'Customer brings it'],
                ['pickup', 'Concierge pickup'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={form.arrival === k}
                className={form.arrival === k ? 'on' : ''}
                onClick={() => {
                  set('arrival', k);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {form.arrival === 'pickup' && (
          <div className="subform">
            <Field label="Pickup address">
              <input
                required
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
              />
            </Field>
            <div className="row">
              <Field label="Contact phone">
                <input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="Pickup time">
                <input
                  type="datetime-local"
                  value={form.window}
                  onChange={(e) => set('window', e.target.value)}
                />
              </Field>
            </div>
            <div className="row">
              <Field label="Driver">
                <select value={form.driver} onChange={(e) => set('driver', e.target.value)}>
                  <option value="">Assign later</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notes for the driver">
                <input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>
          </div>
        )}

        <div className="row">
          <Field label="Mileage (km)">
            <input
              required
              inputMode="numeric"
              pattern="[0-9]*"
              value={form.mileageKm}
              onChange={(e) => set('mileageKm', e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label="How did they find us?">
            <select value={form.leadSource} onChange={(e) => set('leadSource', e.target.value)}>
              <option value="">Not asked</option>
              {SOURCES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="What does the customer want done, and what is the car's condition?">
          <textarea
            required
            rows={4}
            value={form.intakeCondition}
            onChange={(e) => set('intakeCondition', e.target.value)}
            placeholder="Reported concern, existing scratches or dents, warning lights…"
          />
        </Field>
        <fieldset className="seg-field">
          <legend>How will the car go back?</legend>
          <div className="seg" role="radiogroup">
            {(
              [
                ['collect', 'Customer collects'],
                ['delivery', 'We deliver'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={form.returnMethod === k}
                className={form.returnMethod === k ? 'on' : ''}
                onClick={() => set('returnMethod', k)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="banner banner-critical" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onBack}>
            ← Back
          </button>
          <button type="submit" className="btn primary lg" disabled={busy || !form.mileageKm}>
            {busy ? 'Creating…' : 'Create job'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function DoneStep({ created, onAnother }: { created: Created; onAnother: () => void }) {
  const [link, setLink] = useState(created.link);
  const [copied, setCopied] = useState(false);
  const [photos, setPhotos] = useState<Record<string, Photo[]>>({});
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walkIn = created.arrival === 'walk_in';

  return (
    <div className="grid-2 even">
      <Card title={`Job AVC-${created.jobNumber} created`}>
        <p className="muted">
          {created.customer.fullName} · {vehicleTitle(created.vehicle)}
        </p>
        <h3 className="mini">Customer profile</h3>
        {link ? (
          <div className="qr-block">
            <Qr value={link} />
            <div>
              <p className="muted small">
                The customer scans this to open their profile and follow the car. They can also sign
                in with their email ({created.customer.email}) and mobile number.
              </p>
              <p className="link-box">{link}</p>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
              >
                <Icon name="link" size={15} /> {copied ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" className="btn ghost" onClick={() => window.print()}>
                Print
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="muted small">
              This customer already has a profile. A new QR replaces the old one, which stops
              working.
            </p>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const r = await api<{ profileLink: { path: string } }>(
                    `/api/customers/${created.customer.id}/profile-link`,
                    { method: 'POST', staff: true },
                  );
                  setLink(`${location.origin}${r.profileLink.path}`);
                } catch (e) {
                  setError(messageOf(e));
                }
              }}
            >
              Make a new QR
            </button>
          </>
        )}
        {error && (
          <p className="banner banner-critical" role="alert">
            {error}
          </p>
        )}
      </Card>
      <Card title={walkIn ? 'Arrival photos' : 'Pickup booked'}>
        {walkIn ? (
          <>
            <p className="muted small">
              Four corner photos, taken before the car goes near a lift. They are kept as evidence
              of its condition.
            </p>
            <div className="corner-grid">
              {CORNERS.map((c) => (
                <div key={c}>
                  <strong>{c}</strong>
                  <PhotoPicker
                    single
                    label="Photo"
                    caption={`Arrival: ${c}`}
                    value={photos[c] ?? []}
                    onChange={(p) => setPhotos({ ...photos, [c]: p })}
                    upload={(file, caption) =>
                      uploadEvidence(created.jobId, file, 'photo', caption)
                    }
                  />
                </div>
              ))}
            </div>
            <div className="actions end">
              {started ? (
                <span className="sev sev-minor">
                  <i />
                  Inspection started
                </span>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  onClick={async () => {
                    try {
                      await api(`/api/jobs/${created.jobId}/commands/start-inspection`, {
                        method: 'POST',
                        staff: true,
                        body: { expectedVersion: created.version },
                      });
                      setStarted(true);
                    } catch (e) {
                      setError(messageOf(e));
                    }
                  }}
                >
                  Send to inspection
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="muted">
            The driver will photograph the car and collect the customer&rsquo;s signature at pickup.
            Once they complete it, the car appears here ready for inspection.
          </p>
        )}
        <div className="actions end">
          <a className="btn ghost" href={`#/jobs/${created.jobId}`}>
            Open job
          </a>
          <button type="button" className="btn" onClick={onAnother}>
            New intake
          </button>
        </div>
      </Card>
    </div>
  );
}
