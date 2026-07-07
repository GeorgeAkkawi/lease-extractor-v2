import { useEffect, useRef } from 'react';

// Shared keyboard + focus behavior for the app's hand-rolled modals (the
// .modal-scrim / .modal pattern): Escape closes, focus moves into the dialog on
// open (keyboard and screen-reader users otherwise stay stranded behind the
// scrim), Tab cycles inside it, and focus returns to the opener on close.
//
// Usage in a modal component:
//   const modalRef = useModalA11y(onClose);
//   <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} …>
// `active` is for components that render their modal CONDITIONALLY (e.g. a button
// that owns its own modal): pass the open flag so the behavior only engages while
// the dialog is actually shown.
export function useModalA11y(onClose, active = true) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // keep the latest close handler without re-binding listeners

  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement;
    const node = ref.current;
    const focusables = () =>
      node
        ? [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((el) => !el.disabled && el.offsetParent !== null)
        : [];
    (focusables()[0] || node)?.focus?.();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const els = focusables();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [active]);
  return ref;
}
