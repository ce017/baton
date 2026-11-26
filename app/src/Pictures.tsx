import { ImagePlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ClipboardEvent, type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { call, type Config } from './lib/api.ts';
import { EASE_IN, EASE_OUT, useToast } from './ui.tsx';

/** A picture link from a Baton server: <server>/i/<project>/<id>. */
const LINK = String.raw`https?:\/\/[^\s)]+\/i\/[a-z0-9_-]+\/[a-f0-9]{24}`;
const MD_OR_LINK = new RegExp(String.raw`!\[([^\]]*)\]\((${LINK})\)|(${LINK})`, 'g');
const MAX_BYTES = 1_800_000;

/** Text with picture markdown swapped for a short word, for previews and notifications. */
export function withoutPictures(text: string): string {
  return text.replace(MD_OR_LINK, '[picture]');
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read the picture.'));
    r.readAsDataURL(blob);
  });
}

/** Keeps small pictures as they are; shrinks big ones to WebP until they fit. */
async function prepare(file: Blob): Promise<{ mime: string; data: string }> {
  const keep = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error('That GIF is too big (1.8 MB at most).');
    return { mime: file.type, data: await toBase64(file) };
  }
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture Baton can read.');
  });
  if (keep && file.size <= MAX_BYTES && Math.max(bmp.width, bmp.height) <= 2400) {
    bmp.close();
    return { mime: file.type, data: await toBase64(file) };
  }
  let max = 2048;
  let quality = 0.88;
  for (let i = 0; i < 7; i++) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', quality));
    if (out && out.size <= MAX_BYTES) {
      bmp.close();
      return { mime: out.type || 'image/png', data: await toBase64(out) };
    }
    max = Math.round(max * 0.8);
    quality = Math.max(0.5, quality - 0.08);
  }
  bmp.close();
  throw new Error('That picture is too big, even shrunk.');
}

/** Uploads a picture to the project and returns markdown that shows it. */
export async function uploadPicture(cfg: Config, slug: string, file: Blob, name?: string): Promise<string> {
  const p = await prepare(file);
  const base = (name ?? (file instanceof File ? file.name : '')).replace(/\.[a-z0-9]+$/i, '') || 'picture';
  const r = await call<{ markdown: string }>(cfg, 'POST', `/api/projects/${slug}/images`, { ...p, name: base });
  return r.markdown;
}

export function picturesIn(list: DataTransferItemList | FileList | null | undefined): File[] {
  const out: File[] = [];
  for (const it of Array.from((list ?? []) as ArrayLike<DataTransferItem | File>)) {
    const f = it instanceof File ? it : it.kind === 'file' ? it.getAsFile() : null;
    if (f && f.type.startsWith('image/')) out.push(f);
  }
  return out;
}

/**
 * Paste, drop or pick pictures into a text box. Each one is uploaded and its markdown handed to
 * `insert`. Spread `handlers` on the textarea and render `button()` and `input` next to it.
 */
export function usePictureInput(cfg: Config, slug: string, insert: (markdown: string) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  async function add(files: File[]) {
    for (const f of files) {
      setBusy((b) => b + 1);
      try {
        insert(await uploadPicture(cfg, slug, f));
      } catch (err) {
        toast((err as Error).message, false);
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }
  return {
    busy: busy > 0,
    add,
    handlers: {
      onPaste: (e: ClipboardEvent) => {
        const files = picturesIn(e.clipboardData?.items);
        if (files.length) {
          e.preventDefault();
          add(files);
        }
      },
      onDrop: (e: DragEvent) => {
        const files = picturesIn(e.dataTransfer?.files);
        if (files.length) {
          e.preventDefault();
          add(files);
        }
      },
    },
    input: (
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          add(picturesIn(e.target.files));
          e.target.value = '';
        }}
      />
    ),
    button: (label = 'Picture') => (
      <button type="button" className="btn ghost sm" disabled={busy > 0} onClick={() => fileRef.current?.click()} title="Add a picture (you can also paste or drop one)">
        <ImagePlus size={13} /> {busy > 0 ? 'Uploading…' : label}
      </button>
    ),
  };
}

/** A picture that opens full size on click. */
export function Picture({ src, alt }: { src: string; alt?: string }) {
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setBig(false);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [big]);
  return (
    <>
      <img className="pic" src={src} alt={alt ?? ''} title={alt} loading="lazy" onClick={() => setBig(true)} />
      {createPortal(
        <AnimatePresence>
          {big && (
            <motion.div
              className="lightbox"
              onClick={() => setBig(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.16, ease: EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: 0.12, ease: EASE_IN } }}
            >
              <motion.img src={src} alt={alt ?? ''} initial={{ scale: 0.96 }} animate={{ scale: 1, transition: { duration: 0.2, ease: EASE_OUT } }} />
              <button type="button" className="lb-x" aria-label="Close" onClick={() => setBig(false)}>
                <X size={18} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/** Message or comment text with its pictures shown under the words. `text` renders the words. */
export function RichText({ value, text = (s) => s }: { value: string; text?: (s: string) => ReactNode }) {
  const pics: { src: string; alt: string }[] = [];
  const words = value
    .replace(MD_OR_LINK, (_m, alt: string | undefined, md: string | undefined, bare: string | undefined) => {
      pics.push({ src: md ?? bare ?? '', alt: alt ?? '' });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!pics.length) return <>{text(value)}</>;
  return (
    <>
      {words && <div>{text(words)}</div>}
      <div className="pics">
        {pics.map((p, i) => (
          <Picture key={`${p.src}-${i}`} src={p.src} alt={p.alt} />
        ))}
      </div>
    </>
  );
}
