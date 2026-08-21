import type { Browser, Page } from "puppeteer-core";
import { docShell } from "./html.js";
import { pLimit } from "./util.js";

const pt2in = (pt: number) => `${(pt / 72).toFixed(3)}in`;

/** 出站请求拦截：只放行 data: 与 about:blank，其余全部阻断（防 SSRF/外联回传） */
function shouldBlock(url: string): boolean {
  if (url.startsWith("data:") || url === "about:blank") return false;
  return true;
}

const HARDENED_ARGS = [
  "--no-sandbox", // root / 容器环境必备
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-remote-fonts", // 禁止远程字体加载
  "--disable-features=site-per-process",
  "--block-insecure-private-network-requests",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--no-first-run",
  "--mute-audio",
  "--hide-scrollbars",
];

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
        args: HARDENED_ARGS,
      }),
    );
    return this.browser;
  }

  /** 加固 page：拦截出站请求 + 禁用 JS + 超时保护 */
  private async hardenedPage(b: Browser): Promise<Page> {
    const page = await b.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (shouldBlock(req.url())) req.abort("blockedbyclient").catch(() => {});
      else req.continue().catch(() => {});
    });
    // 渲染 PDF 文本无需 JS；禁用后注入脚本彻底失效
    await page.setJavaScriptEnabled(false);
    page.setDefaultTimeout(30_000);
    return page;
  }

  async renderPage(
    css: string,
    html: string,
    wPt: number,
    hPt: number,
  ): Promise<Uint8Array> {
    return this.slot(async () => {
      const b = await this.ensure();
      const page = await this.hardenedPage(b);
      try {
        await page.setContent(docShell(css, html, { csp: true }), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.evaluate(() => (document as any).fonts.ready);
        const buf = await page.pdf({
          width: pt2in(wPt),
          height: pt2in(hPt),
          printBackground: true,
          pageRanges: "1",
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
          timeout: 30_000,
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
      const page = await this.hardenedPage(b);
      try {
        await page.setContent(docShell(css, html, { csp: true }), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.evaluate(() => (document as any).fonts.ready);
        const buf = await page.pdf({
          width: pt2in(wPt),
          height: pt2in(hPt),
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
          timeout: 30_000,
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
