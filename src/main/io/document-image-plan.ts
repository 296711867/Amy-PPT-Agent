/** 图片解析：图片→PPT 计划与图片→Markdown 参考文档两条视觉模型链路。 */
import fs from 'fs'
import path from 'path'
import { invokeVisionModelText } from '../agent-runtime/provider/vision'
import type { ModelRuntimeConfig } from '../agent-runtime/model'
import type { ParsedDocumentPlanResult } from '@shared/generation'
import { assertImageWasRead, isImageUnsupportedError } from '../styles/import/image'
import type { PreparedSourceFile } from './document-source-preparation'
import { IMAGE_MIME_BY_EXTENSION, compactText } from './document-source-preparation'
import { MAX_PAGE_COUNT, isMostlyChineseText } from './document-plan-quality'

const buildImageDocumentPlanPrompt = (args: {
  topic: string
  existingBrief: string
  fileName: string
  retryHint?: string
}): string =>
  [
    'Analyze the attached image or screenshot and produce the fixed structure needed by the PPT creation form.',
    'The image is attached to this same message as a multimodal image block. Do not look for a file upload tool, file path, or external attachment.',
    'You must directly inspect the attached image content before answering.',
    '',
    'Return only a JSON object. Do not return Markdown, explanations, or extra fields.',
    'Use exactly these fields: topic, pageCount, briefText.',
    '',
    'Interpretation rules:',
    '- If the image is a slide, dashboard, poster, whiteboard, document screenshot, product screenshot, chart, or design mockup, infer the presentation topic and outline from visible text, chart labels, layout, and visual context.',
    '- If visible text is limited, produce a conservative editable brief based on what can be observed. Do not invent exact numbers or facts that are not visible.',
    '- Preserve visible names, metrics, labels, dates, and terminology when they are readable.',
    '- Mention uncertainty explicitly inside briefText when image content is ambiguous.',
    '- Treat the image as an input reference only. Do not assume the original image will be available during later slide generation.',
    '- Therefore briefText must fully capture both the content reference and the visual style reference needed for generation.',
    '',
    'Output language rules:',
    '- Use the dominant language visible in the image and the latest user-provided topic/brief.',
    '- If the user explicitly asks for a language, use that language.',
    '- If the image is primarily Chinese, use Chinese section labels such as 演示目标、受众/场景、核心观点、建议大纲、每页要点、必须保留的事实/指标/术语、风格/表达要求.',
    '- If the image is primarily English, use English section labels.',
    '',
    'Field rules:',
    '- topic: a concise title suitable for the creation form topic input.',
    `- pageCount: an integer from 1 to ${MAX_PAGE_COUNT}.`,
    '- pageCount means the target number of PPT slides to generate from this image/reference. It is not the number of attached images.',
    '- Use pageCount=1 only for a single simple visual with one presentation point; if the image contains multiple sections, panels, metrics, or a document-like screenshot, infer a multi-slide deck.',
    '- briefText: a concise but structured outline suitable for the creation form detailed-brief input.',
    '- briefText should include presentation goal, audience/context, core argument, recommended outline, per-page points, facts/metrics/terms to preserve, and visual/style reference.',
    '- visual/style reference should cover approximate colors, background, typography feel, layout density, alignment, cards/shapes/borders/shadows, chart style, image/illustration style, and any mood or motion guidance that would help recreate the look.',
    '- The recommended outline and per-page points should align with pageCount.',
    '- Infer the target PPT slide count from the image structure. Do not return 1 merely because one image was attached.',
    args.retryHint
      ? `\nRetry requirement: the previous output failed validation because: ${args.retryHint}. Fix this issue. Ensure briefText is non-empty and pageCount matches the page-level outline.`
      : '',
    args.topic
      ? `\nUser-provided topic: ${args.topic}`
      : '\nThe user did not provide a topic; infer it from the image.',
    args.existingBrief ? `\nExisting user brief:\n${args.existingBrief}` : '',
    `\nImage file name: ${args.fileName}`,
    '',
    'Return format examples:',
    '{"topic":"AI动漫产业发展分析","pageCount":7,"briefText":"演示目标：...\\n受众/场景：...\\n核心观点：...\\n建议大纲：\\n1. ...\\n每页要点：\\n第 1 页：...\\n必须保留的事实/指标/术语：...\\n风格/表达要求：..."}',
    '{"topic":"Product Launch Readiness Review","pageCount":8,"briefText":"Presentation goal: ...\\nAudience/context: ...\\nCore argument: ...\\nRecommended outline:\\n1. ...\\nPer-page points:\\nPage 1: ...\\nFacts/metrics/terms to preserve: ...\\nStyle or expression notes: ..."}'
  ].join('\n')

// Image plan parsing is for creation-form suggestions and writes a structured
// reference file from the accepted plan.
export const writeImagePlanReferenceFile = async (args: {
  file: PreparedSourceFile
  plan: Pick<ParsedDocumentPlanResult, 'topic' | 'pageCount' | 'briefText'>
}): Promise<PreparedSourceFile> => {
  const ext = path.extname(args.file.workspacePath).toLowerCase()
  const mdPath = args.file.workspacePath.replace(/\.[^.]+$/, '.image.md')
  const briefText = compactText(args.plan.briefText)
  if (!briefText) throw new Error('图片解析完成，但模型未返回可用参考内容')
  const useChineseLabels = isMostlyChineseText(`${args.plan.topic}\n${briefText}`)
  const markdown = [
    `# ${path.basename(args.file.name, ext) || (useChineseLabels ? '图片参考' : 'Image reference')}`,
    '',
    `> Source image: ${args.file.name}`,
    '> This file was generated after the user explicitly parsed the uploaded image, so later generation can use it as text reference.',
    '',
    `## ${useChineseLabels ? '主题' : 'Topic'}`,
    '',
    args.plan.topic,
    '',
    `## ${useChineseLabels ? '建议页数' : 'Suggested page count'}`,
    '',
    String(args.plan.pageCount),
    '',
    `## ${useChineseLabels ? '图片解析参考' : 'Image analysis reference'}`,
    '',
    briefText
  ].join('\n')
  await fs.promises.writeFile(mdPath, markdown, 'utf-8')

  return {
    ...args.file,
    name: `${args.file.name}.image.md`,
    type: 'markdown',
    characterCount: markdown.length,
    path: mdPath,
    workspacePath: mdPath,
    virtualPath: `/${path.basename(mdPath)}`
  }
}

