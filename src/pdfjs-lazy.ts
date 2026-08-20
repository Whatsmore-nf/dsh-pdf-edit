let mod: any = null;

export async function loadPdfjs(workerSrc?: string): Promise<any> {
  if (!mod) {
    // @ts-ignore
    mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (workerSrc && mod.GlobalWorkerOptions) {
      mod.GlobalWorkerOptions.workerSrc = workerSrc;
    }
  }
  return mod;
}