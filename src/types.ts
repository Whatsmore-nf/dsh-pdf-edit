export interface StyleSignature {
  fontFamily: string;
  fontSizePt: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface Unit {
  tid: string;
  text: string;
  x: number;
  top: number;
  width: number;
  fontSize: number;
  className: string;
  sig: StyleSignature;
  fontSizeOverride?: number;
  clip?: boolean;
  wrap?: boolean;
  baselineTop: number;
}

export interface EditableUnit {
  tid: string;
  text: string;
}

export interface PageBackground {
  dataUrl: string;
  widthPt: number;
  heightPt: number;
}

export interface PageExtract {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  css: string;
  html: string;
  units: Unit[];
  background?: PageBackground;
  dirtyTids?: Set<string>;
}

export type OverflowMode = "clip" | "shrink" | "reject" | "wrap";

export interface OverflowPolicy {
  mode: OverflowMode;
  minFontSizePt?: number;
}

export type Glossary =
  | Record<string, string>
  | Array<{ from: string; to: string }>;

export interface FontResource {
  family: string;
  src: string;
  format?: string;
  weight?: number;
  style?: "normal" | "italic";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export type ChatFn = (
  messages: ChatMessage[],
  opts?: ChatOptions,
) => Promise<string>;

export interface LLMAdapter {
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export type Stage =
  | "extract"
  | "ai"
  | "render"
  | "skip"
  | "merge"
  | "error";

export interface ProgressInfo {
  stage: Stage;
  done: number;
  total: number;
  page?: number;
  message?: string;
}

export type ProgressFn = (info: ProgressInfo) => void;

export interface PdfEditToolParams {
  pdfPath: string;
  instruction: string;
  pages?: number[];
  outputDir?: string;
  glossary?: Glossary;
  overflow?: OverflowPolicy;
  background?: "none" | "image";
  templateId?: "academic" | "mobile" | "briefing";
}