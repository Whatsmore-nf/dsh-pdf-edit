import type { PDFPage } from "pdf-lib";
import type { FontResolver, ResolvedFont } from "./fonts-resolver.js";
import { toWinAnsiSafe } from "./fonts-resolver.js";
import { ellipsizeByMeasure, hexToRgb, wrapByMeasure } from "./util.js";
import type { BgSampleFn } from "./bg-sampler.js";
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
    sampleBg?: BgSampleFn,
  ): Promise<void> {
    const { height: H } = page.getSize();

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

      // 背景采样命中 → 用实际背景色替代固定补丁色；未命中回退配置色
      let patch = hexToRgb(this.opts.patchColor ?? "#ffffff");
      if (sampleBg) {
        const bg = sampleBg(u.x - 1, u.top, boxW + 2, boxH);
        if (bg) {
          try {
            patch = hexToRgb(bg);
          } catch {
            /* 非法色值保持回退 */
          }
        }
      }

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