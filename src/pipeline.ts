import { PDFDocument } from "pdf-lib";
import { AiTextEditor } from "./ai-editor.js";
import { StyleLockedExtractor } from "./extractor.js";
import { FontResolver, type FontConfig } from "./fonts-resolver.js";
import { buildFlowBlocks } from "./flow.js";
import { FLOW_THEMES, type TemplateId } from "./flow-themes.js";
import { buildPageHtml } from "./html.js";
import { renderFlowDocument } from "./layout-flow.js";
import { NativePageRenderer } from "./native-renderer.js";
import { replaceEntireDocument, replacePages } from "./pdf-ops.js";
import { applyPatches, type MeasureFn } from "./validator.js";
import { chunk, hash32, pLimit, range } from "./util.js";

import type {
  ChatFn,
  EditableUnit,
  Glossary,
  OverflowPolicy,
  PageExtract,
  ProgressFn,
  Unit,
} from "./types.js";

export interface EditorOptions {
  batchSize?: number;
  extractConcurrency?: number;
  aiMaxCharsPerCall?: number;
  /** AI 调用重试退避基数（毫秒）；第 n 次重试等待 base*n。默认 400 */
  retryBaseMs?: number;
  recoverColor?: boolean;
  strictColor?: boolean;
  overflow?: OverflowPolicy;
  glossary?: Glossary;
  fonts?: FontConfig;
  patchColor?: string;
  strictTids?: boolean;
  missingTidsUseOriginal?: boolean;
  renderMode?: "native" | "browser";
  browserExecutablePath?: string;
  browserConcurrency?: number;
}

const toEditable = (u: Unit): EditableUnit => ({ tid: u.tid, text: u.text });

const nativeMeasure =
  (r: FontResolver): MeasureFn =>
  async (text, size, sig) => {
    const rf = await r.resolveA(sig.fontFamily, text, sig.bold, sig.italic);
    return r.measure(rf, text, size);
  };

export class StyleLockedEditor {
  private readonly extractCache = new Map<number, PageExtract>();
  private readonly changedTidsByPage = new Map<number, Set<string>>();
  private browserRenderer?: import("./browser-renderer.js").BrowserRenderer;

  lastFailures: Array<{ page: number; error: unknown }> = [];
  warnings: string[] = [];
  readonly docHash: string;

  private constructor(
    private readonly original: Uint8Array,
    private readonly extractor: StyleLockedExtractor,
    private readonly ai: AiTextEditor,
    private readonly opts: EditorOptions & {
      batchSize: number;
      extractConcurrency: number;
      aiMaxCharsPerCall: number;
      recoverColor: boolean;
      strictColor: boolean;
      overflow: OverflowPolicy;
      patchColor: string;
      strictTids: boolean;
      missingTidsUseOriginal: boolean;
      renderMode: "native" | "browser";
      browserConcurrency: number;
      browserExecutablePath: string;
    },
  ) {
    this.docHash = hash32(original);
  }

  static async open(
    original: Uint8Array,
    chat: ChatFn,
    opts: EditorOptions = {},
  ): Promise<StyleLockedEditor> {
    const o = {
      batchSize: 10,
      extractConcurrency: 4,
      aiMaxCharsPerCall: 18_000,
      recoverColor: true,
      strictColor: false,
      overflow: { mode: "shrink", minFontSizePt: 6 } as OverflowPolicy,
      patchColor: "#ffffff",
      strictTids: false,
      missingTidsUseOriginal: true,
      renderMode: "native" as const,
      browserConcurrency: 2,
      browserExecutablePath: "",
      ...opts,
    };

    return new StyleLockedEditor(
      original.slice(),
      await StyleLockedExtractor.open(original),
      new AiTextEditor(chat, {
        maxCharsPerCall: o.aiMaxCharsPerCall,
        retryBaseMs: o.retryBaseMs,
        glossary: o.glossary,
        patch: {
          strict: o.strictTids,
          missingTidsUseOriginal: o.missingTidsUseOriginal,
        },
      }),
      o,
    );
  }

  get pageCount(): number {
    return this.extractor.pageCount;
  }

  async previewPage(n: number): Promise<EditableUnit[]> {
    return (await this.getExtract(n)).units.map(toEditable);
  }

