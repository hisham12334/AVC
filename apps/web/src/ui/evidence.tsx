import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Icon } from './ui';

export type Loader = (evidenceId: string) => Promise<string>;

function useLoaded(load: Loader | undefined, id: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (!load) return;
    load(id).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [load, id]);
  return { url, failed };
}

// A thumbnail that opens full size. Without a loader (the sample-data demo) it is a labelled tile.
export function EvidenceThumb({
  id,
  caption,
  load,
}: {
  id: string;
  caption: string;
  load?: Loader;
}) {
  const [open, setOpen] = useState(false);
  const { url, failed } = useLoaded(load, id);
  return (
    <>
      <button
        type="button"
        className="thumb"
        title={caption}
        onClick={() => url && setOpen(true)}
        disabled={!url}
        aria-label={`View photo: ${caption || 'evidence'}`}
      >
        {url ? <img src={url} alt={caption} /> : <Icon name="camera" size={14} />}
        <em>{failed ? 'Unavailable' : caption}</em>
      </button>
      {open && url && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <img src={url} alt={caption} />
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}

export type Photo = { id: string; preview: string; caption: string };

// Take or pick photos. Each one is uploaded straight away so the technician never loses work.
export function PhotoPicker({
  value,
  onChange,
  upload,
  label = 'Add photo',
  caption = '',
  max = 8,
  single = false,
}: {
  value: Photo[];
  onChange: (photos: Photo[]) => void;
  upload: (file: File, caption: string) => Promise<Photo>;
  label?: string;
  caption?: string;
  max?: number;
  single?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="photos">
      {value.map((p) => (
        <span key={p.id} className="photo">
          <img src={p.preview} alt={p.caption || 'Uploaded photo'} />
          <button
            type="button"
            aria-label="Remove photo"
            onClick={() => onChange(value.filter((x) => x.id !== p.id))}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      {(!single || value.length === 0) && value.length < max && (
        <button
          type="button"
          className="photo add"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Icon name="camera" size={18} />
          <span>{busy ? 'Uploading…' : label}</span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        multiple={!single}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length === 0) return;
          setBusy(true);
          setError(null);
          const added: Photo[] = [];
          try {
            for (const file of files.slice(0, max - value.length))
              added.push(await upload(file, caption));
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed. Try again.');
          } finally {
            onChange([...value, ...added]);
            setBusy(false);
          }
        }}
      />
      {error && (
        <p className="banner banner-critical" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type SignatureHandle = { blob: () => Promise<Blob | null> };

// A finger or mouse signature. `onChange` says whether anything is drawn; the PNG itself is read from the
// canvas at the moment of saving (through `handle`), so it is never stale.
export function SignaturePad({
  onChange,
  handle,
}: {
  onChange: (signed: boolean) => void;
  handle: { current: SignatureHandle | null };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  useEffect(() => {
    handle.current = {
      blob: () =>
        new Promise((resolve) => {
          const c = canvas.current;
          if (!c) resolve(null);
          else c.toBlob(resolve, 'image/png');
        }),
    };
    return () => {
      handle.current = null;
    };
  }, [handle]);
  const endStroke = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setInked(true);
    onChange(true);
  };
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = canvas.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * canvas.current!.width,
      y: ((e.clientY - box.top) / box.height) * canvas.current!.height,
    };
  };
  const ctx = () => {
    const c = canvas.current!.getContext('2d')!;
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.strokeStyle = '#1d2a3b';
    return c;
  };
  return (
    <div className="sig">
      <canvas
        ref={canvas}
        width={600}
        height={200}
        aria-label="Signature area"
        onPointerDown={(e) => {
          drawing.current = true;
          try {
            canvas.current!.setPointerCapture(e.pointerId);
          } catch {
            /* some browsers refuse capture; drawing still works without it */
          }
          const p = point(e);
          const c = ctx();
          c.beginPath();
          c.moveTo(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = point(e);
          const c = ctx();
          c.lineTo(p.x, p.y);
          c.stroke();
        }}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={endStroke}
      />
      <button
        type="button"
        className="btn ghost"
        disabled={!inked}
        onClick={() => {
          const c = canvas.current!;
          c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
          setInked(false);
          onChange(false);
        }}
      >
        Clear
      </button>
    </div>
  );
}

// Scannable code for the customer's profile link. The code is drawn from the link we generated.
export function Qr({ value, size = 168 }: { value: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return (
    <div
      className="qr"
      role="img"
      aria-label="QR code that opens the customer profile"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ scalable: true, margin: 2 }) }}
    />
  );
}
