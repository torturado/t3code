import { describe, expect, it } from "vitest";

import {
  hasBlockingComposerOverlay,
  isInteractiveComposerTarget,
  shouldRedirectTypingToComposer,
} from "./chatComposerFocus";

function createTarget(
  overrides: Partial<{
    isContentEditable: boolean;
    closest: (selector: string) => Element | null;
  }> = {},
): EventTarget & {
  isContentEditable: boolean;
  closest: (selector: string) => Element | null;
} {
  return Object.assign(new EventTarget(), {
    isContentEditable: false,
    closest: () => null,
    ...overrides,
  });
}

describe("chatComposerFocus", () => {
  it("redirects plain printable keys from non-interactive targets", () => {
    const target = createTarget();

    expect(
      shouldRedirectTypingToComposer({
        key: "$",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
        target,
        hasBlockingOverlay: false,
      }),
    ).toBe(true);
  });

  it("rejects input targets, modifier keys, and overlays", () => {
    const input = createTarget({
      closest: () => ({ tagName: "INPUT" } as Element),
    });

    expect(isInteractiveComposerTarget(input)).toBe(true);
    expect(
      shouldRedirectTypingToComposer({
        key: "a",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
        target: input,
        hasBlockingOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectTypingToComposer({
        key: "a",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
        target: createTarget(),
        hasBlockingOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectTypingToComposer({
        key: "a",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        isComposing: false,
        target: createTarget(),
        hasBlockingOverlay: true,
      }),
    ).toBe(false);
  });

  it("detects blocking overlays from dialog and menu slots", () => {
    expect(
      hasBlockingComposerOverlay({
        querySelector: () => ({ nodeType: 1 } as Element),
      } as unknown as ParentNode),
    ).toBe(true);
    expect(
      hasBlockingComposerOverlay({
        querySelector: () => null,
      } as unknown as ParentNode),
    ).toBe(false);
  });
});
