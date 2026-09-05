import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main.js'
import type { SlideSizePreset } from '@shared/slide-size'
import type { QualityViolation } from './page-quality-validator'

type RenderedRect = {
  x: number
  y: number
  width: number
  height: number
}

export type RenderedTextSnapshot = {
  id: string
  groupId: string
  text: string
  rect: RenderedRect
  clipped: boolean
}

export type RenderedPageSnapshot = {
  scale: number
  canvas: RenderedRect
  texts: RenderedTextSnapshot[]
  metrics?: RenderedPageMetrics
}

export type RenderedTextStyleMetric = {
  text: string
  rect: RenderedRect
  fontFamily: string
  fontSize: number
  color: string
  lineCount: number
}

export type RenderedPageMetrics = {
  title?: RenderedTextStyleMetric
  bodyFontFamily?: string
  textBounds?: RenderedRect
  textCharacters: number
  elementCount: number
  visualCount: number
  cardCount: number
  backgroundColor: string
  dominantColors: string[]
  layoutSignature: string
}

export type RenderedPageValidationResult = {
  available: boolean
  violations: QualityViolation[]
  unavailableReason?: string
}

const SCALE_FLOOR = 0.92
const EDGE_TOLERANCE_PX = 2
const OVERLAP_MIN_RATIO = 0.2
const OVERLAP_MIN_AXIS_PX = 3
// 环境抖动（高负载、冷启动、GPU 初始化）会让整套页面全部超时。策略：
// 1) 校验窗口跨页复用，超时后只 stop 当前加载、不销毁窗口，避免每页付完整冷启动；
// 2) loadURL 单独限界，卡住的加载主动 stop 并用同一个暖窗口重试一次；
// 3) 最终仍超时按"基础设施不可用"上报，由 deck 门禁降级为非阻断（见 deck-render-gate）。
const VALIDATION_TIMEOUT_MS = 25_000
const PAGE_LOAD_TIMEOUT_MS = 15_000
const VALIDATION_TIMEOUT_ATTEMPTS = 2
const MASTER_STYLE_TIMEOUT_MS = 5_000
const RENDER_TIMEOUT_COOLDOWN_MS = 60 * 60_000
let renderTimeoutCooldownUntil = 0
let renderTimeoutCooldownReason = ''
const intersection = (a: RenderedRect, b: RenderedRect): RenderedRect => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  }
}

const outsideCanvas = (rect: RenderedRect, canvas: RenderedRect): boolean =>
  rect.x < canvas.x - EDGE_TOLERANCE_PX ||
  rect.y < canvas.y - EDGE_TOLERANCE_PX ||
  rect.x + rect.width > canvas.x + canvas.width + EDGE_TOLERANCE_PX ||
  rect.y + rect.height > canvas.y + canvas.height + EDGE_TOLERANCE_PX

const summarizeText = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 34 ? `${normalized.slice(0, 34)}...` : normalized
}

