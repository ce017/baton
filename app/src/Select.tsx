import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Children, isValidElement, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { EASE_IN, EASE_OUT } from './ui.tsx';

interface Opt {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * A dark, keyboard-friendly replacement for the native <select> (whose open list is drawn by
 * Windows in white). Takes the same <option> children and calls onChange with { target: { value } },
 * so it drops in where a <select> was.
 */
export function Select({
  value,
  onChange,
  children,
  className = '',
  disabled,
  style,
  'aria-label': ariaLabel,
  footer,
}: {
  value: string | number;
  onChange: (e: { target: { value: string } }) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  'aria-label'?: string;
  /** Extra rows under the options (e.g. "New project"). */
  footer?: (close: () => void) => ReactNode;
}) {
  const opts: Opt[] = [];
  Children.forEach(children, (c) => {
    if (isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(c)) {
      opts.push({ value: String(c.props.value ?? ''), label: c.props.children, disabled: c.props.disabled });
    }
  });
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const cur = opts.find((o) => o.value === String(value));

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const pick = (o: Opt) => {
    if (o.disabled) return;
    setOpen(false);
    if (o.value !== String(value)) onChange({ target: { value: o.value } });
  };
  const show = () => {
    setHi(Math.max(0, opts.findIndex((o) => o.value === String(value))));
    setOpen(true);
  };

  return (
    <div ref={ref} className={`sel ${className}`} style={style}>
      <button
        type="button"
        className="sel-btn"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            show();
            return;
          }
          if (!open) return;
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(opts.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); const o = opts[hi]; if (o) pick(o); }
        }}
      >
        <span className="sel-val">{cur?.label ?? ''}</span>
        <ChevronDown size={13} className="sel-chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="listbox"
            className="sel-pop"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.14, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: -2, transition: { duration: 0.1, ease: EASE_IN } }}
          >
            {opts.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === String(value)}
                aria-disabled={o.disabled}
                className={`sel-opt ${i === hi ? 'hi' : ''} ${o.disabled ? 'off' : ''}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              >
                <span className="grow">{o.label}</span>
                {o.value === String(value) && <Check size={13} />}
              </div>
            ))}
            {footer && <div className="sel-foot">{footer(() => setOpen(false))}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
