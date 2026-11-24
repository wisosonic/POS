import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog on the browser's own <dialog>: it traps focus, closes on Escape, and makes everything behind it inert, so a
 * cashier (or a scanner) can never type into the cart while a payment is open.
 */
export function Modal({
  label,
  onClose,
  children,
  dismissible = true,
  wide = false,
}: {
  label: string;
  onClose?: () => void;
  children: ReactNode;
  dismissible?: boolean;
  /** For a dialog with a table in it. */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-wide={wide || undefined}
      onCancel={(e) => {
        e.preventDefault(); // Escape: let the owner decide whether closing is allowed
        if (dismissible) onClose?.();
      }}
    >
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
