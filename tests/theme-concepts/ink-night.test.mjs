import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright'

const root = path.resolve()
const cssPath = path.join(
  root,
  'src-tauri/codex-plus/assets/theme-studio/concepts/ink-night.css',
)
const conceptPath = path.join(
  root,
  'src-tauri/codex-plus/assets/theme-studio/concepts/ink-night.json',
)

const [css, conceptSource] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(conceptPath, 'utf8'),
])
const concept = JSON.parse(conceptSource)
const wallpaperPath = path.resolve(path.dirname(conceptPath), concept.asset.wallpaper)
const wallpaperDataUrl = `data:image/webp;base64,${(
  await readFile(wallpaperPath)
).toString('base64')}`

function srgbChannel(value) {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const value = hex.replace('#', '')
  const channels = [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ].map(srgbChannel)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function alphaOf(color) {
  const match = color.match(/^rgba?\(([^)]+)\)$/)
  assert.ok(match, `expected computed RGB color, received ${color}`)
  const parts = match[1].split(',').map((part) => part.trim())
  return parts.length === 4 ? Number(parts[3]) : 1
}

function cardMarkup(card, index) {
  return `
    <button class="cc-theme-showcase-card" type="button" data-codex-theme-card-index="${index}">
      <span class="cc-theme-showcase-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </span>
      <span class="cc-theme-showcase-card-copy">
        <span class="cc-theme-showcase-card-label">${card.title}</span>
        <span class="cc-theme-showcase-card-description">${card.description}</span>
      </span>
      <span class="cc-theme-showcase-card-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
      </span>
      <span class="cc-theme-showcase-card-index">${String(index + 1).padStart(2, '0')}</span>
    </button>
  `
}