  async editPage(
    n: number,
    instruction: string,
    targetTids?: string[],
  ): Promise<Uint8Array> {
    const ex = await this.getExtract(n);
    let units = ex.units.map(toEditable);
    if (targetTids?.length) {
      const s = new Set(targetTids);
      units = units.filter((u) => s.has(u.tid));
    }
    const patches = await this.ai.edit(units, instruction);

    if (this.opts.renderMode === "browser") {
      return this.editPageBrowser(ex, patches);
    }

    const { doc, resolver } = await this.openNativeDoc();
    const report = await applyPatches(ex, patches, {
      overflow: this.opts.overflow,
      measure: nativeMeasure(resolver),
      strictUnknown: this.opts.strictTids,
    });
    const tids = this.mergeChanged(n, report);
    if (!tids.size) return this.original.slice();

    await this.drawPatchedPages(doc, resolver, [
      { ex, changedTids: tids },
    ]);
    return doc.save();
  }

  async editDocument(
    instruction: string,
    onProgress?: ProgressFn,
  ): Promise<Uint8Array> {
    const total = this.pageCount;
    this.lastFailures = [];
    if (!total) return this.original.slice();

    const isNative = this.opts.renderMode === "native";
    const ctx = isNative ? await this.openNativeDoc() : null;
    const measure = ctx ? nativeMeasure(ctx.resolver) : undefined;

    const work: Array<{ ex: PageExtract; changedTids: Set<string> }> = [];
    const replacements = new Map<number, Uint8Array>();
    const renderTasks: Array<Promise<void>> = [];
    const batches = chunk(range(1, total), this.opts.batchSize);
    let done = 0;

    let prefetch: Promise<PageExtract[]> | null = this.extractBatch(
      batches[0],
    );

    for (let b = 0; b < batches.length; b++) {
      const extracts = await prefetch!;
      prefetch =
        b + 1 < batches.length ? this.extractBatch(batches[b + 1]) : null;

      let patches: Map<string, string>;
      try {
        patches = await this.ai.edit(
          extracts.flatMap((p) => p.units.map(toEditable)),
          instruction,
        );
      } catch (e) {
        for (const n of batches[b])
          this.lastFailures.push({ page: n, error: e });
        done += batches[b].length;
        onProgress?.({
          stage: "error",
          done,
          total,
          message: `第${b + 1}批 AI 调用失败，本批沿用原文`,
        });
        continue;
      }

      for (const ex of extracts) {
        const report = await applyPatches(ex, patches, {
          overflow: this.opts.overflow,
          measure,
          strictUnknown: this.opts.strictTids,
        });
        const tids = this.mergeChanged(ex.pageNumber, report);

        if (!tids.size) {
          done++;
          onProgress?.({
            stage: "skip",
            done,
            total,
            page: ex.pageNumber,
            message: "无改动，复用原页",
          });
          continue;
        }

        if (isNative) {
          work.push({ ex, changedTids: tids });
          done++;
          onProgress?.({ stage: "render", done, total, page: ex.pageNumber });
        } else {
          renderTasks.push(
            this.renderPageBrowser(ex, tids)
              .then((bytes) => {
                replacements.set(ex.pageNumber, bytes);
              })
              .catch((e) => {
                this.lastFailures.push({ page: ex.pageNumber, error: e });
                onProgress?.({
                  stage: "error",
                  done,
                  total,
                  page: ex.pageNumber,
                  message: String(e),
                });
              })
              .finally(() => {
                done++;
                onProgress?.({
                  stage: "render",
                  done,
                  total,
                  page: ex.pageNumber,
                });
              }) as Promise<void>,
          );
        }
      }
    }

    if (isNative) {
      await this.drawPatchedPages(ctx!.doc, ctx!.resolver, work);
      onProgress?.({ stage: "merge", done: total, total });
      return ctx!.doc.save();
    }

    await Promise.all(renderTasks);
    onProgress?.({ stage: "merge", done: total, total });
    return replacePages(this.original, replacements);
  }

  async relayout(
    templateId: TemplateId,
    onProgress?: ProgressFn,
  ): Promise<Uint8Array> {
    const extracts: PageExtract[] = [];
    const total = this.pageCount;
    const limit = pLimit(this.opts.extractConcurrency);

    await Promise.all(
      range(1, total).map((n) =>
        limit(async () => {
          extracts.push(await this.getExtract(n));
          onProgress?.({
            stage: "extract",
            done: extracts.length,
            total,
            page: n,
          });
        }),
      ),
    );

    extracts.sort((a, b) => a.pageNumber - b.pageNumber);
    const blocks = buildFlowBlocks(extracts);

    if (this.opts.renderMode === "browser") {
      return this.relayoutBrowser(blocks, templateId);
    }

    const doc = await PDFDocument.create();
    const resolver = await FontResolver.create(doc, this.opts.fonts);
    await renderFlowDocument(doc, blocks, FLOW_THEMES[templateId], resolver);
    return replaceEntireDocument(await doc.save(), this.original);
  }

