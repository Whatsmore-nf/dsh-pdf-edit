import { escapeHtml } from "./util.js";

export type TemplateId = "academic" | "mobile" | "briefing";

export interface LayoutTemplate {
  id: TemplateId;
  name: string;
  pageSize: { widthPt: number; heightPt: number };
  css: string;
}

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const PHONE = { widthPt: 320, heightPt: 568 };

export const TEMPLATES: Record<TemplateId, LayoutTemplate> = {
  academic: {
    id: "academic",
    name: "学术双栏",
    pageSize: A4,
    css: `.doc-title{column-span:all;font-size:17pt;font-weight:700;text-align:center;margin:0 0 12pt}
.content{column-count:2;column-gap:18pt;column-rule:.5pt solid #ccc;font-size:9.5pt;line-height:1.55;text-align:justify}
h2{font-size:11.5pt;font-weight:700;margin:10pt 0 4pt;break-after:avoid}
h3{font-size:10.5pt;font-weight:700;margin:8pt 0 3pt}
p{margin:0 0 5pt;text-indent:2em}
p.caption{font-size:8pt;color:#555;text-indent:0;text-align:center;margin:2pt 0 8pt}`,
  },

  mobile: {
    id: "mobile",
    name: "手机单栏",
    pageSize: PHONE,
    css: `.doc-title{font-size:16pt;font-weight:700;line-height:1.35;margin:0 0 12pt}
.content{font-size:11pt;line-height:1.8}
h2{font-size:13pt;font-weight:700;margin:14pt 0 6pt}
h3{font-size:12pt;font-weight:700;margin:12pt 0 5pt}
p{margin:0 0 9pt}
p.caption{font-size:9pt;color:#777}`,
  },

  briefing: {
    id: "briefing",
    name: "商务简报",
    pageSize: A4,
    css: `.doc-title{font-size:22pt;font-weight:800;color:#0f2b46;border-bottom:3pt solid #2f6fed;padding-bottom:6pt;margin:0 0 14pt}
.content{font-size:10.5pt;line-height:1.65;color:#222}
h2{font-size:13pt;font-weight:700;color:#2f6fed;border-left:3pt solid #2f6fed;padding-left:6pt;margin:12pt 0 5pt;break-after:avoid}
h3{font-size:11.5pt;font-weight:700;color:#0f2b46;margin:10pt 0 4pt}
p{margin:0 0 7pt}
p.caption{font-size:8.5pt;color:#6a737d}`,
  },
};

export function fillTemplate(
  tpl: LayoutTemplate,
  title: string | null,
  bodyHtml: string,
): string {
  const head = title
    ? `<h1 class="doc-title">${escapeHtml(title)}</h1>`
    : "";

  return `<div class="doc">${head}<div class="content">${bodyHtml}</div></div>`;
}