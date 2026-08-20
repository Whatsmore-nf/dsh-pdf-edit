# @whatsmore-nf/dsh-plugin-pdf-edit

> [English](./README.en.md) | 中文

DeepSeek Harness 插件 —— AI 修改 PDF 文字，自动保持原版式不变。

## 这是什么

一个面向 PDF 文档的 AI 编辑插件。你用自然语言告诉它要改什么，它就会：

- **只改文字，不动排版** —— 字体、字号、颜色、位置全部锁定，改完和原文看起来一模一样
- **自动处理溢出** —— 新文字比原来长时，自动缩小字号或截断，不会撑破版面
- **支持中文** —— 自动识别并嵌入系统中文字体（SimHei / 微软雅黑 / Noto Sans CJK）

## 适合什么场景

| 场景 | 举例 |
|---|---|
| **术语统一** | 全文把「帐号」改成「账号」、「数据中台」改成「数据平台」 |
| **错别字修正** | 让 AI 扫一遍，自动修正拼写和语法错误 |
| **合同/报告批量修改** | 多页文档统一替换人名、金额、日期等 |
| **格式转换** | 把散乱的 PDF 重新排版成学术论文双栏、手机阅读单栏、商务简报等版式 |

## 安装

```bash
# 通过 Harness 插件 CLI（与官方插件一致）
dsh plugin --profile web add @whatsmore-nf/dsh-plugin-pdf-edit@latest

# 或直接通过 npm
npm install @whatsmore-nf/dsh-plugin-pdf-edit
```

## 更新记录

### v0.1.0

- 初始发布
- 样式锁定编辑：AI 修改文字，自动保持原排版
- native 渲染模式：pdf-lib 直绘，零浏览器依赖
- CJK 字体自动探测与嵌入
- 溢出处理：shrink / clip / wrap / reject
- 术语表全局替换
- 三种重排版模板：academic / mobile / briefing

## 工作原理

```
原 PDF ──▶ 提取文字+样式 ──▶ AI 生成修改 ──▶ 叠加绘制回 PDF
```

1. **提取**：用 pdfjs 读取每一页的文字内容，记录每个词的位置、字体、字号、颜色
2. **AI 修改**：把提取的文字发给 DeepSeek，AI 只返回需要改的文字片段
3. **叠加绘制**：用 pdf-lib 在原位置盖一个白色矩形遮住旧文字，再在同一位置用相同字体画上新文字

整个过程不需要打开浏览器，不需要安装 Chromium，纯 JavaScript 完成。

## 许可证

[MIT](./LICENSE)