function fixtureHtml() {
  const cards = concept.copy.cards.map(cardMarkup).join('')
  return `
    <!doctype html>
    <html data-codex-compass-theme="ink-night" data-codex-compass-showcase="ink-night">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; min-height: 100%; margin: 0; }
          body { color: #f8f5ff; background: #090d24; font-family: "Segoe UI", sans-serif; }
          button, textarea, input { font: inherit; }
          .fixture-shell { min-height: 100vh; display: grid; grid-template-columns: 270px minmax(0, 1fr); }
          .cc-theme-shell-sidebar { position: fixed; inset: 0 auto 0 0; width: 270px; padding: 10px; }
          .cc-theme-shell-sidebar::before, .cc-theme-shell-sidebar::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
          .cc-theme-shell-sidebar::after { inset: 0 0 0 auto; }
          .cc-theme-shell-product-button, .cc-theme-shell-search-button, .cc-theme-shell-new-task,
          .cc-theme-shell-nav-row, .cc-theme-shell-project-row, .cc-theme-shell-thread-row,
          .cc-theme-shell-active-row, .cc-theme-shell-account-row {
            position: relative; width: 100%; min-height: 34px; padding: 7px 9px;
            display: flex; align-items: center; gap: 8px; border: 0;
          }
          [data-app-action-sidebar-scroll] { height: calc(100vh - 154px); padding-right: 3px; }
          .cc-theme-shell-account-row { position: absolute; right: 10px; bottom: 10px; left: 10px; width: auto; }
          .fixture-main { grid-column: 2; min-width: 0; padding: 58px 24px 30px; }
          .cc-theme-shell-topbar { position: fixed; z-index: 20; top: 0; right: 0; left: 270px; height: 44px; }
          .cc-theme-showcase-host { width: 100%; max-width: 1180px; margin: 0 auto; }
          .cc-theme-showcase { position: relative; isolation: isolate; display: grid; overflow: hidden; background-size: cover; }
          .cc-theme-showcase::before, .cc-theme-showcase::after { content: ""; position: absolute; z-index: -1; pointer-events: none; }
          .cc-theme-showcase::before { inset: 0; }
          .cc-theme-showcase-brandline { position: absolute; z-index: 4; display: flex; align-items: center; }
          .cc-theme-showcase-brandmark { display: grid; place-items: center; }
          .cc-theme-showcase-brandcopy { min-width: 0; }
          .cc-theme-showcase-status { margin-left: auto; }
          .cc-theme-showcase-copy { position: relative; z-index: 2; }
          .cc-theme-showcase-eyebrow, .cc-theme-showcase-badge { display: inline-flex; padding: 5px 9px; border: 1px solid; border-radius: 999px; }
          .cc-theme-showcase-title, .cc-theme-showcase-subtitle { margin: 0; }
          .cc-theme-showcase-motif { position: absolute; z-index: 1; aspect-ratio: 1; pointer-events: none; }
          .cc-theme-showcase-motif::before, .cc-theme-showcase-motif::after { content: ""; position: absolute; }
          .cc-theme-showcase-cards { position: relative; display: grid; }
          .cc-theme-showcase-card { position: relative; }
          .cc-theme-showcase-card-icon, .cc-theme-showcase-card-arrow { display: grid; place-items: center; border-radius: 50%; }
          .cc-theme-showcase-card-icon svg, .cc-theme-showcase-card-arrow svg { fill: none; stroke: currentColor; }
          .cc-theme-showcase-card-label, .cc-theme-showcase-card-description { display: block; }
          .cc-theme-showcase-card-index { position: absolute; }
          .cc-theme-showcase-companion { position: absolute; z-index: 2; padding: 8px; }
          .cc-theme-shell-composer { position: relative; min-height: 116px; max-width: 1040px; margin: 18px auto 0; padding: 18px; overflow: hidden; }
          .cc-theme-shell-composer textarea { position: relative; z-index: 2; width: 100%; min-height: 54px; border: 0; resize: none; }
          .cc-theme-shell-composer button { position: relative; z-index: 2; min-height: 32px; }
          .fixture-actions { display: flex; justify-content: space-between; }
          .fixture-overlay, .fixture-operation { position: fixed; z-index: 50; }
          .fixture-operation { top: 70px; right: 24px; min-width: 190px; padding: 12px; border: 1px solid; }
          #fixture-popover { top: 150px; }
          #fixture-settings { top: 230px; }
          #fixture-code { right: 240px; top: 70px; width: 220px; }
          #image-preview-overlay { inset: 0; z-index: 40; pointer-events: none; }
          #image-preview-dialog { inset: 0; z-index: 51; pointer-events: none; }
          #image-preview-dialog .preview-actions { position: absolute; top: 60px; right: 24px; display: flex; gap: 8px; pointer-events: auto; }
          #image-preview-dialog .preview-actions :is(a, button) { text-decoration: none; }
          @media (max-width: 760px) {
            .fixture-shell { display: block; }
            .cc-theme-shell-sidebar { display: none; }
            .cc-theme-shell-topbar { left: 0; }
            .fixture-main { padding-inline: 12px; }
            .fixture-operation, .fixture-overlay { display: none; }
          }
        </style>
        <style>${css}</style>
      </head>
      <body>
        <div class="fixture-shell">
          <aside class="cc-theme-shell-sidebar">
            <button class="cc-theme-shell-product-button">Codex</button>
            <button class="cc-theme-shell-search-button">搜索</button>
            <button class="cc-theme-shell-new-task">
              <svg viewBox="0 0 24 24"></svg><span>新建任务</span>
            </button>
            <div data-app-action-sidebar-scroll>
              <div class="cc-theme-shell-group-heading">项目</div>
              <button class="cc-theme-shell-project-row">蝶光星河</button>
              <button class="cc-theme-shell-thread-row">理解现有实现</button>
              <button class="cc-theme-shell-thread-row cc-theme-shell-active-row">构建紫夜主题</button>
              <div class="cc-theme-shell-group-heading">任务</div>
              <button class="cc-theme-shell-nav-row">审查主题对比度</button>
              <button class="cc-theme-shell-nav-row">验证紧凑布局</button>
            </div>
            <button class="cc-theme-shell-account-row">本地账户</button>
          </aside>
          <main class="fixture-main">
            <div class="cc-theme-shell-topbar">
              <button class="cc-theme-shell-window-control cc-theme-shell-window-minimize">_</button>
              <button class="cc-theme-shell-window-control cc-theme-shell-window-maximize">□</button>
              <button class="cc-theme-shell-window-control cc-theme-shell-window-close">×</button>
            </div>
            <div class="cc-theme-showcase-host">
              <section class="cc-theme-showcase theme-ink-night layout-cosmic cards-glass"
                style="--cc-showcase-hero: url('${wallpaperDataUrl}'); background-image: var(--cc-showcase-hero);">
                <div class="cc-theme-showcase-brandline">
                  <span class="cc-theme-showcase-brandmark">星</span>
                  <span class="cc-theme-showcase-brandcopy">
                    <span class="cc-theme-showcase-brandname">${concept.copy.brandName}</span>
                    <span class="cc-theme-showcase-brandmeta">${concept.copy.brandMeta}</span>
                  </span>
                  <span class="cc-theme-showcase-status">${concept.copy.status}</span>
                </div>
                <div class="cc-theme-showcase-copy">
                  <span class="cc-theme-showcase-eyebrow">${concept.copy.eyebrow}</span>
                  <h1 class="cc-theme-showcase-title">${concept.copy.title}</h1>
                  <p class="cc-theme-showcase-subtitle">${concept.copy.subtitle}</p>
                  <span class="cc-theme-showcase-badge">蝶光限定</span>
                </div>
                <div class="cc-theme-showcase-motif" aria-hidden="true"></div>
                <div class="cc-theme-showcase-companion">
                  <span class="cc-theme-showcase-companion-mark">星</span>
                  <span class="cc-theme-showcase-companion-label">紫夜限定</span>
                </div>
                <div class="cc-theme-showcase-cards">${cards}</div>
              </section>
            </div>
            <div class="composer-surface-chrome cc-theme-showcase-composer cc-theme-shell-composer" data-cc-theme-mark="✦">
              <textarea aria-label="任务输入">${concept.copy.composerPlaceholder}</textarea>
              <div class="fixture-actions">
                <button class="cc-theme-shell-attach-button">附件</button>
                <button class="cc-theme-shell-model-button">GPT</button>
                <button class="cc-theme-shell-send-button">发送</button>
              </div>
            </div>
          </main>
        </div>
        <div role="menu" class="fixture-operation" id="fixture-menu">菜单</div>
        <div data-slot="popover-content" class="fixture-operation" id="fixture-popover">Popover</div>
        <div role="dialog" aria-label="Codex 设置" class="fixture-operation" id="fixture-settings">
          <aside class="settings-sidebar">设置导航</aside>
          <div class="settings-content"><input value="紫夜限定"></div>
        </div>
        <pre class="fixture-operation" id="fixture-code"><code>const theme = "ink-night"</code></pre>
        <div class="monaco-editor fixture-operation" id="fixture-monaco">Monaco</div>
        <div id="image-preview-overlay"></div>
        <div role="dialog" aria-label="图片预览" id="image-preview-dialog">
          <div class="preview-actions">
            <a download href="#" aria-label="保存图片"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg></a>
            <button type="button" aria-label="关闭图片预览"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
          </div>
          <figcaption data-slot="image-preview-caption">图片预览</figcaption>
        </div>
      </body>
    </html>
  `
}

