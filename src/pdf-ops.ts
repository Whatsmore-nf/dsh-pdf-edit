import { PDFDocument } from "pdf-lib";

export async function replacePages(
  original: Uint8Array,
  replacements: Map<number, Uint8Array>,
): Promise<Uint8Array> {
  if (replacements.size === 0) {
    return original.slice();
  }

  const src = await PDFDocument.load(original, { ignoreEncryption: true });
  const total = src.getPageCount();

  const out = await PDFDocument.create();
  copyMetadata(src, out);

  let i = 1;

  while (i <= total) {
    if (replacements.has(i)) {
      const single = await PDFDocument.load(replacements.get(i)!, {
        ignoreEncryption: true,
      });

      const [pg] = await out.copyPages(single, [0]);
      out.addPage(pg);
      i++;
    } else {
      let j = i;
      while (j <= total && !replacements.has(j)) j++;

      const idx: number[] = [];
      for (let k = i; k < j; k++) idx.push(k - 1);

      const pages = await out.copyPages(src, idx);
      for (const pg of pages) out.addPage(pg);

      i = j;
    }
  }

  return out.save();
}

export async function replaceEntireDocument(
  newBytes: Uint8Array,
  metaSource: Uint8Array,
): Promise<Uint8Array> {
  const meta = await PDFDocument.load(metaSource, { ignoreEncryption: true });
  const doc = await PDFDocument.load(newBytes, { ignoreEncryption: true });

  copyMetadata(meta, doc);
  return doc.save();
}

function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  try {
    to.setTitle(from.getTitle() ?? "");
    to.setAuthor(from.getAuthor() ?? "");
    to.setSubject(from.getSubject() ?? "");

    const keywords = from.getKeywords();
    if (keywords) {
      to.setKeywords(Array.isArray(keywords) ? keywords : [keywords]);
    }

    to.setProducer(from.getProducer() ?? "style-locked-editor");
    to.setCreator(from.getCreator() ?? "style-locked-editor");

    const d = from.getCreationDate();
    if (d) to.setCreationDate(d);

    const m = from.getModificationDate();
    if (m) to.setModificationDate(m);
  } catch {
    // 元数据缺失不影响正文
  }
}