/** Pure classification kept separate from Electron so thresholds can be regression-tested. */
export function classifyRenderedPageSnapshot(snapshot: RenderedPageSnapshot): QualityViolation[] {
  const violations: QualityViolation[] = []

  if (Number.isFinite(snapshot.scale) && snapshot.scale < SCALE_FLOOR) {
    violations.push({
      code: 'render-scale-too-small',
      severity: 'error',
      detail: `页面内容必须整体缩放到 ${(snapshot.scale * 100).toFixed(1)}% 才能放入画布，低于 ${Math.round(SCALE_FLOOR * 100)}% 下限`,
      fix: '精简文字、减少并列模块或重新分配版面空间；不要依赖整体缩小来塞入内容'
    })
  }

  const outside = snapshot.texts.filter((entry) => outsideCanvas(entry.rect, snapshot.canvas))
  if (outside.length > 0) {
    violations.push({
      code: 'render-text-outside-canvas',
      severity: 'error',
      detail: `${outside.length} 处文字越出 PPT 画布：${outside
        .slice(0, 4)
        .map((entry) => `“${summarizeText(entry.text)}”`)
        .join('、')}`,
      fix: '把越界文字移回安全区；检查 absolute 定位、固定宽高、负 margin 和过长不换行文字'
    })
  }

  const clipped = snapshot.texts.filter((entry) => entry.clipped)
  if (clipped.length > 0) {
    violations.push({
      code: 'render-text-clipped',
      severity: 'error',
      detail: `${clipped.length} 处文字被 overflow 容器裁切：${clipped
        .slice(0, 4)
        .map((entry) => `“${summarizeText(entry.text)}”`)
        .join('、')}`,
      fix: '增加文本容器高度或宽度、允许合理换行并精简文案；不要用 overflow:hidden 掩盖溢出文字'
    })
  }

  const overlapPairs: Array<[RenderedTextSnapshot, RenderedTextSnapshot]> = []
  const visibleTexts = snapshot.texts.filter(
    (entry) => entry.rect.width >= OVERLAP_MIN_AXIS_PX && entry.rect.height >= OVERLAP_MIN_AXIS_PX
  )
  for (let i = 0; i < visibleTexts.length && overlapPairs.length < 6; i += 1) {
    const left = visibleTexts[i]
    for (let j = i + 1; j < visibleTexts.length && overlapPairs.length < 6; j += 1) {
      const right = visibleTexts[j]
      if (left.groupId === right.groupId) continue
      const overlap = intersection(left.rect, right.rect)
      if (overlap.width < OVERLAP_MIN_AXIS_PX || overlap.height < OVERLAP_MIN_AXIS_PX) continue
      const overlapArea = overlap.width * overlap.height
      const smallerArea = Math.min(
        left.rect.width * left.rect.height,
        right.rect.width * right.rect.height
      )
      if (smallerArea <= 0 || overlapArea / smallerArea < OVERLAP_MIN_RATIO) continue
      overlapPairs.push([left, right])
    }
  }
  if (overlapPairs.length > 0) {
    violations.push({
      code: 'render-text-overlap',
      severity: 'error',
      detail: `检测到 ${overlapPairs.length} 组明显文字重叠：${overlapPairs
        .slice(0, 3)
        .map(([left, right]) => `“${summarizeText(left.text)}” / “${summarizeText(right.text)}”`)
        .join('；')}`,
      fix: '重新分配文本框位置和尺寸，统一间距；必要时精简文案，禁止用遮挡或裁切隐藏内容'
    })
  }

  return violations
}

