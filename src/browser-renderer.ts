import type { Browser } from "puppeteer-core";
import { docShell } from "./html.js";
import { pLimit } from "./util.js";

const pt2in = (pt: number) => `${(pt / 72).toFixed(3)}in`;

export class BrowserRenderer {
  private browser?: Browser;
  private readonly slot: ReturnType<typeof pLimit>;

  constructor(
    private executablePath: string,
    concurrency = 2,
  ) {
    this.slot = pLimit(concurrency);
  }

  private async ensure(): Promise<Browser> {
    this.browser ??= await import("puppeteer-core").then((m) =>
      m.default.launch({
        executablePath: this.executablePath,
        headless: true,
      }),
    );
    return this.browser;
  }

  async renderPage(
    css: string,
    html: string,
    wPt: number,
    hPt: number,
  ): Promise<Uint8Array> {
    return this.slot(async () => {
      const b = await this.ensure();
      const page = await b.newPage();
      try {
        await page.setContent(docShell(css, html), {
          waitUntil: "domcontentloaded",
        });
        await page.evaluate(() => (document as any).fonts.ready);
        const buf = await page.pdf({
          width: pt2in(wPt),
          height: pt2in(hPt),
          printBackground: true,
          pageRanges: "1",
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        return new Uint8Array(buf);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async renderFlow(
    css: string,
    html: string,
    wPt: number,
    hPt: number,
  ): Promise<Uint8Array> {
    return this.slot(async () => {
      const b = await this.ensure();
      const page = await b.newPage();
      try {
        await page.setContent(docShell(css, html), {
          waitUntil: "domcontentloaded",
        });
        await page.evaluate(() => (document as any).fonts.ready);
        const buf = await page.pdf({
          width: pt2in(wPt),
          height: pt2in(hPt),
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        return new Uint8Array(buf);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}