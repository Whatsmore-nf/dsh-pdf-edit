import { estimateTextWidthPt, round1 } from "./util.js";
import type {
  EditableUnit,
  OverflowPolicy,
  PageExtract,
  StyleSignature,
  Unit,
} from "./types.js";

export interface SanitizeOptions {
  maxGrowRatio?: number;
}

export function sanitizeText(
  original: string,
  next: unknown,
  opts: SanitizeOptions = {},
): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof next !== "string") {
    return { ok: false, reason: "类型非法" };
  }

  let t = next.replace(/<[^>]*>/g, "");
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  if (t.length === 0) {
    return { ok: false, reason: "空文本" };
  }

  const grow = opts.maxGrowRatio ?? 3;
  if (t.length > original.length * grow + 16) {
    return { ok: false, reason: "长度异常膨胀（疑似跑飞）" };
  }

  return { ok: true, text: t };
}

export interface PatchOptions {
  strict?: boolean;
  missingTidsUseOriginal?: boolean;
}

export function reconcilePatches(
  input: EditableUnit[],
  output: Map<string, string>,
  opts: PatchOptions = {},
): Map<string, string> {
  const result = new Map<string, string>();
  const inputTids = new Set(input.map((u) => u.tid));

  for (const [tid, text] of output) {
    if (!inputTids.has(tid)) {
      if (opts.strict) {
        throw new Error(`AI 返回了未知 tid（越权）: ${tid}`);
      }
      continue;
    }

    result.set(tid, text);
  }

  for (const u of input) {
    if (!result.has(u.tid)) {
      if (opts.strict) {
        throw new Error(`AI 缺少 tid: ${u.tid}`);
      }

      if (opts.missingTidsUseOriginal ?? true) {
        result.set(u.tid, u.text);
      }
    }
  }

  return result;
}

export type MeasureFn = (
  text: string,
  fontSizePt: number,
  sig: StyleSignature,
) => number | Promise<number>;

export interface ApplyOptions extends SanitizeOptions {
  strictUnknown?: boolean;
  overflow?: OverflowPolicy;
  measure?: MeasureFn;
}

export interface ApplyReport {
  changed: number;
  changedTids: string[];
  rejected: Array<{ tid: string; reason: string }>;
}

export async function applyPatches(
  page: PageExtract,
  patches: Map<string, string>,
  opts: ApplyOptions = {},
): Promise<ApplyReport> {
  const report: ApplyReport = {
    changed: 0,
    changedTids: [],
    rejected: [],
  };

  const byTid = new Map(page.units.map((u) => [u.tid, u]));
  const policy: OverflowPolicy = opts.overflow ?? {
    mode: "shrink",
    minFontSizePt: 6,
  };

  for (const [tid, raw] of patches) {
    const unit = byTid.get(tid);

    if (!unit) {
      if (opts.strictUnknown) {
        report.rejected.push({ tid, reason: "未知 tid（越权）" });
      }
      continue;
    }

    if (raw === unit.text) continue;

    const s = sanitizeText(unit.text, raw, opts);
    if (!s.ok) {
      report.rejected.push({ tid, reason: s.reason });
      continue;
    }

    unit.fontSizeOverride = undefined;
    unit.clip = false;
    unit.wrap = false;

    const est = opts.measure
      ? await opts.measure(s.text, unit.fontSize, unit.sig)
      : estimateTextWidthPt(s.text, unit.fontSize);

    if (overflowAction(unit, est, policy) === "reject") {
      report.rejected.push({
        tid,
        reason: "新文本溢出钉位，需人工确认",
      });
      continue;
    }

    unit.text = s.text;
    report.changed++;
    report.changedTids.push(tid);
  }

  return report;
}

function overflowAction(
  u: Unit,
  estWidth: number,
  p: OverflowPolicy,
): "ok" | "reject" {
  const limit = u.width * 1.06 + 2;
  const over = estWidth > limit;

  switch (p.mode) {
    case "clip": {
      if (over) u.clip = true;
      return "ok";
    }

    case "wrap": {
      if (over) u.wrap = true;
      return "ok";
    }

    case "reject": {
      return over ? "reject" : "ok";
    }

    case "shrink": {
      if (!over) return "ok";

      const min = p.minFontSizePt ?? 6;
      const scaled = u.fontSize * (u.width / estWidth);

      if (scaled >= min) {
        u.fontSizeOverride = round1(scaled);
        return "ok";
      }

      u.fontSizeOverride = min;
      u.clip = true;
      return "ok";
    }
  }
}

export function htmlSkeleton(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>([^<]*)</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

export const assertStructureIntact = (
  before: string,
  after: string,
): boolean => htmlSkeleton(before) === htmlSkeleton(after);

export function validateEditedHtml(
  originalHtml: string,
  editedHtml: string,
): { ok: boolean; diff?: string } {
  const a = tokenizeTags(originalHtml);
  const b = tokenizeTags(editedHtml);

  if (a.length !== b.length) {
    return {
      ok: false,
      diff: `标签数量不同: ${a.length} vs ${b.length}`,
    };
  }

  for (let i = 0; i < a.length; i++) {
    const ta = a[i];
    const tb = b[i];

    if (ta.name !== tb.name || ta.close !== tb.close) {
      return {
        ok: false,
        diff: `第${i + 1}个标签不同: <${ta.close ? "/" : ""}${ta.name}> vs <${
          tb.close ? "/" : ""
        }${tb.name}>`,
      };
    }

    if (JSON.stringify(ta.attrs) !== JSON.stringify(tb.attrs)) {
      return {
        ok: false,
        diff: `标签 <${ta.name}> 的属性被修改`,
      };
    }
  }

  return { ok: true };
}

interface TagTok {
  name: string;
  close: boolean;
  attrs: Array<[string, string]>;
}

function tokenizeTags(html: string): TagTok[] {
  const toks: TagTok[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    const attrs: Array<[string, string]> = [];
    const attrText = m[3];

    const are =
      /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

    let a: RegExpExecArray | null;

    while ((a = are.exec(attrText))) {
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      attrs.push([a[1].toLowerCase(), value]);
    }

    attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

    toks.push({
      name: m[2].toLowerCase(),
      close: m[1] === "/",
      attrs,
    });
  }

  return toks;
}