const COLLECT_RENDERED_PAGE_SNAPSHOT_SCRIPT = `
(async () => {
  if (document.fonts && document.fonts.ready) {
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const root = document.querySelector('.ppt-page-root[data-ppt-guard-root="1"]');
  if (!root) throw new Error('render-root-missing');
  const scope = root.querySelector(':scope > .ppt-page-fit-scope');
  const rootRect = root.getBoundingClientRect();
  const transform = scope ? getComputedStyle(scope).transform : 'none';
  let scale = 1;
  if (transform && transform !== 'none') {
    const matrix = new DOMMatrixReadOnly(transform);
    scale = Math.hypot(matrix.a, matrix.b);
  }

  const rectOf = (rect) => ({
    x: Number(rect.x.toFixed(2)),
    y: Number(rect.y.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2))
  });
  const clipsRange = (rangeRect, parent) => {
    let current = parent;
    while (current && current !== root.parentElement) {
      const style = getComputedStyle(current);
      const clipsX = /(hidden|clip|auto|scroll)/.test(style.overflowX);
      const clipsY = /(hidden|clip|auto|scroll)/.test(style.overflowY);
      if (clipsX || clipsY) {
        const bounds = current.getBoundingClientRect();
        if (
          (clipsX &&
            (rangeRect.left < bounds.left - 2 || rangeRect.right > bounds.right + 2)) ||
          (clipsY &&
            (rangeRect.top < bounds.top - 2 || rangeRect.bottom > bounds.bottom + 2))
        ) {
          return true;
        }
      }
      current = current.parentElement;
    }
    return false;
  };

  const texts = [];
  const layoutTextRects = [];
  let textCharacters = 0;
  const bodyFontWeights = new Map();
  const colorWeights = new Map();
  const groups = new WeakMap();
  let groupCursor = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let textCursor = 0;
  while (node && texts.length < 240) {
    const parent = node.parentElement;
    const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && parent && !parent.closest('script,style,svg,canvas,.katex')) {
      const style = getComputedStyle(parent);
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.02
      ) {
        textCharacters += text.replace(/\\s+/g, '').length;
        if (!groups.has(parent)) groups.set(parent, 'g' + groupCursor++);
        const range = document.createRange();
        range.selectNodeContents(node);
        Array.from(range.getClientRects()).forEach((rect, rectIndex) => {
          if (rect.width < 1 || rect.height < 1 || texts.length >= 240) return;
          texts.push({
            id: 't' + textCursor + ':' + rectIndex,
            groupId: groups.get(parent),
            text,
            rect: rectOf(rect),
            clipped: clipsRange(rect, parent)
          });
        });
        const weight = Math.max(1, text.replace(/\\s+/g, '').length);
        const isAuxiliary = Boolean(parent.closest('footer,small,figcaption,[data-ppt-text-role="auxiliary"],[data-role="footer"],[data-role="footnote"],[data-role="source"],[data-role="annotation"],[data-role="page-number"]'));
        const isTitle = Boolean(parent.closest('[data-role="title"],[data-block-id="title"],h1,h2,h3,h4,h5,h6'));
        if (!isAuxiliary) {
          layoutTextRects.push(...Array.from(range.getClientRects()).map(rectOf));
        }
        if (!isAuxiliary && !isTitle) {
          bodyFontWeights.set(style.fontFamily, (bodyFontWeights.get(style.fontFamily) || 0) + weight);
        }
        colorWeights.set(style.color, (colorWeights.get(style.color) || 0) + weight);
        range.detach();
        textCursor += 1;
      }
    }
    node = walker.nextNode();
  }

  const titleElement = root.querySelector('[data-role="title"],[data-block-id="title"],h1,h2,h3,h4,h5,h6');
  let title;
  if (titleElement && titleElement.textContent && titleElement.textContent.trim()) {
    const rect = titleElement.getBoundingClientRect();
    const style = getComputedStyle(titleElement);
    const range = document.createRange();
    range.selectNodeContents(titleElement);
    title = {
      text: titleElement.textContent.replace(/\\s+/g, ' ').trim(),
      rect: rectOf(rect),
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize || '0'),
      color: style.color,
      lineCount: Math.max(1, new Set(Array.from(range.getClientRects()).filter((item) => item.width > 1 && item.height > 1).map((item) => Math.round(item.top / 3))).size)
    };
    range.detach();
  }

  const visibleElements = Array.from(root.querySelectorAll('*')).filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.02;
  });
  visibleElements.forEach((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.backgroundColor && !/rgba?\\(0, 0, 0, 0\\)|transparent/.test(style.backgroundColor)) {
      const weight = Math.max(1, Math.min(rect.width * rect.height, rootRect.width * rootRect.height) / 10000);
      colorWeights.set(style.backgroundColor, (colorWeights.get(style.backgroundColor) || 0) + weight);
    }
  });

  const unionRects = (rects) => {
    if (!rects.length) return undefined;
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return rectOf({ x: left, y: top, width: right - left, height: bottom - top });
  };
  const cardPattern = /(?:^|\\s)(?:card|panel|tile)(?:\\s|$)|rounded-(?:xl|2xl|3xl)[\\s\\S]*(?:shadow|border)|(?:shadow|border)[\\s\\S]*rounded-(?:xl|2xl|3xl)/i;
  const visualSelector = 'img,picture,video,canvas,svg,figure,table,[data-chart],[data-ppt-chart],[data-role="image-placeholder"]';
  const majorElements = visibleElements.filter((element) => {
    if (element === root || element.matches('html,body,.ppt-page-fit-scope,.ppt-page-content,[data-page-scaffold="1"],main[data-role="content"]')) return false;
    const rect = element.getBoundingClientRect();
    const areaRatio = (rect.width * rect.height) / Math.max(1, rootRect.width * rootRect.height);
    if (areaRatio < 0.025 || areaRatio > 0.92) return false;
    return element.matches('article,aside,figure,table,img,picture,video,canvas,svg,[data-block-id],[data-role="image-placeholder"]');
  });
  const signatureParts = majorElements.slice(0, 16).map((element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(3, Math.floor(((rect.x - rootRect.x) / Math.max(1, rootRect.width)) * 4)));
    const y = Math.max(0, Math.min(2, Math.floor(((rect.y - rootRect.y) / Math.max(1, rootRect.height)) * 3)));
    const w = Math.max(1, Math.min(4, Math.round((rect.width / Math.max(1, rootRect.width)) * 4)));
    const h = Math.max(1, Math.min(3, Math.round((rect.height / Math.max(1, rootRect.height)) * 3)));
    return x + ':' + y + ':' + w + ':' + h;
  }).sort();

  const metrics = {
    title,
    bodyFontFamily: Array.from(bodyFontWeights.entries()).sort((a, b) => b[1] - a[1])[0]?.[0],
    textBounds: unionRects(layoutTextRects),
    textCharacters,
    elementCount: visibleElements.length,
    visualCount: root.querySelectorAll(visualSelector).length,
    cardCount: visibleElements.filter((element) => cardPattern.test(element.getAttribute('class') || '')).length,
    backgroundColor: getComputedStyle(root).backgroundColor || getComputedStyle(document.body).backgroundColor,
    dominantColors: Array.from(colorWeights.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map((entry) => entry[0]),
    layoutSignature: signatureParts.join('|') || 'text-only'
  };

  return {
    scale: Number(scale.toFixed(4)),
    canvas: rectOf(rootRect),
    texts,
    metrics
  };
})()
`

