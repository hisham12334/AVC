import { useRef, useState } from 'react';
import { type Photo, PhotoPicker, SignaturePad, type SignatureHandle } from '../../ui/evidence';
import { Card, Icon, aed } from '../../ui/ui';
import { api, uploadEvidence, useApi, type ApiTransfer } from '../api';
import { Field, Loading, Page, Problem, messageOf } from './common';

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Any time';

export function DriverLegs() {
  const { state, reload } = useApi(
    () => api<{ transfers: ApiTransfer[] }>('/api/transfers/mine', { staff: true }),
    'legs',
    20_000,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (state.kind === 'loading')
    return (
      <Page title="My trips">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="My trips">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const legs = state.data.transfers;
  return (
    <Page title="My trips" eyebrow="Pickups and deliveries">
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}
      {legs.length === 0 && <p className="empty">No trips assigned. New ones appear here.</p>}
      <ul className="queue">
        {legs.map((t) => (
          <li key={t.id}>
            <article className="qcard leg">
              <div className="qcard-top">
                <span className={`chip ${t.direction === 'pickup' ? '' : 'chip-new'}`}>
                  {t.direction === 'pickup' ? 'Pickup' : 'Delivery'}
                </span>
                <strong>{when(t.windowStart)}</strong>
              </div>
              <p className="leg-car">
                {t.make} {t.model}
                {t.color ? `, ${t.color}` : ''} · <strong>{t.licensePlate ?? 'No plate'}</strong>
              </p>
              <p className="leg-line">
                <Icon name="building" size={14} />
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.address}
                </a>
              </p>
              <p className="leg-line">
                <Icon name="phone" size={14} />
                <a href={`tel:${(t.contactPhone ?? t.customerMobile).replace(/\s/g, '')}`}>
                  {t.customerName} · {t.contactPhone ?? t.customerMobile}
                </a>
              </p>
              {t.notes && <p className="muted small">{t.notes}</p>}
              <div className="actions end">
                {t.status === 'scheduled' ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busyId === t.id}
                    onClick={async () => {
                      setBusyId(t.id);
                      setError(null);
                      try {
                        await api(`/api/transfers/${t.id}/start`, { method: 'POST', staff: true });
                        reload();
                      } catch (e) {
                        setError(messageOf(e));
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    I am on my way
                  </button>
                ) : (
                  <a className="btn primary" href={`#/legs/${t.id}`}>
                    {t.direction === 'pickup' ? 'Collected the car' : 'Delivered the car'}
                  </a>
                )}
              </div>
            </article>
          </li>
        ))}
      </ul>
    </Page>
  );
}

export function DriverComplete({ id }: { id: string }) {
  const { state, reload } = useApi(
    () => api<{ transfers: ApiTransfer[] }>('/api/transfers/mine', { staff: true }),
    `leg-${id}`,
  );
  const [photos, setPhotos] = useState<Photo[]>([]);
  const pad = useRef<SignatureHandle | null>(null);
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ stage: string; amountAed: number | null } | null>(null);

  if (state.kind === 'loading')
    return (
      <Page title="Handover">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Handover">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const leg = state.data.transfers.find((t) => t.id === id);
  if (result)
    return (
      <Page title="Done">
        <Card>
          <p
            className="banner"
            style={{ background: 'var(--blue-tint)', color: 'var(--blue-ink)' }}
          >
            <Icon name="check" size={16} />{' '}
            {result.stage === 'delivered'
              ? `Delivered. ${result.amountAed !== null ? `${aed(result.amountAed)} is recorded as received.` : ''}`
              : 'Collected. The car is now at the workshop.'}
          </p>
          <a className="btn primary" href="#/legs">
            Back to my trips
          </a>
        </Card>
      </Page>
    );
  if (!leg)
    return (
      <Page title="Handover">
        <p className="empty">This trip is no longer on your list.</p>
        <a className="link" href="#/legs">
          Back
        </a>
      </Page>
    );
  const pickup = leg.direction === 'pickup';

  return (
    <Page
      title={pickup ? 'Collect the car' : 'Deliver the car'}
      eyebrow={`${leg.make} ${leg.model} · ${leg.licensePlate ?? ''}`}
    >
      <a className="link back" href="#/legs">
        ← My trips
      </a>
      <Card title={pickup ? 'Condition photos' : 'Handover photos'}>
        <p className="muted small">
          {pickup
            ? 'Photograph all four corners and any marks before you drive off. These protect the customer and AVC.'
            : 'Photograph the car as you hand it back.'}
        </p>
        <PhotoPicker
          value={photos}
          onChange={setPhotos}
          caption={pickup ? 'Pickup condition' : 'Delivery handover'}
          upload={(file, caption) => uploadEvidence(leg.jobId, file, 'photo', caption)}
          label="Take photo"
          max={12}
        />
      </Card>
      <Card title="Customer signature">
        <Field label={`${leg.customerName} signs the transfer receipt`}>
          <SignaturePad onChange={setSigned} handle={pad} />
        </Field>
      </Card>
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}
      <div className="sticky-bar">
        <span className="muted small">
          {photos.length} photo{photos.length === 1 ? '' : 's'}
          {signed ? ' · signed' : ' · no signature yet'}
        </span>
        <button
          type="button"
          className="btn primary lg"
          disabled={busy || photos.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // Read the drawing now, so the saved signature is exactly what is on screen.
              const png = signed ? await pad.current?.blob() : null;
              const sig = png
                ? await uploadEvidence(leg.jobId, png, 'signature', 'Customer signature')
                : null;
              const r = await api<{ result: { stage: string; amountAed: number | null } }>(
                `/api/transfers/${id}/complete`,
                {
                  method: 'POST',
                  staff: true,
                  body: {
                    photoEvidenceIds: photos.map((p) => p.id),
                    ...(sig && { signatureEvidenceId: sig.id }),
                  },
                },
              );
              setResult(r.result);
            } catch (e) {
              setError(messageOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : pickup ? 'Confirm pickup' : 'Confirm delivery'}
        </button>
      </div>
    </Page>
  );
}
