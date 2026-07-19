import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'

const root = path.resolve()
const cssPath = path.join(
  root,
  'src-tauri/codex-plus/assets/theme-studio/concepts/starlight-stage.css',
)
const manifestPath = path.join(
  root,
  'src-tauri/codex-plus/assets/theme-studio/concepts/starlight-stage.json',
)
const [css, manifestSource] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
])
const manifest = JSON.parse(manifestSource)
const themeRoot = ':where(html[data-codex-compass-theme="starlight-stage"])'
const themeRootPrefix = ':where(html[data-codex-compass-theme="starlight-stage"]'

function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  assert.ok(match, `expected six-digit hex color, received ${value}`)
  const number = Number.parseInt(match[1], 16)
  return [
    (number >> 16) & 255,
    (number >> 8) & 255,
    number & 255,
  ]
}

function relativeLuminance(value) {
  const channels = hexToRgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function selectorLines(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = []
  let segmentStart = 0
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index]
    if (character === '{') {
      const prelude = clean.slice(segmentStart, index).trim()
      if (prelude && !prelude.startsWith('@')) selectors.push(prelude)
      segmentStart = index + 1
      continue
    }
    if (character === '}') segmentStart = index + 1
  }
  return selectors
}

function fixtureHtml() {
  const cards = manifest.runtimeDefinition.showcase.cards
    .map((card, index) => `
      <button
        class="cc-theme-showcase-card"
        type="button"
        data-codex-theme-quick-card="${card.icon}"
        data-codex-theme-card-index="${index}"
      >
        <span class="cc-theme-showcase-card-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"></path></svg>
        </span>
        <span class="cc-theme-showcase-card-copy">
          <span class="cc-theme-showcase-card-label">${card.title}</span>
          <span class="cc-theme-showcase-card-description">${card.prompt}</span>
        </span>
        <span class="cc-theme-showcase-card-arrow" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M3.5 8h8m-3-3.5L12 8l-3.5 3.5"></path></svg>
        </span>
        <span class="cc-theme-showcase-card-index">${String(index + 1).padStart(2, '0')}</span>
      </button>
    `)
    .join('')

  return `<!doctype html>
    <html
      data-codex-compass-theme="starlight-stage"
      data-codex-compass-showcase="starlight-stage"
      data-codex-compass-theme-page="home"
    >
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; min-height: 100%; margin: 0; background: #080806; }
          body {
            min-height: 100vh;
            display: grid;
            grid-template-columns: 252px minmax(0, 1fr);
            color: #f5ead2;
            font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
          }
          button, input, textarea { font: inherit; }
          button { cursor: pointer; }
          .cc-theme-shell-sidebar {
            position: relative;
            min-width: 0;
            height: 100vh;
            padding: 12px;
            overflow: hidden;
            border-right: 1px solid #333;
          }
          .cc-theme-shell-product-button,
          .cc-theme-shell-new-task,
          .cc-theme-shell-nav-row,
          .cc-theme-shell-project-row button,
          .cc-theme-shell-thread-row button,
          .cc-theme-shell-account-row {
            width: 100%;
            min-height: 32px;
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 2px 0;
            border: 1px solid transparent;
          }
          .cc-theme-shell-search-button {
            position: absolute;
            top: 22px;
            right: 14px;
            width: 34px;
            height: 34px;
          }
          .cc-theme-shell-group-heading { margin-top: 12px; }
          [data-app-action-sidebar-scroll] {
            height: calc(100vh - 292px);
            min-height: 160px;
            overflow-y: auto;
          }
          .cc-theme-shell-account-row { position: absolute; left: 12px; right: 12px; bottom: 12px; width: auto; }
          main { min-width: 0; padding: 36px; }
          .cc-theme-showcase-host { width: 100%; max-width: 1180px; margin: 0 auto; }
          .cc-theme-showcase {
            position: relative;
            isolation: isolate;
            width: 100%;
            display: grid;
            background-image:
              linear-gradient(90deg, #080806 0 48%, transparent 76%),
              linear-gradient(135deg, #080806, #2f2517);
            background-size: cover;
          }
          .cc-theme-showcase::before,
          .cc-theme-showcase::after { pointer-events: none; }
          .cc-theme-showcase-brandline {
            position: absolute;
            z-index: 4;
            display: flex;
            align-items: center;
          }
          .cc-theme-showcase-brandmark { display: grid; place-items: center; }
          .cc-theme-showcase-brandcopy { display: grid; }
          .cc-theme-showcase-status { margin-left: auto; }
          .cc-theme-showcase-copy { position: relative; z-index: 2; }
          .cc-theme-showcase-cards { position: relative; z-index: 3; display: grid; }
          .cc-theme-showcase-card-icon { display: grid; place-items: center; }
          .cc-theme-showcase-card-icon svg,
          .cc-theme-showcase-card-arrow svg {
            fill: none;
            stroke: currentColor;
            stroke-linecap: round;
            stroke-linejoin: round;
          }
          .cc-theme-showcase-card { position: relative; }
          .cc-theme-showcase-card-index { position: absolute; }
          .cc-theme-showcase-card-arrow { display: grid; place-items: center; }
          .cc-theme-showcase-motif,
          .cc-theme-showcase-companion {
            position: absolute;
            z-index: 2;
            pointer-events: none;
          }
          .cc-theme-showcase-motif { aspect-ratio: 1; }
          .cc-theme-showcase-motif::before,
          .cc-theme-showcase-motif::after {
            content: "";
            position: absolute;
            border-radius: inherit;
          }
          .cc-theme-showcase-companion { display: grid; align-content: end; }
          .cc-theme-showcase-composer {
            width: min(960px, 92%);
            min-height: 94px;
            margin: 18px auto 0;
            padding: 14px;
            display: grid;
            grid-template-columns: 40px minmax(0, 1fr) auto 40px;
            align-items: end;
            gap: 8px;
            border: 1px solid #555;
          }
          .cc-theme-showcase-composer textarea {
            min-width: 0;
            min-height: 58px;
            resize: none;
            color: inherit;
            border: 0;
            background: transparent;
          }
          .cc-theme-showcase-composer button { min-height: 36px; border: 0; background: transparent; }
          #operations {
            margin-top: 22px;
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
          }
          #operations > * { min-height: 72px; padding: 12px; border: 1px solid #555; }
          #settings {
            position: fixed;
            left: 20%;
            top: 16%;
            width: 420px;
          }
          #settings [data-slot="content"] { padding: 10px; }
          #settings input { width: 100%; min-height: 36px; }
          #menu { position: absolute; left: 280px; top: 80px; width: 220px; }
          #preview {
            position: fixed;
            inset: 0;
            visibility: hidden;
            pointer-events: none;
            background: transparent;
          }
          #preview-actions {
            position: absolute;
            top: 84px;
            right: 24px;
            display: flex;
            gap: 10px;
          }
          #preview-actions a,
          #preview-actions button {
            width: 44px;
            height: 44px;
            display: grid;
            place-items: center;
          }
          #preview-actions svg { width: 24px; height: 24px; }
          pre { margin: 0; }
          [hidden] { display: none !important; }
          @media (max-width: 620px) {
            body { grid-template-columns: minmax(0, 1fr); }
            .cc-theme-shell-sidebar { display: none; }
            main { padding: 12px; }
            #operations { display: none; }
          }
        </style>
        <style>${css}</style>
      </head>
      <body>
        <aside class="cc-theme-shell-sidebar">
          <button type="button" class="cc-theme-shell-product-button" data-cc-theme-label="黑金茉莉舞台">Codex</button>
          <button type="button" class="cc-theme-shell-search-button" aria-label="搜索">⌕</button>
          <button type="button" class="cc-theme-shell-new-task cc-theme-shell-nav-row">新建任务</button>
          <button type="button" class="cc-theme-shell-nav-row">已安排</button>
          <button type="button" class="cc-theme-shell-nav-row">技能</button>
          <button type="button" class="cc-theme-shell-nav-row">站点</button>
          <div class="cc-theme-shell-group-heading">项目</div>
          <div data-app-action-sidebar-scroll>
            <div class="cc-theme-shell-project-row"><button type="button">黑金舞台项目</button></div>
            <div class="cc-theme-shell-thread-row cc-theme-shell-active-row"><button type="button">舞台首页实现</button></div>
            <div class="cc-theme-shell-thread-row"><button type="button">黑金操作表面回归测试</button></div>
            <div class="cc-theme-shell-thread-row"><button type="button">紧凑布局验证</button></div>
          </div>
          <button type="button" class="cc-theme-shell-account-row">原创舞台工作区</button>
        </aside>
        <main>
          <div class="cc-theme-showcase-host">
            <section
              class="cc-theme-showcase theme-starlight-stage layout-stage cards-solid"
              data-codex-theme-root="v3"
              data-codex-theme-id="starlight-stage"
              data-codex-theme-layout="stage"
              data-codex-theme-card-grid="true"
            >
              <div class="cc-theme-showcase-brandline" aria-hidden="true">
                <span class="cc-theme-showcase-brandmark">光</span>
                <span class="cc-theme-showcase-brandcopy">
                  <span class="cc-theme-showcase-brandname">黑金茉莉舞台</span>
                  <span class="cc-theme-showcase-brandmeta">黑金茉莉舞台 · Codex Compass</span>
                </span>
                <span class="cc-theme-showcase-status">茉莉舞台</span>
              </div>
              <div class="cc-theme-showcase-copy">
                <span class="cc-theme-showcase-eyebrow">黑金茉莉舞台 · Codex Compass</span>
                <h1 class="cc-theme-showcase-title">我们一起创造什么？</h1>
                <p class="cc-theme-showcase-subtitle">让灵感与代码同频，在舞台灯光下完成下一项任务。</p>
                <span class="cc-theme-showcase-badge">茉莉舞台</span>
              </div>
              <div class="cc-theme-showcase-motif" data-codex-theme-decoration="jasmine" aria-hidden="true"></div>
              <div class="cc-theme-showcase-companion" aria-hidden="true">
                <span class="cc-theme-showcase-companion-mark">光</span>
                <span class="cc-theme-showcase-companion-label">黑金茉莉舞台</span>
              </div>
              <div class="cc-theme-showcase-cards" data-codex-theme-card-grid="true">${cards}</div>
            </section>
            <div class="cc-theme-showcase-composer">
              <button type="button" aria-label="添加文件">＋</button>
              <textarea aria-label="任务输入" placeholder="随心输入，让灵感与代码同频"></textarea>
              <button type="button" aria-label="选择模型">gpt-5.6</button>
              <button type="button" aria-label="发送">↑</button>
            </div>
          </div>
          <section id="operations" aria-label="操作表面夹具">
            <div id="menu" role="menu"><button role="menuitem">重命名项目</button></div>
            <div id="popover" data-slot="popover-content">附件 Popover</div>
            <section id="settings" role="dialog" data-slot="dialog-content" aria-label="Codex 设置">
              <div data-slot="content"><label>主题名称<input value="黑金茉莉舞台"></label></div>
            </section>
            <pre id="code"><code>const stage = "black-gold";</code></pre>
          </section>
          <div id="preview" role="dialog" aria-label="图片预览">
            <div id="preview-actions">
              <a href="#" download aria-label="下载图片"><svg viewBox="0 0 24 24"></svg></a>
              <button type="button" aria-label="关闭图片预览"><svg viewBox="0 0 24 24"></svg></button>
            </div>
          </div>
        </main>
        <script>
          window.cardClicks = 0;
          document.querySelectorAll('.cc-theme-showcase-card').forEach((card) => {
            card.addEventListener('click', () => { window.cardClicks += 1; });
          });
        </script>
      </body>
    </html>`
}

