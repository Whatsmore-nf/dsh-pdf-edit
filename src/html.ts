import { escapeHtml, estimateTextWidthPt } from "./util.js";
import type { Unit } from "./types.js";

export const BASE_CSS = `*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.pdf-page{position:relative;background:#fff;overflow:hidden}
.txt{position:absolute;white-space:pre;line-height:1;transform-origin:0 0}
.bg{position:absolute;left:0;top:0}
.mask{position:absolute;line-height:1}`;

export interface PageHtmlOptions {
  changedTids?: Set<string>;
  patchColor?: string;
}

export function buildPageHtml(
  ex: {
    widthPt: number;
    heightPt: number;
    units: Unit[];
    background?: {
      dataUrl: string;
      widthPt: number;
      heightPt: number;
    };
  },
  opts: PageHtmlOptions = {},
): string {
  const parts: string[] = [];

  if (ex.background) {
    const b = ex.background;
    parts.push(
      `<img class="bg" src="${b.dataUrl}" style="width:${b.widthPt.toFixed(
        2,
      )}pt;height:${b.heightPt.toFixed(2)}pt">`,
    );
  }

  let draw: Unit[];

  if (ex.background) {
    draw = opts.changedTids
      ? ex.units.filter((u) => opts.changedTids!.has(u.tid))
      : [];
  } else {
    draw = ex.units;
  }

  if (ex.background && opts.changedTids) {
    const color = opts.patchColor ?? "#ffffff";
    for (const u of draw) {
      const r = maskRect(u);
      parts.push(
        `<span class="mask" style="left:${r.left.toFixed(2)}pt;top:${r.top.toFixed(
          2,
        )}pt;width:${r.width.toFixed(2)}pt;height:${r.height.toFixed(
          2,
        )}pt;background:${color}"></span>`,
      );
    }
  }

  for (const u of draw) {
    parts.push(textSpan(u));
  }

  return `<div class="pdf-page" style="width:${ex.widthPt.toFixed(
    2,
  )}pt;height:${ex.heightPt.toFixed(2)}pt">\n${parts.join("\n")}\n</div>`;
}

function textSpan(u: Unit): string {
  const style: string[] = [
    `left:${u.x.toFixed(2)}pt`,
    `top:${u.top.toFixed(2)}pt`,
  ];

  if (u.fontSizeOverride) {
    style.push(`font-size:${u.fontSizeOverride.toFixed(2)}pt`);
  }

  if (u.clip) {
    style.push(`width:${(u.width + 1).toFixed(2)}pt`, "overflow:hidden");
  } else if (u.wrap) {
    style.push(`width:${(u.width + 1).toFixed(2)}pt`, "white-space:pre-wrap");
  }

  return `<span class="txt ${u.className}" style="${style.join(
    ";",
  )}" data-tid="${u.tid}">${escapeHtml(u.text)}</span>`;
}

function maskRect(u: Unit) {
  const fs = u.fontSizeOverride ?? u.fontSize;
  const w = Math.max(u.width, estimateTextWidthPt(u.text, fs)) + 1;

  return {
    left: u.x - 0.5,
    top: u.top - 0.15 * u.fontSize,
    width: w,
    height: u.fontSize * 1.5,
  };
}

export function docShell(
  css: string,
  body: string,
  opts: { fontCss?: string } = {},
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page{margin:0}
html,body{margin:0;padding:0;background:#fff}
${opts.fontCss ?? ""}
${css}
</style>
</head>
<body>${body}</body>
</html>`;
}