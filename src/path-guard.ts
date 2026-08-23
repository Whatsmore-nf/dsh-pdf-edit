/**
 * 路径安全守卫：工具入参的 pdfPath/outputPath 在进入 readFileSync/writeFileSync 前必须过闸。
 *
 * 威胁模型：PDF 内嵌 prompt injection 文本 → LLM 返回恶意参数 → 宿主转成工具调用 →
 * 以宿主进程权限读写任意文件。本模块把可读写范围收敛到白名单根目录内。
 */
import { resolve, dirname, parse, relative, isAbsolute } from "node:path";
import { statSync, accessSync, realpathSync, constants } from "node:fs";

export interface PathGuardOptions {
  /** 允许读写的根目录（绝对路径）。空数组 = 禁用一切文件操作 */
  allowedRoots?: string[];
  /** 允许的文件扩展名（小写，含点），默认 [".pdf"] */
  allowedExtensions?: string[];
  /** 单文件大小上限（字节），默认 100MB */
  maxFileSize?: number;
}

export const DEFAULT_PATH_GUARD: Required<PathGuardOptions> = {
  allowedRoots: [],
  allowedExtensions: [".pdf"],
  maxFileSize: 100 * 1024 * 1024,
};

function assertClean(p: string, label: string): void {
  // 拒绝 null byte 与控制字符（可绕过扩展名/目录检查）
  if (/[\x00-\x1f]/.test(p)) throw new Error(`${label}包含非法控制字符`);
}

/** abs 是否落在 roots 某个根之下（跨平台：用 relative 而非字符串前缀） */
function underRoot(abs: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(resolve(root), abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * 合并配置根目录与本次调用额外放行的根目录（去重、保序）。
 * GUI 工作目录常与 dsh 服务 cwd 不一致，允许按调用临时放行是工具层的兜底。
 */
export function withExtraRoots(
  configured: string[] | undefined,
  extra: string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...(configured ?? []), ...(extra ?? [])]) {
    const abs = resolve(r);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/** 人类可读的允许根目录列表（供报错提示） */
export function rootsText(roots: string[]): string {
  return roots.length ? roots.join("、") : "（未配置任何根目录）";
}

function checkExtension(abs: string, exts: string[]): void {
  const ext = parse(abs).ext.toLowerCase();
  if (!exts.includes(ext)) {
    throw new Error(`不支持的文件类型 "${ext}"，仅允许 ${exts.join("/")}`);
  }
}

/**
 * 校验输入路径：规范化 → 白名单 → 扩展名 → 存在性/类型/大小。
 * 返回 realpath（解析符号链接，防止用链接逃出白名单）。
 */
export function validateInputPath(
  rawPath: string,
  opts: PathGuardOptions = {},
): string {
  const o = { ...DEFAULT_PATH_GUARD, ...opts };

  if (!rawPath || typeof rawPath !== "string") throw new Error("pdfPath 不能为空");
  assertClean(rawPath, "pdfPath ");

  const abs = resolve(rawPath);
  if (!o.allowedRoots.length) throw new Error("未配置 allowedRoots，已禁止所有文件读取");
  if (!underRoot(abs, o.allowedRoots)) {
    throw new Error(
      `路径 ${abs} 不在允许的目录范围内（当前允许：${rootsText(o.allowedRoots)}；可在工具参数或插件配置中放行）`,
    );
  }

  let real: string;
  try {
    real = realpathSync(abs); // 符号链接指向白名单外 → 得到的 realpath 会越界
  } catch {
    throw new Error(`文件不存在或不可访问: ${abs}`);
  }
  if (!underRoot(real, o.allowedRoots)) {
    throw new Error(
      `路径经符号链接解析后越界: ${abs} -> ${real}（允许：${rootsText(o.allowedRoots)}）`,
    );
  }

  const st = statSync(real);
  if (!st.isFile()) throw new Error("目标不是普通文件");
  checkExtension(real, o.allowedExtensions);
  if (st.size > o.maxFileSize) {
    throw new Error(`文件超过大小限制 (${o.maxFileSize} 字节)`);
  }
  return real;
}

/**
 * 校验输出路径：
 *  - 未提供时由输入路径派生（suffix 默认 ".edited.pdf"）
 *  - 必须与输入同目录，或落在白名单根目录内
 *  - 扩展名白名单；父目录必须存在且可写
 */
export function validateOutputPath(
  rawPath: string | undefined,
  inputAbs: string,
  opts: PathGuardOptions = {},
  defaultSuffix = ".edited.pdf",
): string {
  const o = { ...DEFAULT_PATH_GUARD, ...opts };

  let abs: string;
  if (rawPath) {
    if (typeof rawPath !== "string") throw new Error("outputPath 类型非法");
    assertClean(rawPath, "outputPath ");
    abs = resolve(rawPath);
  } else {
    // 与原实现一致：foo.pdf / foo.PDF → foo.edited.pdf
    abs = resolve(inputAbs.replace(/\.pdf$/i, "") + defaultSuffix);
  }

  const inputDir = dirname(inputAbs);
  const dirAllowed =
    dirname(abs) === inputDir ||
    (o.allowedRoots.length > 0 && underRoot(abs, o.allowedRoots));
  if (!dirAllowed) {
    throw new Error(
      `输出路径 ${abs} 不在输入同目录或允许的目录范围内（当前允许：${rootsText(o.allowedRoots)}）`,
    );
  }
  checkExtension(abs, o.allowedExtensions);

  // 父目录存在且可写（realpath 解析父级符号链接后仍需在白名单内）
  const parent = dirname(abs);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
    accessSync(realParent, constants.W_OK);
  } catch {
    throw new Error(`输出目录不存在或不可写: ${parent}`);
  }
  if (
    realParent !== inputDir &&
    !underRoot(realParent, o.allowedRoots)
  ) {
    throw new Error(`输出目录经符号链接解析后越界: ${parent} -> ${realParent}`);
  }

  return abs;
}
