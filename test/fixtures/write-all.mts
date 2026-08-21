// 把全部自建夹具按统一命名落盘到 test/.cache/fixtures/（gitignore），
// 供人工检查、issue 复现与外部工具比对。
import { writeFixtureFiles } from "../helpers/make-pdf.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, ".cache", "fixtures");

const files = await writeFixtureFiles(OUT);
console.log(`已写出 ${files.length} 个夹具 → ${OUT}`);
for (const f of files) console.log("  -", f);
