import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A button that opens a small panel of choices beneath it (the account menu, the settings menu). It closes when something
 * outside is pressed, on Escape, or when a choice calls close(), and Escape puts focus back on the button.
 */
export function Dropdown({
  label,
  className = 'icon-btn',
  trigger,
  children,
}: {
  /** What a screen reader says for the button: it usually has no text of its own. */
  label: string;
  className?: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={root}>
      <button ref={button} className={className} aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className="dropdown-panel" role="group" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
