import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { serializeRenderedMarkdownFragment } from "./markdown-clipboard";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get className(): string {
    return this.classNames.join(" ");
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(): string | null {
    return null;
  }

  closest(): null {
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === "code") {
      for (const child of this.childNodes) {
        if (child instanceof FakeElement) {
          if (child.tagName === "CODE") return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
      }
    }
    return null;
  }

  hasAttribute(): boolean {
    return false;
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

describe("serializeRenderedMarkdownFragment", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps inline code in backticks", () => {
    const paragraph = new FakeElement("P").append(
      new FakeText("run "),
      new FakeElement("CODE").append(new FakeText("git status")),
      new FakeText(" first"),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("run `git status` first");
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it("keeps a code-only fragment plain when the cloned pre includes only the selection", () => {
    const pre = new FakeElement("PRE").append(
      new FakeElement("CODE").append(
        shikiCodeLine("git fetch upstream"),
        new FakeText("\n"),
        shikiCodeLine("git rebase upstream/main"),
        new FakeText("\n"),
        shikiCodeLine("git push --force-with-lease origin main"),
      ),
    );
    const container = new FakeElement("DIV").append(pre);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git fetch upstream\ngit rebase upstream/main\ngit push --force-with-lease origin main",
    );
  });

  it("keeps fences when a code block is copied together with surrounding text", () => {
    const pre = new FakeElement("PRE").append(
      new FakeElement("CODE").append(shikiCodeLine("git status")),
    );
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run this:")),
      pre,
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Run this:\n\n```\ngit status\n```",
    );
  });
});