test('concept JSON fully describes the purple-night implementation without a real-person identity', () => {
  assert.equal(concept.id, 'ink-night')
  assert.equal(concept.baseThemeId, 'ink-night')
  assert.equal(concept.name, '紫夜限定')
  assert.equal(concept.appearance, 'dark')
  assert.equal(concept.layoutStyle, 'cosmic')
  assert.equal(concept.asset.role, 'pure-wallpaper')
  assert.equal(concept.asset.safeArea, 'left')
  assert.equal(concept.conceptBreakdown.length, 8)
  assert.equal(concept.copy.cards.length, 4)
  assert.equal(new Set(concept.copy.cards.map((card) => card.title)).size, 4)
  assert.equal(concept.layout.desktop.cardsColumns, 4)
  assert.equal(concept.layout.compact.cardsColumns, 2)
  assert.equal(concept.layout.compact.cardRows, 2)
  assert.equal(concept.interactionContract.nativeComposerPreserved, true)
  assert.equal(concept.interactionContract.localRowScrollbars, false)
  assert.ok(concept.surfaceProtection.opaque.includes('popover'))
  assert.ok(concept.surfaceProtection.opaque.includes('settings'))
  assert.ok(concept.surfaceProtection.opaque.includes('monaco'))
  assert.ok(concept.surfaceProtection.opaque.includes('image-preview-actions'))
  assert.match(concept.asset.identityPolicy, /original fictional adult woman/i)
  assert.equal(Object.hasOwn(concept.asset, 'identityReference'), false)
  assert.equal(Object.hasOwn(concept.asset, 'realPersonName'), false)
})

