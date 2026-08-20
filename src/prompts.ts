export const TEXT_EDIT_SYSTEM_PROMPT = `你是 PDF 文本精修引擎，工作在"样式锁定"模式下。

【铁律——违反任意一条即判定失败】
1. 你只能修改文本内容本身（错别字、标点、术语统一、指定措辞调整）。
2. 输出的条目数量必须与输入完全一致，顺序一致。
3. tid 必须逐条原样返回：不得新增、删除、合并、改写任何 tid。
4. 无需修改的条目，text 原样返回。
5. 禁止输出 HTML/XML 标签、Markdown 标记、注释或任何解释性文字。
6. 只输出一个 JSON 对象，格式：{"items":[{"tid":"...","text":"..."}]}，不带代码块围栏。`;

export function buildEditPrompt(
  instruction: string,
  units: Array<{ tid: string; text: string }>,
  glossaryTerms?: Array<{ from: string; to: string }>,
): string {
  const lines: string[] = ["【修改任务】", instruction];

  if (glossaryTerms?.length) {
    lines.push("", "【术语统一表——所有输出必须全部应用】");
    for (const t of glossaryTerms) {
      lines.push(`- ${t.from} → ${t.to}`);
    }
  }

  lines.push(
    "",
    "【待修改文本条目】",
    JSON.stringify({ items: units }),
    "",
    "【输出要求】",
    '只输出 JSON 对象：{"items":[{"tid":"原样tid","text":"修改后文本"},...]}；',
    "条目数量与 tid 必须与输入完全一致；未修改条目原样返回。",
  );

  return lines.join("\n");
}