test('manifest fully describes the black-gold stage runtime contract', () => {
  assert.equal(manifest.id, 'starlight-stage')
  assert.equal(manifest.displayName, '舞台黑金')
  assert.equal(manifest.runtimeDefinition.presentation.layoutStyle, 'stage')
  assert.equal(manifest.runtimeDefinition.presentation.cardStyle, 'solid')
  assert.equal(manifest.runtimeDefinition.presentation.motifStyle, 'jasmine')
  assert.equal(manifest.source.rights.identityMode, 'original-fictional-adult')
  assert.equal(manifest.source.rights.celebrityLikeness, false)
  assert.equal(manifest.source.wallpaperDimensions.width, 2560)
  assert.equal(manifest.source.wallpaperDimensions.height, 1440)

  const cards = manifest.runtimeDefinition.showcase.cards
  assert.equal(cards.length, 4)
  assert.deepEqual(cards.map((card) => card.icon), ['code', 'build', 'review', 'repair'])
  assert.equal(new Set(cards.map((card) => card.title)).size, 4)
  assert.ok(cards.every((card) => card.prompt.length >= 35))

  assert.deepEqual(manifest.layoutContract.desktop.cardGrid, '4 columns x 1 row')
  assert.deepEqual(manifest.layoutContract.compact.cardGrid, '2 columns x 2 rows')
  assert.ok(manifest.qa.automated.length >= 8)
  assert.ok(manifest.qa.manual.length >= 8)
  assert.ok(manifest.qa.regressionGates.some((item) => item.includes('图片预览')))
  assert.ok(manifest.qa.regressionGates.some((item) => item.includes('归档、移除、重命名')))
})