let validationWindow: BrowserWindow | null = null
let validationQueue: Promise<void> = Promise.resolve()

const destroyValidationWindow = (): void => {
  const window = validationWindow
  validationWindow = null
  if (!window || window.isDestroyed()) return
  try {
    window.webContents.stop()
  } catch {
    // Renderer may already be tearing down.
  }
  window.destroy()
}

/** 中断当前页面加载并回到空白页，保留暖窗口给下一次校验复用。 */
const resetValidationWindowLoad = (window: BrowserWindow): void => {
  if (window.isDestroyed()) return
  try {
    window.webContents.stop()
  } catch {
    // Renderer may already be tearing down.
  }
}

const ensureValidationWindow = (slideSize: SlideSizePreset): BrowserWindow => {
  if (validationWindow && !validationWindow.isDestroyed()) {
    validationWindow.setContentSize(slideSize.width, slideSize.height)
    return validationWindow
  }
  if (!app.isReady()) throw new Error('Electron app is not ready')
  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: false,
    width: slideSize.width,
    height: slideSize.height,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: false
    }
  })
  window.webContents.setZoomFactor(1)
  window.setContentSize(slideSize.width, slideSize.height)
  window.once('closed', () => {
    if (validationWindow === window) validationWindow = null
  })
  validationWindow = window
  return window
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`render validation timeout (${timeoutMs}ms)`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

const WAIT_FOR_RENDERED_PAGE_READY_SCRIPT = `
(async () => {
  const search = new URLSearchParams(window.location.search);
  const master = document.querySelector('link[data-ppt-master="1"]');
  const expectsMaster = search.get('_pptMasterExpected') === '1';
  if (expectsMaster) {
    if (!master) throw new Error('母版样式表链接缺失');
    if (!(master.dataset.pptMasterRenderReady === '1' && master.sheet)) {
      const masterUrl = new URL(master.href, window.location.href);
      masterUrl.searchParams.set('_pptMasterRender', String(Date.now()));
      master.href = masterUrl.toString();
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          master.removeEventListener('load', onLoad);
          master.removeEventListener('error', onError);
          callback();
        };
        const onLoad = () => finish(() => {
          if (!master.sheet) {
            reject(new Error('母版样式表加载后不可用'));
            return;
          }
          master.dataset.pptMasterRenderReady = '1';
          resolve(true);
        });
        const onError = () => finish(() => reject(new Error('母版样式表加载失败')));
        const timeout = setTimeout(
          () => finish(() => reject(new Error('母版样式表加载超时'))),
          ${MASTER_STYLE_TIMEOUT_MS}
        );
        master.addEventListener('load', onLoad, { once: true });
        master.addEventListener('error', onError, { once: true });
      });
    }
  }

  if (window.PPT?.whenReadyForPrint) {
    await window.PPT.whenReadyForPrint(${MASTER_STYLE_TIMEOUT_MS});
  }
  const expectsMasterElements = search.get('_pptMasterElementsExpected') === '1';
  if (expectsMasterElements && !window.PPT?.assertMasterElementsReady) {
    throw new Error('母版全局元素运行时不可用');
  }
  if (window.PPT?.assertMasterElementsReady) {
    await window.PPT.assertMasterElementsReady(${MASTER_STYLE_TIMEOUT_MS});
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()
`

const isRenderValidationTimeout = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('render validation timeout')

const inspectRenderedPageOnce = async (args: {
  pageId: string
  targetPath: string
  slideSize: SlideSizePreset
}): Promise<{ available: true; snapshot: RenderedPageSnapshot }> => {
  if (!fs.existsSync(args.targetPath)) throw new Error('page file is missing after write')
  const window = ensureValidationWindow(args.slideSize)
  const pageUrl = new URL(pathToFileURL(args.targetPath).toString())
  pageUrl.searchParams.set('pageId', args.pageId)
  pageUrl.searchParams.set('_ts', String(Date.now()))
  pageUrl.searchParams.set(
    '_pptMasterExpected',
    fs.existsSync(path.join(path.dirname(args.targetPath), 'master', 'master.css')) ? '1' : '0'
  )
  pageUrl.searchParams.set(
    '_pptMasterElementsExpected',
    fs.existsSync(path.join(path.dirname(args.targetPath), 'master', 'master.html')) ? '1' : '0'
  )
  await withTimeout(window.loadURL(pageUrl.toString()), PAGE_LOAD_TIMEOUT_MS).catch((error) => {
    // 卡住的加载会让 did-finish-load 永远不来；主动 stop 中断加载再抛出，
    // 让上层用同一个暖窗口重试，而不是把冷启动成本摊到后续每一页。
    resetValidationWindowLoad(window)
    throw error
  })
  await withTimeout(
    window.webContents.executeJavaScript(WAIT_FOR_RENDERED_PAGE_READY_SCRIPT, true),
    VALIDATION_TIMEOUT_MS
  )
  const snapshot = await withTimeout(
    window.webContents.executeJavaScript(COLLECT_RENDERED_PAGE_SNAPSHOT_SCRIPT, true),
    VALIDATION_TIMEOUT_MS
  )
  return { available: true, snapshot: snapshot as RenderedPageSnapshot }
}