  async close(): Promise<void> {
    await this.browserRenderer?.close().catch(() => {});
    this.browserRenderer = undefined;
  }

  private async openNativeDoc() {
    const doc = await PDFDocument.load(this.original, {
      ignoreEncryption: true,
    });
    const resolver = await FontResolver.create(doc, this.opts.fonts);
    return { doc, resolver };
  }

  private mergeChanged(
    pageNumber: number,
    report: { changed: number; changedTids: string[] },
  ): Set<string> {
    let set = this.changedTidsByPage.get(pageNumber);
    if (!set) {
      set = new Set();
      this.changedTidsByPage.set(pageNumber, set);
    }
    for (const t of report.changedTids) set.add(t);
    return set;
  }

  private async drawPatchedPages(
    doc: PDFDocument,
    resolver: FontResolver,
    work: Array<{ ex: PageExtract; changedTids: Set<string> }>,
  ): Promise<void> {
    const renderer = new NativePageRenderer(resolver, {
      patchColor: this.opts.patchColor,
    });
    for (const w of work) {
      try {
        const page = doc.getPage(w.ex.pageNumber - 1);
        if (page.getRotation().angle % 360 !== 0) {
          throw new Error(
            "旋转页暂不支持 native 直绘（可切 renderMode:'browser'）",
          );
        }
        await renderer.renderPatches(page, w.ex, w.changedTids);
      } catch (e) {
        this.lastFailures.push({ page: w.ex.pageNumber, error: e });
      }
    }
  }

  private async getExtract(n: number): Promise<PageExtract> {
    let ex = this.extractCache.get(n);
    if (!ex) {
      ex = await this.extractor.extractPage(n, {
        recoverColor: this.opts.recoverColor,
        strictColor: this.opts.strictColor,
      });
      this.extractCache.set(n, ex);
    }
    return ex;
  }

  private extractBatch(pageNumbers: number[]): Promise<PageExtract[]> {
    const limit = pLimit(this.opts.extractConcurrency);
    return Promise.all(
      pageNumbers.map((n) => limit(() => this.getExtract(n))),
    );
  }

  private async browser() {
    if (!this.browserRenderer) {
      const { BrowserRenderer } = await import("./browser-renderer.js");
      if (!this.opts.browserExecutablePath) {
        throw new Error(
          "browser 模式需配置 browserExecutablePath（系统 Chrome/Edge 可执行文件路径）",
        );
      }
      this.browserRenderer = new BrowserRenderer(
        this.opts.browserExecutablePath,
        this.opts.browserConcurrency,
      );
    }
    return this.browserRenderer;
  }

  private async editPageBrowser(
    ex: PageExtract,
    patches: Map<string, string>,
  ): Promise<Uint8Array> {
    const report = await applyPatches(ex, patches, {
      overflow: this.opts.overflow,
      strictUnknown: this.opts.strictTids,
    });
    const tids = this.mergeChanged(ex.pageNumber, report);
    if (!tids.size) return this.original.slice();
    const bytes = await this.renderPageBrowser(ex, tids);
    return replacePages(this.original, new Map([[ex.pageNumber, bytes]]));
  }

  private async renderPageBrowser(
    ex: PageExtract,
    changedTids: Set<string>,
  ): Promise<Uint8Array> {
    ex.html = buildPageHtml(ex, {
      changedTids,
      patchColor: this.opts.patchColor,
    });
    const br = await this.browser();
    return br.renderPage(ex.css, ex.html, ex.widthPt, ex.heightPt);
  }

  private async relayoutBrowser(
    blocks: Array<import("./flow.js").FlowBlock>,
    templateId: TemplateId,
  ): Promise<Uint8Array> {
    const { blocksToHtml } = await import("./flow.js");
    const { TEMPLATES, fillTemplate } = await import("./templates.js");
    const { title, bodyHtml } = blocksToHtml(blocks);
    const tpl = TEMPLATES[templateId];
    const html = fillTemplate(tpl, title, bodyHtml);
    const br = await this.browser();
    const bytes = await br.renderFlow(
      tpl.css,
      html,
      tpl.pageSize.widthPt,
      tpl.pageSize.heightPt,
    );
    return replaceEntireDocument(bytes, this.original);
  }
}