import { Bot, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { TaskStatus } from './lib/api.ts';
import { personColor } from './lib/format.ts';

// ux-motion: enter ease-out, exit ease-in, exits ~half the entry.
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN = [0.7, 0, 0.84, 0] as const;
export const EASE_MOVE = [0.65, 0, 0.35, 1] as const;

export function Avatar({ label, bot, size }: { label: string; bot?: boolean; size?: 'sm' | 'lg' }) {
  const letter = label.trim()[0]?.toUpperCase() ?? '?';
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: personColor(label) }} title={label}>
      {letter}
      {bot && (
        <span className="bot" aria-label="Claude">
          <Bot size={8} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

export function Skel({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number; r?: number; style?: React.CSSProperties }) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', doing: 'Doing', blocked: 'Blocked', done: 'Done' };

export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Right-side drawer: slides in 240 ms ease-out, out 120 ms ease-in. Esc closes. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2 } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          />
          <motion.aside
            className="drawer"
            initial={reduce ? { opacity: 0 } : { x: 48, opacity: 0 }}
            animate={{ x: 0, opacity: 1, transition: { duration: 0.24, ease: EASE_OUT } }}
            exit={reduce ? { opacity: 0 } : { x: 32, opacity: 0, transition: { duration: 0.12, ease: EASE_IN } }}
          >
            <div className="drawer-head">
              <div className="grow">{title}</div>
              <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="grow scroll" style={{ padding: 16 }}>
              {children}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** A checkmark that draws itself in: the "it's saved" moment (peak-end). */
export function DrawCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <motion.path
        d="M3 8.5l3.2 3L13 4.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.28, ease: EASE_OUT }}
      />
    </svg>
  );
}

type Toast = { id: number; text: string; ok: boolean };
const ToastCtx = createContext<(text: string, ok?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string, ok = true) => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), text, ok });
    timer.current = setTimeout(() => setToast(null), ok ? 2200 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 12, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%', transition: { duration: 0.22, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: 6, x: '-50%', transition: { duration: 0.12, ease: EASE_IN } }}
            style={{ background: toast.ok ? undefined : 'var(--blocked)' }}
          >
            {toast.ok && <DrawCheck />}
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