const reportValidationUnavailable = (args: {
  pageId: string
  targetPath: string
  error: unknown
}): { available: false; unavailableReason: string } => {
  const unavailableReason =
    args.error instanceof Error ? args.error.message : String(args.error)
  log.warn('[deepagent] rendered page validation unavailable', {
    pageId: args.pageId,
    targetPath: args.targetPath,
    unavailableReason
  })
  // 不销毁窗口：脚本级失败（如 render-root-missing）不会污染渲染进程，
  // 保留暖窗口让下一页免付冷启动；只有超时才由上层决定销毁重建。
  return { available: false, unavailableReason }
}

const inspectRenderedPage = async (args: {
  pageId: string
  targetPath: string
  slideSize: SlideSizePreset
}): Promise<
  | { available: true; snapshot: RenderedPageSnapshot }
  | { available: false; unavailableReason: string }
> => {
  for (let attempt = 1; attempt <= VALIDATION_TIMEOUT_ATTEMPTS; attempt += 1) {
    try {
      return await inspectRenderedPageOnce(args)
    } catch (error) {
      // 超时大概率是环境问题（冷启动窗口/字体/GPU）：stop 当前加载、保留暖窗口重试一次；
      // 非超时错误（文件缺失、脚本异常）重试没有意义。
      const timedOut = isRenderValidationTimeout(error) && attempt < VALIDATION_TIMEOUT_ATTEMPTS
      if (timedOut) {
        resetValidationWindowLoad(
          ensureValidationWindow(args.slideSize)
        )
        log.warn('[deepagent] rendered page validation timed out, retrying once', {
          pageId: args.pageId,
          targetPath: args.targetPath,
          attempt
        })
        continue
      }
      if (isRenderValidationTimeout(error)) {
        // 最终仍超时：销毁窗口避免半加载状态串页，但按基础设施不可用上报，
        // 不应让整副 deck 被判失败（deck-render-gate 会把 timeout 归为非阻断）。
        destroyValidationWindow()
      }
      return reportValidationUnavailable({ ...args, error })
    }
  }
  return { available: false, unavailableReason: 'render validation timeout' }
}

export type RenderedPageInspectionResult =
  | { available: true; snapshot: RenderedPageSnapshot }
  | { available: false; unavailableReason: string }

export function inspectRenderedPresentationPage(args: {
  pageId: string
  targetPath: string
  slideSize: SlideSizePreset
}): Promise<RenderedPageInspectionResult> {
  const run = validationQueue.then(async () => {
    if (Date.now() < renderTimeoutCooldownUntil) {
      const unavailableReason = `render validation cooldown after ${renderTimeoutCooldownReason}`
      log.warn('[deepagent] rendered page validation skipped during timeout cooldown', {
        pageId: args.pageId,
        targetPath: args.targetPath,
        cooldownUntil: renderTimeoutCooldownUntil,
        unavailableReason
      })
      return { available: false as const, unavailableReason }
    }

    const result = await inspectRenderedPage(args)
    if (!result.available && result.unavailableReason.includes('render validation timeout')) {
      renderTimeoutCooldownUntil = Date.now() + RENDER_TIMEOUT_COOLDOWN_MS
      renderTimeoutCooldownReason = result.unavailableReason
    } else if (result.available) {
      renderTimeoutCooldownUntil = 0
      renderTimeoutCooldownReason = ''
    }
    return result
  })
  validationQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Serialize all generated pages through one hidden Chromium renderer. */
export function validateRenderedPresentationPage(args: {
  pageId: string
  targetPath: string
  slideSize: SlideSizePreset
}): Promise<RenderedPageValidationResult> {
  return inspectRenderedPresentationPage(args).then((inspection) =>
    inspection.available
      ? {
          available: true,
          violations: classifyRenderedPageSnapshot(inspection.snapshot)
        }
      : {
          available: false,
          violations: [],
          unavailableReason: inspection.unavailableReason
        }
  )
}