test('dark palette meets the declared contrast requirements', () => {
  const { palette, accessibility } = concept
  assert.ok(
    contrast(palette.text, palette.background) >= accessibility.minimumBodyContrast,
    'primary text must pass AAA contrast against the page background',
  )
  assert.ok(
    contrast(palette.text, palette.surface) >= accessibility.minimumBodyContrast,
    'primary text must pass AAA contrast against operational surfaces',
  )
  assert.ok(
    contrast(palette.textMuted, palette.surface) >= accessibility.minimumMutedContrast,
    'muted text must pass AA contrast against operational surfaces',
  )
  assert.ok(
    contrast(concept.surfaceProtection.imagePreview.actionForeground, concept.surfaceProtection.imagePreview.actionSurface)
      >= accessibility.minimumBodyContrast,
    'image preview controls must retain strong foreground contrast',
  )
})

test('stylesheet is ink-night scoped and protects against broad transparency and local row scrollbars', () => {
  assert.match(css, /html\[data-codex-compass-theme="ink-night"\]/)
  assert.match(css, /\.cc-theme-showcase\.theme-ink-night\.layout-cosmic/)
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /@media \(max-width:\s*920px\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /\.cc-theme-shell-sidebar \[data-app-action-sidebar-scroll\][\s\S]*overflow-y:\s*auto/)
  assert.match(css, /\.cc-theme-shell-project-row,[\s\S]*\.cc-theme-shell-thread-row[\s\S]*overflow:\s*visible/)
  assert.match(css, /Operational surfaces are intentionally solid/)
  assert.match(css, /\[data-radix-popover-content\][\s\S]*background:\s*var\(--ink-night-surface\)/)
  assert.match(css, /\.monaco-editor[\s\S]*background-color:\s*#11162f/)
  assert.equal(concept.surfaceProtection.imagePreview.actionSizePx, 44)
  assert.match(css, /width:\s*44px\s*!important[\s\S]*height:\s*44px\s*!important/)
  assert.doesNotMatch(css, /html\[data-codex-compass-theme\](?!="ink-night")/)
  assert.doesNotMatch(css, /(?:project-row|thread-row)[^{]*\{[^}]*overflow-y:\s*(?:auto|scroll)/)
  assert.doesNotMatch(css, /\.cc-theme-showcase-card[^{]*\{[^}]*overflow-y:\s*(?:auto|scroll)/)
  assert.doesNotMatch(css, /body\s*\*/)
})

test('browser fixture renders four desktop cards, a 2x2 compact grid, and opaque operational surfaces', async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(async () => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.setContent(fixtureHtml(), { waitUntil: 'domcontentloaded' })

  const nativeComposer = page.locator('.composer-surface-chrome')
  const composerHandle = await nativeComposer.elementHandle()
  assert.ok(composerHandle, 'native composer fixture must exist')
  assert.equal(await page.locator('.cc-theme-showcase-card').count(), 4)

  const desktop = await page.evaluate(() => {
    const cards = document.querySelector('.cc-theme-showcase-cards')
    const title = document.querySelector('.cc-theme-showcase-title')
    const sidebarScroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const rows = Array.from(document.querySelectorAll('.cc-theme-shell-project-row, .cc-theme-shell-thread-row'))
    const cardNodes = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    return {
      columns: getComputedStyle(cards).gridTemplateColumns.split(' ').length,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      titleFits: title.scrollWidth <= title.clientWidth + 1,
      sidebarOverflowY: getComputedStyle(sidebarScroll).overflowY,
      rowOverflowY: rows.map((node) => getComputedStyle(node).overflowY),
      cardOverflowY: cardNodes.map((node) => getComputedStyle(node).overflowY),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })

  assert.equal(desktop.columns, 4)
  assert.equal(desktop.titleWhiteSpace, 'nowrap')
  assert.equal(desktop.titleFits, true)
  assert.equal(desktop.sidebarOverflowY, 'auto')
  assert.deepEqual(desktop.rowOverflowY, ['visible', 'visible', 'visible'])
  assert.deepEqual(desktop.cardOverflowY, ['visible', 'visible', 'visible', 'visible'])
  assert.equal(desktop.noHorizontalOverflow, true)

  for (const selector of [
    '#fixture-menu',
    '#fixture-popover',
    '#fixture-settings',
    '#fixture-settings .settings-sidebar',
    '#fixture-settings .settings-content',
    '#fixture-code',
    '#fixture-monaco',
    '#image-preview-overlay',
    '#image-preview-dialog .preview-actions a',
    '#image-preview-dialog .preview-actions button',
  ]) {
    const background = await page.locator(selector).evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    )
    assert.equal(alphaOf(background), 1, `${selector} must have an opaque background`)
  }

  const previewActions = await page.locator('#image-preview-dialog .preview-actions').evaluate((element) => (
    Array.from(element.children).map((node) => {
      const box = node.getBoundingClientRect()
      const icon = node.querySelector('svg').getBoundingClientRect()
      return {
        width: box.width,
        height: box.height,
        iconWidth: icon.width,
        iconHeight: icon.height,
      }
    })
  ))
  assert.deepEqual(previewActions, [
    { width: 44, height: 44, iconWidth: 22, iconHeight: 22 },
    { width: 44, height: 44, iconWidth: 22, iconHeight: 22 },
  ])

  const screenshotDir = process.env.INK_NIGHT_SCREENSHOT_DIR
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true })
    await page.locator('.fixture-operation, #image-preview-overlay, #image-preview-dialog').evaluateAll(
      (nodes) => nodes.forEach((node) => { node.style.display = 'none' }),
    )
    await page.screenshot({
      path: path.join(screenshotDir, 'ink-night-desktop.png'),
      fullPage: true,
    })
  }

  await page.setViewportSize({ width: 720, height: 980 })
  const compact = await page.evaluate(() => {
    const cards = document.querySelector('.cc-theme-showcase-cards')
    const title = document.querySelector('.cc-theme-showcase-title')
    const composer = document.querySelector('.composer-surface-chrome')
    const showcase = document.querySelector('.cc-theme-showcase')
    const composerBox = composer.getBoundingClientRect()
    const showcaseBox = showcase.getBoundingClientRect()
    return {
      columns: getComputedStyle(cards).gridTemplateColumns.split(' ').length,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      composerBelowShowcase: composerBox.top >= showcaseBox.bottom,
    }
  })

  assert.equal(compact.columns, 2)
  assert.equal(compact.titleWhiteSpace, 'normal')
  assert.equal(compact.noHorizontalOverflow, true)
  assert.equal(compact.composerBelowShowcase, true)

  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'ink-night-compact.png'),
      fullPage: true,
    })
  }

  const composerHandleAfterResize = await nativeComposer.elementHandle()
  assert.ok(
    await composerHandle.evaluate((node, other) => node === other, composerHandleAfterResize),
    'responsive styling must preserve the original native composer node',
  )
})
