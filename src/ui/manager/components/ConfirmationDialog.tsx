import { useEffect, useRef } from "react";

export function ConfirmationDialog({ title, message, confirmLabel = "Delete rule", onCancel, onConfirm }: {
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? []);
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [onCancel]);
  return <div className="dialog-backdrop"><div ref={dialogRef} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" tabIndex={-1} onKeyDown={onDialogKeyDown}>
    <h2 id="confirmation-title">{title}</h2><p>{message}</p>
    <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>{confirmLabel}</button></div>
  </div></div>;
}
