import { escapeHtml, median } from "./util.js";
import type { PageExtract, Unit } from "./types.js";

export interface FlowBlock {
  kind: "heading" | "subheading" | "body" | "caption";
  text: string;
  size: number;
}

export function buildFlowBlocks(pages: PageExtract[]): FlowBlock[] {
  const sizes: number[] = [];

  for (const p of pages) {
    for (const u of p.units) sizes.push(u.fontSize);
  }

  const bodySize = median(sizes) || 12;
  const blocks: FlowBlock[] = [];

  for (const page of pages) {
    const units = [...page.units].sort((a, b) => a.top - b.top || a.x - b.x);

    let para: Unit[] = [];

    const flush = () => {
      if (para.length) {
        blocks.push(classify(para, bodySize));
        para = [];
      }
    };

    for (const u of units) {
      const prev = para[para.length - 1];

      if (
        prev &&
        u.top - prev.top > Math.max(prev.fontSize, u.fontSize) * 2.1
      ) {
        flush();
      }

      para.push(u);
    }

    flush();
  }

  return blocks;
}

function classify(para: Unit[], bodySize: number): FlowBlock {
  const size = para[0].fontSize;

  let kind: FlowBlock["kind"] = "body";

  if (size >= bodySize * 1.45) kind = "heading";
  else if (size >= bodySize * 1.15) kind = "subheading";
  else if (size <= bodySize * 0.85) kind = "caption";

  return { kind, text: joinText(para), size };
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function joinText(units: Unit[]): string {
  let s = "";

  for (const u of units) {
    if (s && u.text) {
      const a = s[s.length - 1];
      const b = u.text[0];

      if (!CJK.test(a) && !CJK.test(b)) s += " ";
    }

    s += u.text;
  }

  return s.replace(/\s{2,}/g, " ").trim();
}

export function blocksToHtml(blocks: FlowBlock[]): {
  title: string | null;
  bodyHtml: string;
} {
  const mainTitle = blocks.find((b) => b.kind === "heading") ?? null;
  const parts: string[] = [];

  for (const b of blocks) {
    if (b === mainTitle) continue;

    if (b.kind === "heading") {
      parts.push(`<h2>${escapeHtml(b.text)}</h2>`);
    } else if (b.kind === "subheading") {
      parts.push(`<h3>${escapeHtml(b.text)}</h3>`);
    } else if (b.kind === "caption") {
      parts.push(`<p class="caption">${escapeHtml(b.text)}</p>`);
    } else {
      parts.push(`<p>${escapeHtml(b.text)}</p>`);
    }
  }

  return {
    title: mainTitle?.text ?? null,
    bodyHtml: parts.join("\n"),
  };
}