import type { FlowTheme } from "./layout-flow.js";

export type TemplateId = "academic" | "mobile" | "briefing";

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const PHONE = { widthPt: 320, heightPt: 568 };
const SERIF = "times",
  SANS = "helvetica";

export const FLOW_THEMES: Record<TemplateId, FlowTheme> = {
  academic: {
    pageSize: A4,
    margin: { top: 64, bottom: 64, left: 56, right: 56 },
    columns: 2,
    columnGapPt: 18,
    title: {
      family: SERIF,
      sizePt: 17,
      bold: true,
      align: "center",
      lineHeight: 1.3,
      after: 12,
    },
    h2: { family: SERIF, sizePt: 11.5, bold: true, before: 10, after: 4 },
    h3: { family: SERIF, sizePt: 10.5, bold: true, before: 8, after: 3 },
    body: {
      family: SERIF,
      sizePt: 9.5,
      lineHeight: 1.55,
      after: 5,
      indentEm: 2,
    },
    caption: {
      family: SERIF,
      sizePt: 8,
      color: "#555555",
      align: "center",
      after: 8,
    },
  },
  mobile: {
    pageSize: PHONE,
    margin: { top: 24, bottom: 24, left: 20, right: 20 },
    columns: 1,
    columnGapPt: 0,
    title: {
      family: SANS,
      sizePt: 16,
      bold: true,
      lineHeight: 1.35,
      after: 12,
    },
    h2: { family: SANS, sizePt: 13, bold: true, before: 14, after: 6 },
    h3: { family: SANS, sizePt: 12, bold: true, before: 12, after: 5 },
    body: { family: SANS, sizePt: 11, lineHeight: 1.8, after: 9 },
    caption: { family: SANS, sizePt: 9, color: "#777777", after: 6 },
  },
  briefing: {
    pageSize: A4,
    margin: { top: 56, bottom: 56, left: 56, right: 56 },
    columns: 1,
    columnGapPt: 0,
    title: {
      family: SANS,
      sizePt: 22,
      bold: true,
      color: "#0f2b46",
      after: 6,
      rule: { color: "#2f6fed", heightPt: 3 },
    },
    h2: {
      family: SANS,
      sizePt: 13,
      bold: true,
      color: "#2f6fed",
      before: 12,
      after: 5,
    },
    h3: {
      family: SANS,
      sizePt: 11.5,
      bold: true,
      color: "#0f2b46",
      before: 10,
      after: 4,
    },
    body: {
      family: SANS,
      sizePt: 10.5,
      lineHeight: 1.65,
      color: "#222222",
      after: 7,
    },
    caption: {
      family: SANS,
      sizePt: 8.5,
      color: "#6a737d",
      after: 6,
    },
  },
};