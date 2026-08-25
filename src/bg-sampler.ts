/**
 * 背景色采样：从页面内容流中提取"填充矩形"清单，按画家算法（后画的在上）
 * 用补丁框中心点命中最上层的矩形填充色，替代固定白底补丁。
 *
 * 纯 JS 实现（扫描 Operator List），不渲染位图——保持零浏览器/零原生依赖，
 * 彩色背景合同、带底纹的证书等矢量背景场景可直接受益；图片/渐变背景
 * 无法表达时返回 null，调用方回退配置色。
 *
 * 注：pdf.js 求值器把内容流的 `re` 矩形分解为 moveTo/lineTo/closePath 子路径，
 * 因此这里对每个填充子路径做"轴对齐矩形"识别（所有点恰为包围盒四角），
 * 兼容显式 rectangle 路径操作码。旋转/斜切后的非轴对齐矩形不参与采样。
 */
import type { PDFPage } from "pdf-lib";

export interface FilledRect {
  /** 顶部原点坐标系（与 viewport scale=1 一致，y 向下） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
}

export type BgSampleFn = (
  x: number,
  y: number,
  w: number,
  h: number,
) => string | null;

const n255 = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v)));

const rgbHex = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** 3x2 矩阵乘法（列向量约定）：result = m × n */
function mul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyM(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** 点全部落在四角（容差内）且恰好张成两档 x / 两档 y → 轴对齐矩形 */
function tryAxisAlignedRect(pts: number[][]): [number, number, number, number] | null {
  if (pts.length < 4) return null;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (!isNum(x) || !isNum(y)) return null;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }

  const eps = 0.05;
  for (const [x, y] of pts) {
    const cx = Math.abs(x - x0) < eps || Math.abs(x - x1) < eps;
    const cy = Math.abs(y - y0) < eps || Math.abs(y - y1) < eps;
    if (!(cx && cy)) return null;
  }

  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return null;
  return [x0, y0, x1, y1];
}

/**
 * 扫描页面 Operator List，收集所有"填充的轴对齐矩形区域"。
 * viewH 为 scale=1 视口高度，用于把 PDF 底部原点坐标翻成顶部原点坐标
 * （与 extractor 输出的 unit 坐标系一致）。任何异常都吞掉并返回空表。
 */
export async function extractFilledRects(
  page: any,
  OPS: any,
  viewH: number,
): Promise<FilledRect[]> {
  try {
    const ops = await page.getOperatorList();
    const out: FilledRect[] = [];

    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    let fillColor = "#ffffff";
    /** 待定子路径（设备坐标点集）；fill 时逐个做矩形识别 */
    let subpaths: number[][][] = [];

    const pushPoint = (sub: number[][] | null, x: number, y: number) => {
      if (sub) sub.push(applyM(ctm, x, y));
    };

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const rawArgs = ops.argsArray[i];
      const args: any[] =
        Array.isArray(rawArgs)
          ? rawArgs
          : ArrayBuffer.isView(rawArgs) ||
              (typeof rawArgs === "object" && rawArgs !== null)
            ? Array.from(rawArgs ?? [])
            : [];

      if (fn === OPS.save) {
        stack.push(ctm.slice());
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? ctm;
      } else if (fn === OPS.transform) {
        if (args.length >= 6 && args.slice(0, 6).every(isNum)) {
          ctm = mul(args.slice(0, 6) as number[], ctm);
        }
      } else if (fn === OPS.setFillRGBColor) {
        fillColor = rgbHex(n255(args[0]), n255(args[1]), n255(args[2]));
      } else if (fn === OPS.setFillGray) {
        const g = n255(args[0]);
        fillColor = rgbHex(g, g, g);
      } else if (fn === OPS.setFillCMYKColor) {
        const [c = 0, m = 0, y = 0, k = 0] = args.map((v: number) =>
          v <= 1 ? v : v / 255,
        );
        const f = (v: number) => Math.round(255 * (1 - v) * (1 - k));
        fillColor = rgbHex(f(c), f(m), f(y));
      } else if (fn === OPS.constructPath) {
        const pathOps: number[] = args[0] ?? [];
        const coords: ArrayLike<number> = args[1] ?? [];
        let cur: number[][] | null = null;
        let cursor = 0;

        for (const po of pathOps) {
          const read = (n: number): Array<[number, number]> => {
            const outPts: Array<[number, number]> = [];
            for (let k = 0; k < n; k++) {
              outPts.push([coords[cursor++], coords[cursor++]]);
            }
            return outPts;
          };

          if (po === OPS.moveTo) {
            if (cur && cur.length >= 2) subpaths.push(cur);
            cur = [];
            const [[x, y]] = read(1);
            pushPoint(cur, x, y);
          } else if (po === OPS.lineTo || po === OPS.rectangle) {
            if (!cur) cur = [];
            if (po === OPS.rectangle) {
              // 显式矩形路径操作码：四角直接生成（pdf.js 通常已分解为线段，
              // 这里兜底兼容）
              const [rx, ry] = read(1)[0];
              const [rw, rh] = read(1)[0];
              if ([rx, ry, rw, rh].every(isNum)) {
                for (const [px, py] of [
                  [rx, ry],
                  [rx + rw, ry],
                  [rx + rw, ry + rh],
                  [rx, ry + rh],
                ] as const) {
                  pushPoint(cur, px, py);
                }
              }
            } else {
              const [[x, y]] = read(1);
              pushPoint(cur, x, y);
            }
          } else if (po === OPS.curveTo) {
            if (!cur) cur = [];
            const p = read(3);
            pushPoint(cur, p[2][0], p[2][1]); // 只取终点（矩形识别用不到控制点）
          } else if (po === OPS.curveTo2 || po === OPS.curveTo3) {
            if (!cur) cur = [];
            const p = read(2);
            pushPoint(cur, p[1][0], p[1][1]);
          } else if (po === OPS.closePath) {
            // 填充语义下未闭合子路径也视为闭合，无需额外处理
          } else {
            break; // 未知路径操作码 → 放弃该路径的矩形识别
          }
        }
        if (cur && cur.length >= 2) subpaths.push(cur);
      } else if (
        fn === OPS.fill ||
        fn === OPS.eoFill ||
        fn === OPS.fillStroke ||
        fn === OPS.eoFillStroke ||
        fn === OPS.closeFillStroke ||
        fn === OPS.closeEOFillStroke
      ) {
        for (const sp of subpaths) {
          const rect = tryAxisAlignedRect(sp);
          if (!rect) continue;
          const [dx0, dy0, dx1, dy1] = rect;
          // PDF 底部原点 → 顶部原点
          out.push({
            x0: dx0,
            y0: viewH - dy1,
            x1: dx1,
            y1: viewH - dy0,
            color: fillColor,
          });
        }
        subpaths = [];
      } else if (
        fn === OPS.stroke ||
        fn === OPS.closeStroke ||
        fn === OPS.endPath
      ) {
        // 路径被描边/裁剪消费而非填充，清空待定子路径
        subpaths = [];
      }
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * 工厂：矩形清单非空时返回采样函数；中心点未命中任何矩形（如纯白页、
 * 图片背景）返回 null，由调用方回退到配置的 patchColor。
 */
export function makeBgSampler(rects: FilledRect[]): BgSampleFn {
  return (x, y, w, h) => {
    const cx = x + w / 2;
    const cy = y + h / 2;
    let hit: string | null = null;
    for (const r of rects) {
      if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) {
        hit = r.color; // 后画的覆盖先画的：不断刷新即得最上层颜色
      }
    }
    return hit;
  };
}
