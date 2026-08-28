export type PreviewUrlOptions = {
  thumbnail?: boolean
  pageId?: string
}

export const resolvePageHtmlPath = (
  inputPath?: string,
  currentPageId?: string
): string | undefined => {
  if (!inputPath) return undefined
  if (!/[\\/]index\.html?$/i.test(inputPath)) return inputPath
  if (!currentPageId) return undefined
  return inputPath.replace(/index\.html?$/i, `${currentPageId}.html`)
}

export const applyPreviewUrlParams = (
  inputUrl: string,
  options: PreviewUrlOptions = {}
): string => {
  const url = new URL(inputUrl)
  url.searchParams.set('fit', 'off')
  url.searchParams.set('print', '1')
  url.searchParams.set('pptPlayback', '0')
  if (options.thumbnail) {
    url.searchParams.set('thumbnail', '1')
    if (options.pageId) url.searchParams.set('pageId', options.pageId)
  }
  return url.toString()
}

const encodePathSegments = (filePath: string): string =>
  filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

export const toPreviewFileUrl = (
  absolutePath: string,
  options: PreviewUrlOptions = {}
): string => {
  const normalizedPath = absolutePath.replace(/\\/g, '/')
  const fileUrl = /^[a-zA-Z]:\//.test(normalizedPath)
    ? `file:///${normalizedPath.slice(0, 2)}${encodePathSegments(normalizedPath.slice(2))}`
    : normalizedPath.startsWith('/')
      ? `file://${encodePathSegments(normalizedPath)}`
      : `file:///${encodePathSegments(normalizedPath)}`
  return applyPreviewUrlParams(fileUrl, options)
}

export const buildSafeVoidScript = (
  source: 'PreviewIframe' | 'HtmlEditorCanvas',
  label: string,
  script: string
): string => `
(() => {
  try {
    ${script}
  } catch (error) {
    const message = error && (error.stack || error.message || String(error));
    console.error(${JSON.stringify(`[${source}:${label}]`)}, message || "Unknown script error");
  }
})();
`
