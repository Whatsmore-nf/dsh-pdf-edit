import { rgb } from "pdf-lib";
import type { Glossary } from "./types.js";

export const round1 = (n: number): number => Math.round(n * 10) / 10;

export function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function tokenizeText(s: string): string[] {
  return (
    s.match(
      /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|\s+|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g,
    ) ?? []
  );
}

export function wrapByMeasure(
  text: string,
  measure: (s: string) => number,
  maxW: number,
): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const tk of tokenizeText(text)) {
    if (cur && measure(cur + tk) > maxW) {
      lines.push(cur.trimEnd());
      cur = tk.trimStart();
    } else cur += tk;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [""];
}

export function ellipsizeByMeasure(
  text: string,
  measure: (s: string) => number,
  maxW: number,
): string {
  if (measure(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && measure(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function range(from: number, to: number): number[] {
  const r: number[] = [];
  for (let i = from; i <= to; i++) r.push(i);
  return r;
}

export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 容量上限缓存：Map 迭代顺序即插入顺序，get 命中后重插以刷新新鲜度，
 * set 超容量时淘汰最久未访问的条目（LRU）。
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity && this.capacity > 0) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, value);
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function pLimit(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };

      if (active < max) start();
      else queue.push(start);
    });
  };
}

export function hash32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

const NARROW = /[iljtf.,:;'`!|()[\]{}]/;

export function estimateTextWidthPt(text: string, fontSizePt: number): number {
  let em = 0;

  for (const ch of text) {
    if (ch === " ") em += 0.3;
    else if (WIDE.test(ch)) em += 1.0;
    else if (NARROW.test(ch)) em += 0.32;
    else if (ch >= "A" && ch <= "Z") em += 0.72;
    else if (ch >= "0" && ch <= "9") em += 0.56;
    else em += 0.52;
  }

  return em * fontSizePt;
}

export interface GlossaryTerm {
  from: string;
  to: string;
}

export function normalizeGlossary(g?: Glossary): GlossaryTerm[] {
  if (!g) return [];

  const list: GlossaryTerm[] = Array.isArray(g)
    ? g
    : Object.entries(g).map(([from, to]) => ({ from, to }));

  return list
    .filter((t) => t.from && t.to && t.from !== t.to)
    .sort((a, b) => b.from.length - a.from.length);
}

export function applyGlossary(text: string, terms: GlossaryTerm[]): string {
  let out = text;
  for (const t of terms) {
    out = out.split(t.from).join(t.to);
  }
  return out;
}