// Image plan parsing is for creation-form suggestions: topic/pageCount/briefText.
// This separate image-reference path only converts an image into readable source notes.
const buildImageReferenceMarkdownPrompt = (fileName: string): string =>
  [
    'Analyze the attached image or screenshot and convert it into a readable Markdown reference document.',
    'The image is attached to this same message as a multimodal image block. Directly inspect the image before answering.',
    '',
    'Return Markdown only. Do not return JSON. Do not include task explanations.',
    'Do not generate a PPT outline, page count, slide plan, or creation-form suggestions. Only organize what can be read or observed from the image.',
    '',
    `# 图片参考：${fileName}`,
    '',
    'Required sections:',
    '## 可见文字',
    '- Transcribe readable text, headings, labels, chart labels, names, metrics, dates, and terminology. Keep the original language.',
    '- Preserve line breaks or hierarchy when they are visible.',
    '## 内容整理',
    '- Organize the observed content into concise Markdown bullets or tables when helpful.',
    '- Mark uncertain or unreadable items clearly instead of guessing.',
    '## 视觉信息',
    '- Briefly describe visible layout, chart/table/UI structure, colors, and other visual cues that may help later generation.',
    '',
    'Rules:',
    '- Do not invent exact numbers or facts that are not visible.',
    '- If text is unreadable, say it is unreadable.',
    '- If the image is mainly visual with little text, describe only the observable visual content.'
  ].join('\n')

export const convertImageReferenceToMarkdown = async (args: {
  file: PreparedSourceFile
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  maxTokens: number | undefined
  modelRuntime: ModelRuntimeConfig
  modelTimeoutMs: number
}): Promise<PreparedSourceFile> => {
  const ext = path.extname(args.file.workspacePath).toLowerCase()
  const mimeType = IMAGE_MIME_BY_EXTENSION[ext]
  if (!mimeType) throw new Error('暂只支持 png、jpg、jpeg、webp 图片')

  const imageBase64 = (await fs.promises.readFile(args.file.workspacePath)).toString('base64')
  let markdown = ''
  try {
    markdown = await invokeVisionModelText({
      imageBase64,
      mimeType,
      prompt: buildImageReferenceMarkdownPrompt(args.file.name),
      provider: args.provider,
      apiKey: args.apiKey,
      model: args.model,
      baseUrl: args.baseUrl,
      maxTokens: args.maxTokens,
      modelRuntime: args.modelRuntime,
      modelTimeoutMs: args.modelTimeoutMs,
      logTag: 'documents:parseImageReference'
    })
  } catch (error) {
    if (isImageUnsupportedError(error)) {
      throw new Error('当前模型不支持图片解析，请在设置中切换到支持多模态的模型')
    }
    throw error
  }

  const content = compactText(markdown)
  assertImageWasRead(content)
  if (!content) throw new Error('图片解析完成，但模型未返回可用内容')

  const mdPath = args.file.workspacePath.replace(/\.[^.]+$/, '.image.md')
  await fs.promises.writeFile(
    mdPath,
    [
      `# ${path.basename(args.file.name, ext) || '图片参考'}`,
      '',
      `> Source image: ${args.file.name}`,
      '> This file was generated after the user explicitly parsed the uploaded image into a readable Markdown reference.',
      '',
      content
    ].join('\n'),
    'utf-8'
  )

  return {
    ...args.file,
    name: `${args.file.name}.image.md`,
    type: 'markdown',
    characterCount: content.length,
    path: mdPath,
    workspacePath: mdPath,
    virtualPath: `/${path.basename(mdPath)}`
  }
}

export const runImageDocumentPlanModel = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  maxTokens: number | undefined
  modelRuntime: ModelRuntimeConfig
  modelTimeoutMs: number
  file: PreparedSourceFile
  topic: string
  existingBrief: string
  retryHint?: string
}): Promise<string> => {
  const ext = path.extname(args.file.workspacePath).toLowerCase()
  const mimeType = IMAGE_MIME_BY_EXTENSION[ext]
  if (!mimeType) throw new Error('暂只支持 png、jpg、jpeg、webp 图片')

  const imageBase64 = (await fs.promises.readFile(args.file.workspacePath)).toString('base64')
  const prompt = buildImageDocumentPlanPrompt({
    topic: args.topic,
    existingBrief: args.existingBrief,
    fileName: args.file.name,
    retryHint: args.retryHint
  })
  try {
    return await invokeVisionModelText({
      imageBase64,
      mimeType,
      prompt,
      provider: args.provider,
      apiKey: args.apiKey,
      model: args.model,
      baseUrl: args.baseUrl,
      maxTokens: args.maxTokens,
      modelRuntime: args.modelRuntime,
      modelTimeoutMs: args.modelTimeoutMs,
      logTag: 'documents:parsePlan:image'
    })
  } catch (error) {
    if (isImageUnsupportedError(error)) {
      throw new Error('当前模型不支持图片解析，请在设置中切换到支持多模态的模型')
    }
    throw error
  }
}