test('palette reaches the declared dark-theme contrast targets', () => {
  const pairs = manifest.palette.contrastTargets.requiredPairs
  assert.ok(pairs.length >= 5)
  for (const pair of pairs) {
    const ratio = contrastRatio(pair.foreground, pair.background)
    assert.ok(ratio >= 4.5, `${pair.purpose} contrast ${ratio.toFixed(2)} is below 4.5`)
  }

  const visual = manifest.runtimeDefinition.visual
  assert.ok(contrastRatio(visual.text, visual.background) >= 7)
  assert.ok(contrastRatio(visual.text, visual.surface) >= 7)
  assert.ok(contrastRatio(visual.textMuted, visual.surface) >= 4.5)
  assert.ok(contrastRatio(visual.accent, visual.surface) >= 4.5)
})

test('stylesheet is theme-scoped and contains no local scrolling or coordinate recognition', () => {
  const selectors = selectorLines(css)
  assert.ok(selectors.length >= 70)
  for (const selector of selectors) {
    assert.ok(
      selector.includes(themeRoot) || selector.includes(themeRootPrefix),
      `selector escaped starlight-stage scope: ${selector}`,
    )
  }

  assert.doesNotMatch(css, /overflow\s*:\s*(?:auto|scroll)/i)
  assert.doesNotMatch(css, /overflow-[xy]\s*:\s*(?:auto|scroll)/i)
  assert.doesNotMatch(css, /getBoundingClientRect|clientX|clientY|offsetTop|offsetLeft/)
  assert.doesNotMatch(css, /\[class\*=/)
  assert.doesNotMatch(css, /:has\(/)
  assert.doesNotMatch(css, /nth-(?:child|of-type)/)
  assert.match(css, /\.cc-theme-showcase-composer/)
  assert.match(css, /\[role="dialog"\]:not\(\[aria-label="图片预览"\]\)/)
  assert.match(css, /\.monaco-editor/)
})

test('desktop and compact layouts keep four real cards interactive and operations readable', async (context) => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.setContent(fixtureHtml(), { waitUntil: 'domcontentloaded' })

    const desktop = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
      const boxes = cards.map((card) => card.getBoundingClientRect())
      const styles = cards.map((card) => getComputedStyle(card))
      const sidebarRows = Array.from(document.querySelectorAll(
        '.cc-theme-shell-project-row,.cc-theme-shell-thread-row',
      ))
      const sidebarRowStyles = sidebarRows.map((row) => getComputedStyle(row))
      const menu = getComputedStyle(document.querySelector('#menu'))
      const popover = getComputedStyle(document.querySelector('#popover'))
      const settings = getComputedStyle(document.querySelector('#settings'))
      const settingsInput = getComputedStyle(document.querySelector('#settings input'))
      const code = getComputedStyle(document.querySelector('#code'))
      const preview = getComputedStyle(document.querySelector('#preview'))
      const previewButtons = Array.from(document.querySelectorAll('#preview-actions > *'))
        .map((element) => element.getBoundingClientRect())
      return {
        cardCount: cards.length,
        oneRow: boxes.every((box) => Math.abs(box.top - boxes[0].top) <= 1),
        allVisible: boxes.every((box) => (
          box.width >= 150
          && box.height >= 140
          && box.left >= 0
          && box.right <= innerWidth
        )),
        noCardScroll: styles.every((style) => (
          style.overflowX !== 'auto'
          && style.overflowX !== 'scroll'
          && style.overflowY !== 'auto'
          && style.overflowY !== 'scroll'
        )),
        noRowScroll: sidebarRowStyles.every((style) => (
          style.overflowX !== 'auto'
          && style.overflowX !== 'scroll'
          && style.overflowY !== 'auto'
          && style.overflowY !== 'scroll'
        )),
        menuOpaque: menu.backgroundColor,
        menuPosition: menu.position,
        popoverOpaque: popover.backgroundColor,
        settingsOpaque: settings.backgroundColor,
        settingsPosition: settings.position,
        settingsInputOpaque: settingsInput.backgroundColor,
        codeOpaque: code.backgroundColor,
        previewBackground: preview.backgroundColor,
        previewButtonSizes: previewButtons.map((box) => [box.width, box.height]),
      }
    })

    assert.equal(desktop.cardCount, 4)
    assert.equal(desktop.oneRow, true, JSON.stringify(desktop))
    assert.equal(desktop.allVisible, true, JSON.stringify(desktop))
    assert.equal(desktop.noCardScroll, true)
    assert.equal(desktop.noRowScroll, true, JSON.stringify(desktop))
    assert.notEqual(desktop.menuOpaque, 'rgba(0, 0, 0, 0)')
    assert.equal(desktop.menuPosition, 'absolute')
    assert.notEqual(desktop.popoverOpaque, 'rgba(0, 0, 0, 0)')
    assert.notEqual(desktop.settingsOpaque, 'rgba(0, 0, 0, 0)')
    assert.equal(desktop.settingsPosition, 'fixed')
    assert.notEqual(desktop.settingsInputOpaque, 'rgba(0, 0, 0, 0)')
    assert.equal(desktop.codeOpaque, 'rgb(11, 12, 11)')
    assert.equal(desktop.previewBackground, 'rgba(0, 0, 0, 0)')
    assert.deepEqual(desktop.previewButtonSizes, [[44, 44], [44, 44]])

    await page.locator('.cc-theme-showcase-card').first().click()
    assert.equal(await page.evaluate(() => window.cardClicks), 1)

    await page.setViewportSize({ width: 560, height: 900 })
    const compact = await page.evaluate(() => {
      const showcase = document.querySelector('.cc-theme-showcase')
      const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
      const boxes = cards.map((card) => card.getBoundingClientRect())
      const rowTops = []
      for (const box of boxes) {
        if (!rowTops.some((top) => Math.abs(top - box.top) <= 2)) rowTops.push(box.top)
      }
      const showcaseBox = showcase.getBoundingClientRect()
      return {
        cardCount: cards.length,
        rows: rowTops.length,
        twoPerRow: rowTops.every((top) => boxes.filter((box) => Math.abs(box.top - top) <= 2).length === 2),
        allVisible: boxes.every((box) => (
          box.width >= 100
          && box.height >= 94
          && box.left >= showcaseBox.left
          && box.right <= showcaseBox.right + 0.5
        )),
        noHorizontalOverflow: showcase.scrollWidth <= showcase.clientWidth,
        titleFits: document.querySelector('.cc-theme-showcase-title').scrollWidth
          <= document.querySelector('.cc-theme-showcase-title').clientWidth,
        descriptionsHidden: cards.every((card) => (
          getComputedStyle(card.querySelector('.cc-theme-showcase-card-description')).display === 'none'
        )),
      }
    })

    assert.equal(compact.cardCount, 4)
    assert.equal(compact.rows, 2, JSON.stringify(compact))
    assert.equal(compact.twoPerRow, true, JSON.stringify(compact))
    assert.equal(compact.allVisible, true, JSON.stringify(compact))
    assert.equal(compact.noHorizontalOverflow, true, JSON.stringify(compact))
    assert.equal(compact.titleFits, true, JSON.stringify(compact))
    assert.equal(compact.descriptionsHidden, true)
  } finally {
    await browser.close()
  }
})
