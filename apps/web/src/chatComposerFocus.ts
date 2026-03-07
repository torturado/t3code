const BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dialog-popup"]',
  '[data-slot="sheet-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="menu-sub-content"]',
  '[data-slot="popover-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[role="dialog"][aria-modal="true"]',
].join(", ");

export function hasBlockingComposerOverlay(root: ParentNode = document): boolean {
  return root.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null;
}

export function isInteractiveComposerTarget(target: EventTarget | null): boolean {
  const element =
    typeof HTMLElement !== "undefined" && target instanceof HTMLElement
      ? target
      : target && typeof target === "object" && "closest" in target
        ? (target as {
            closest: (selector: string) => Element | null;
            isContentEditable?: boolean;
          })
        : null;
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  return (
    element.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]',
    ) !== null
  );
}

export function shouldRedirectTypingToComposer(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  target: EventTarget | null;
  hasBlockingOverlay: boolean;
}): boolean {
  if (input.metaKey || input.ctrlKey || input.altKey || input.isComposing) {
    return false;
  }
  if (input.key.length !== 1) {
    return false;
  }
  if (isInteractiveComposerTarget(input.target)) {
    return false;
  }
  if (input.hasBlockingOverlay) {
    return false;
  }
  return true;
}
