import type { PDFPage } from "pdf-lib";
import type { FontResolver, ResolvedFont } from "./fonts-resolver.js";
import { toWinAnsiSafe } from "./fonts-resolver.js";
import { ellipsizeByMeasure, hexToRgb, wrapByMeasure } from "./util.js";
import type { PageExtract } from "./types.js";

export interface NativeRenderOptions {
  patchColor?: string;
}

export class NativePageRenderer {
  constructor(
    private resolver: FontResolver,
    private opts: NativeRenderOptions = {},
  ) {}

  async renderPatches(
    page: PDFPage,
    ex: PageExtract,
    changedTids: Set<string>,
  ): Promise<void> {
    const { height: H } = page.getSize();
    const patch = hexToRgb(this.opts.patchColor ?? "#ffffff");

    for (const u of ex.units) {
      if (!changedTids.has(u.tid)) continue;

      const rf = await this.resolver.resolveA(
        u.sig.fontFamily,
        u.text,
        u.sig.bold,
        u.sig.italic,
      );
      const text = rf.standard ? toWinAnsiSafe(u.text) : u.text;
      const size = u.fontSizeOverride ?? u.fontSize;
      const measure = (s: string) => this.resolver.measure(rf, s, size);

      const boxW = Math.max(u.width, measure(text)) + 2;
      const boxH = u.fontSize * 1.35;
      page.drawRectangle({
        x: u.x - 1,
        y: H - u.top - boxH,
        width: boxW,
        height: boxH,
        color: patch,
      });

      const color = hexToRgb(u.sig.color);

      if (u.wrap) {
        const lines = wrapByMeasure(text, measure, u.width + 1);
        let baseline = H - u.baselineTop;
        for (const line of lines) {
          this.drawText(page, rf, line, u.x, baseline, size, color);
          baseline -= size * 1.3;
        }
      } else {
        const finalText = u.clip
          ? ellipsizeByMeasure(text, measure, u.width + 1)
          : text;
        this.drawText(page, rf, finalText, u.x, H - u.baselineTop, size, color);
      }
    }
  }

  private drawText(
    page: PDFPage,
    rf: ResolvedFont,
    text: string,
    x: number,
    y: number,
    size: number,
    color: any,
  ) {
    if (!text) return;
    page.drawText(text, { x, y, size, font: rf.font, color });
    if (rf.fakeBold) {
      page.drawText(text, {
        x: x + Math.max(0.2, size * 0.02),
        y,
        size,
        font: rf.font,
        color,
      });
    }
  }
}