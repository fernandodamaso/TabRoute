import { useEffect, useRef, useState } from "react";
import type { Rule } from "../../../domain/types";

export function RuleActionsMenu({
  rule,
  onEdit,
  onDuplicate,
  onDelete
}: {
  rule: Rule;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: (trigger: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    itemRefs.current[0]?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);
  const moveFocus = (offset: number) => {
    const items = itemRefs.current.filter(
      (item): item is HTMLButtonElement => item !== null
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(current + offset + items.length) % items.length]?.focus();
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      itemRefs.current[0]?.focus();
    }
    if (event.key === "End") {
      event.preventDefault();
      itemRefs.current[itemRefs.current.length - 1]?.focus();
    }
  };
  return (
    <span className="rule-actions">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Rule actions ${rule.id.slice(0, 8)}`}
        onClick={() => setOpen((value) => !value)}
      >
        •••
      </button>
      {open && (
        <div
          ref={menuRef}
          className="rule-actions-menu"
          role="menu"
          aria-label="Rule actions"
          onKeyDown={onMenuKeyDown}
        >
          <button
            ref={(element) => {
              itemRefs.current[0] = element;
            }}
            tabIndex={0}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit
          </button>
          <button
            ref={(element) => {
              itemRefs.current[1] = element;
            }}
            tabIndex={-1}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDuplicate();
            }}
          >
            Duplicate
          </button>
          <button
            ref={(element) => {
              itemRefs.current[2] = element;
            }}
            tabIndex={-1}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete(triggerRef.current!);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </span>
  );
}
