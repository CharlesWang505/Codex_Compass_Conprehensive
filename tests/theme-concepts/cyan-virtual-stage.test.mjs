import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..')
const conceptDir = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'concepts',
)
const cssPath = path.join(conceptDir, 'cyan-virtual-stage.css')
const jsonPath = path.join(conceptDir, 'cyan-virtual-stage.json')
const wallpaperPath = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'cyan-virtual-stage-wallpaper.webp',
)
const rootScope = 'html[data-codex-compass-theme="cyan-virtual-stage"]'

const [css, conceptText, wallpaperBytes] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(jsonPath, 'utf8'),
  readFile(wallpaperPath),
])
const concept = JSON.parse(conceptText)
const wallpaperDataUrl = `data:image/webp;base64,${wallpaperBytes.toString('base64')}`

test('concept contract documents the complete original virtual-stage theme', () => {
  assert.equal(concept.id, 'cyan-virtual-stage')
  assert.equal(concept.identity.mode, 'original-fictional-adult')
  assert.equal(concept.identity.agePresentation, 'clearly-adult')
  assert.equal(concept.runtime.layoutStyle, 'idol')
  assert.equal(concept.runtime.appearance, 'light')
  assert.equal(concept.runtime.rootScope, rootScope)
  assert.equal(concept.copy.cards.length, 4)
  assert.deepEqual(
    concept.copy.cards.map((card) => card.id),
    ['code', 'build', 'review', 'repair'],
  )
  assert.equal(concept.layout.desktop.cardColumns, 4)
  assert.equal(concept.layout.compact.cardColumns, 2)
  assert.equal(concept.layout.compact.cardRows, 2)
  assert.equal(concept.layout.narrow.cardColumns, 2)
  assert.equal(concept.layout.narrow.cardRows, 2)
  assert.equal(concept.layout.sidebar.singleScrollOwner, '[data-app-action-sidebar-scroll]')
  assert.equal(concept.layout.sidebar.rowOverflow, 'clip')
  assert.equal(concept.layout.composer.ownership, 'native')
  assert.equal(concept.qaContract.protectedSurfaceRules.mustRemainOpaque, true)
  assert.equal(concept.qaContract.protectedSurfaceRules.mustNotReceiveThemeSelectors, true)
  assert.equal(concept.qaContract.scroll.sidebarWheelScrollsMainContainer, true)
  assert.equal(concept.qaContract.copyright.originalAdultSubjectRequired, true)
  assert.equal(concept.qaContract.copyright.recognizableCharacterReferencesAllowed, false)
  assert.equal(concept.qaContract.accessibility.focusVisibleRequired, true)
  assert.equal(concept.qaContract.accessibility.reducedMotionSupported, true)

  const requiredDetails = [
    '左侧品牌、搜索、新建任务、导航、项目树、任务列表和账户区',
    '顶部品牌栏、连接状态和舞台徽记',
    '四张并排的真实快捷任务卡',
    '底部原生项目选择器与 composer',
    '像素星、心形、音符、波形和粉青全息丝带装饰',
  ]
  for (const detail of requiredDetails) {
    assert.ok(concept.sourceConcept.referenceDetails.includes(detail), `missing concept detail: ${detail}`)
  }

  const bundledThemeText = `${css}\n${conceptText}`.toLowerCase()
  const prohibitedReferences = [
    'miku',
    'hatsune',
    'vocaloid',
    '\u521d\u97f3\u672a\u6765',
    'mikucode',
    '3939',
  ]
  for (const reference of prohibitedReferences) {
    assert.equal(
      bundledThemeText.includes(reference),
      false,
      `copyrighted character reference leaked into implementation: ${reference}`,
    )
  }
})

test('CSS is root-scoped and leaves protected operation surfaces untouched', () => {
  let depth = 0
  for (const character of css) {
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    assert.ok(depth >= 0, 'CSS closes a block before it opens one')
  }
  assert.equal(depth, 0, 'CSS braces are unbalanced')

  const selectorHeaders = collectSelectorHeaders(css)

  assert.ok(selectorHeaders.length > 40, 'expected a complete theme slice')
  for (const header of selectorHeaders) {
    for (const selector of splitTopLevelSelectors(header)) {
      assert.ok(
        selector.trim().startsWith(rootScope),
        `selector escapes cyan theme scope: ${selector.trim()}`,
      )
    }
  }

  const lowerCss = css.toLowerCase()
  const protectedSelectorTerms = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="menuitem"]',
    'popover',
    'settings-',
    'image-preview',
  ]
  for (const term of protectedSelectorTerms) {
    assert.equal(lowerCss.includes(term), false, `protected surface selector found: ${term}`)
  }

  assert.match(
    css,
    /html\[data-codex-compass-theme="cyan-virtual-stage"\] \.cc-theme-shell-sidebar \[data-app-action-sidebar-scroll\][\s\S]*?overflow-y: auto !important;/,
  )
  assert.match(
    css,
    /\.cc-theme-shell-project-row \{[\s\S]*?overflow: clip !important;/,
  )
  assert.match(
    css,
    /\.cc-theme-shell-thread-row \{[\s\S]*?overflow: clip !important;/,
  )
  assert.match(
    css,
    /@media \(max-width: 980px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  )
  assert.match(
    css,
    /\.cc-theme-showcase-card:focus-visible \{[\s\S]*?outline:/,
  )
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

test('rendered slice keeps four cards interactive, compact 2x2, scrollable, and readable', async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } })
  const consoleProblems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`))

  await page.setContent(fixtureHtml(css, concept, wallpaperDataUrl), { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    document.documentElement.dataset.codexCompassTheme = 'cyan-virtual-stage'
    document.documentElement.dataset.codexCompassThemePage = 'home'
  })

  assert.equal(await page.title(), 'Cyan Virtual Stage QA')
  assert.equal(await page.locator('.cc-theme-showcase-card').count(), 4)
  assert.equal(await page.locator('.cc-theme-shell-sidebar').count(), 1)
  assert.equal(await page.locator('[data-codex-theme-native-composer="true"]').count(), 1)

  const desktop = await page.evaluate(() => {
    const root = document.querySelector('.cc-theme-showcase')
    const cards = document.querySelector('.cc-theme-showcase-cards')
    const card = document.querySelector('.cc-theme-showcase-card')
    const row = document.querySelector('.cc-theme-shell-thread-row')
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const composer = document.querySelector('[data-codex-theme-native-composer="true"]')
    const rootBox = root.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    return {
      columns: getComputedStyle(cards).gridTemplateColumns.split(' ').length,
      cardOverflowX: getComputedStyle(card).overflowX,
      cardOverflowY: getComputedStyle(card).overflowY,
      rowOverflowX: getComputedStyle(row).overflowX,
      rowOverflowY: getComputedStyle(row).overflowY,
      sidebarScrollOverflowY: getComputedStyle(scroll).overflowY,
      noComposerOverlap: rootBox.bottom <= composerBox.top + 1,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      title: document.querySelector('.cc-theme-showcase-title').textContent.trim(),
      brand: document.querySelector('.cc-theme-showcase-brandname').textContent.trim(),
    }
  })
  assert.deepEqual(desktop, {
    columns: 4,
    cardOverflowX: 'hidden',
    cardOverflowY: 'hidden',
    rowOverflowX: 'clip',
    rowOverflowY: 'clip',
    sidebarScrollOverflowY: 'auto',
    noComposerOverlap: true,
    noHorizontalOverflow: true,
    title: concept.copy.title,
    brand: concept.copy.brandName,
  })

  await page.getByRole('button', { name: concept.copy.cards[0].title }).click()
  assert.equal(
    await page.locator('#native-composer-input').inputValue(),
    concept.copy.cards[0].prompt,
  )
  assert.equal(await page.evaluate(() => window.fixtureState.quickCardClicks), 1)

  const scroll = page.locator('[data-app-action-sidebar-scroll]')
  await scroll.evaluate((element) => {
    element.scrollTop = 0
  })
  await page.locator('.cc-theme-shell-thread-row').first().hover()
  await page.mouse.wheel(0, 360)
  await page.waitForTimeout(100)
  assert.ok(await scroll.evaluate((element) => element.scrollTop > 0), 'wheel did not scroll sidebar owner')

  const protectedSurfaces = await page.evaluate(() => {
    const read = (selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return {
        backgroundColor: style.backgroundColor,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
      }
    }
    return {
      settings: read('#settings-surface'),
      menu: read('#native-menu'),
      popover: read('#native-popover'),
      dialog: read('#native-dialog'),
      preview: read('#native-image-preview'),
    }
  })
  assert.deepEqual(protectedSurfaces, {
    settings: {
      backgroundColor: 'rgb(255, 255, 255)',
      opacity: '1',
      pointerEvents: 'auto',
    },
    menu: {
      backgroundColor: 'rgb(255, 255, 255)',
      opacity: '1',
      pointerEvents: 'auto',
    },
    popover: {
      backgroundColor: 'rgb(255, 255, 255)',
      opacity: '1',
      pointerEvents: 'auto',
    },
    dialog: {
      backgroundColor: 'rgb(255, 255, 255)',
      opacity: '1',
      pointerEvents: 'auto',
    },
    preview: {
      backgroundColor: 'rgb(16, 18, 24)',
      opacity: '1',
      pointerEvents: 'auto',
    },
  })
  await page.screenshot({
    path: path.join(os.tmpdir(), 'codex-compass-cyan-virtual-stage-desktop.png'),
    fullPage: false,
  })

  await page.setViewportSize({ width: 900, height: 900 })
  const compact = await page.evaluate(() => {
    const cards = document.querySelector('.cc-theme-showcase-cards')
    const cardBoxes = Array.from(cards.children).map((card) => card.getBoundingClientRect())
    const rootBox = document.querySelector('.cc-theme-showcase').getBoundingClientRect()
    const composerBox = document.querySelector('[data-codex-theme-native-composer="true"]').getBoundingClientRect()
    return {
      columns: getComputedStyle(cards).gridTemplateColumns.split(' ').length,
      firstRowAligned: Math.abs(cardBoxes[0].top - cardBoxes[1].top) <= 1,
      secondRowAligned: Math.abs(cardBoxes[2].top - cardBoxes[3].top) <= 1,
      rowsSeparated: cardBoxes[2].top > cardBoxes[0].bottom,
      noComposerOverlap: rootBox.bottom <= composerBox.top + 1,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })
  assert.deepEqual(compact, {
    columns: 2,
    firstRowAligned: true,
    secondRowAligned: true,
    rowsSeparated: true,
    noComposerOverlap: true,
    noHorizontalOverflow: true,
  })
  await page.screenshot({
    path: path.join(os.tmpdir(), 'codex-compass-cyan-virtual-stage-compact.png'),
    fullPage: false,
  })

  assert.deepEqual(consoleProblems, [])
})

function fixtureHtml(themeCss, themeConcept, wallpaperUrl) {
  const cards = themeConcept.copy.cards
    .map(
      (card, index) => `
        <button class="cc-theme-showcase-card" type="button" aria-label="${escapeHtml(card.title)}" data-card-index="${index}">
          <span class="cc-theme-showcase-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M5 6h14v12H5zM8 10h8M8 14h5"/></svg>
          </span>
          <span class="cc-theme-showcase-card-copy">
            <span class="cc-theme-showcase-card-label">${escapeHtml(card.title)}</span>
            <span class="cc-theme-showcase-card-description">${escapeHtml(card.prompt)}</span>
          </span>
          <span class="cc-theme-showcase-card-arrow" aria-hidden="true">-&gt;</span>
          <span class="cc-theme-showcase-card-index">${String(index + 1).padStart(2, '0')}</span>
        </button>`,
    )
    .join('')

  const sidebarRows = Array.from({ length: 24 }, (_, index) => {
    const active = index === 0 ? ' cc-theme-shell-active-row' : ''
    return `<button class="cc-theme-shell-thread-row${active}" type="button">舞台任务 ${index + 1}</button>`
  }).join('')

  const prompts = JSON.stringify(themeConcept.copy.cards.map((card) => card.prompt))

  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>Cyan Virtual Stage QA</title>
      <style>
        * { box-sizing: border-box; }
        html, body { width: 100%; min-width: 0; min-height: 100%; margin: 0; font-family: "Segoe UI", sans-serif; }
        body { display: grid; grid-template-columns: 278px minmax(0, 1fr); overflow-x: hidden; color: #173b43; background: #effbfd; }
        button, textarea { font: inherit; }
        button { cursor: pointer; }
        .cc-theme-shell-sidebar { position: fixed; inset: 0 auto 0 0; width: 278px; padding: 10px; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; gap: 6px; overflow: hidden; }
        .cc-theme-shell-product-button, .cc-theme-shell-search-button, .cc-theme-shell-new-task, .cc-theme-shell-nav-row, .cc-theme-shell-account-row { position: relative; width: 100%; min-height: 34px; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; }
        .cc-theme-shell-nav { display: grid; gap: 2px; }
        [data-app-action-sidebar-scroll] { min-height: 0; max-height: 520px; padding-right: 3px; display: grid; align-content: start; gap: 2px; }
        .cc-theme-shell-group-heading { position: relative; min-height: 30px; display: flex; align-items: center; }
        .cc-theme-shell-project-row, .cc-theme-shell-thread-row { width: 100%; display: flex; align-items: center; border: 0; text-align: left; }
        .cc-theme-shell-account-row { margin-top: 4px; }
        .app-main { grid-column: 2; min-width: 0; padding: 56px 24px 30px; }
        .cc-theme-shell-topbar { position: fixed; z-index: 10; top: 0; right: 0; left: 278px; height: 42px; display: flex; align-items: center; justify-content: flex-end; padding: 0 12px; }
        .cc-theme-shell-window-control { width: 38px; height: 32px; display: grid; place-items: center; border: 0; }
        .cc-theme-showcase-host { width: min(100%, 1110px); margin: 0 auto; }
        .cc-theme-showcase { position: relative; isolation: isolate; width: 100%; display: grid; overflow: hidden; background-image: url("${wallpaperUrl}"); background-size: cover; background-repeat: no-repeat; }
        .cc-theme-showcase::before, .cc-theme-showcase::after { content: ""; position: absolute; z-index: 0; inset: 0; pointer-events: none; }
        .cc-theme-showcase-brandline { position: absolute; z-index: 4; display: flex; align-items: center; }
        .cc-theme-showcase-brandmark { display: grid; place-items: center; }
        .cc-theme-showcase-brandcopy { display: grid; }
        .cc-theme-showcase-status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
        .cc-theme-showcase-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
        .cc-theme-showcase-copy { position: relative; z-index: 3; }
        .cc-theme-showcase-eyebrow, .cc-theme-showcase-title, .cc-theme-showcase-subtitle { margin: 0; }
        .cc-theme-showcase-badge { display: inline-flex; padding: 5px 9px; border: 1px solid; }
        .cc-theme-showcase-motif { position: absolute; z-index: 2; }
        .cc-theme-showcase-motif::before, .cc-theme-showcase-motif::after { position: absolute; }
        .cc-theme-showcase-cards { position: relative; z-index: 4; display: grid; }
        .cc-theme-showcase-card { position: relative; text-align: left; }
        .cc-theme-showcase-card-icon { display: grid; place-items: center; }
        .cc-theme-showcase-card-icon svg { fill: none; stroke: currentColor; stroke-width: 1.8; }
        .cc-theme-showcase-card-copy { display: grid; }
        .cc-theme-showcase-card-label, .cc-theme-showcase-card-description { display: block; }
        .cc-theme-showcase-companion { position: absolute; z-index: 5; overflow: hidden; pointer-events: none; }
        .cc-theme-showcase-companion-mark, .cc-theme-showcase-companion-label { position: absolute; }
        .cc-theme-showcase-companion-label { right: 0; bottom: 0; left: 0; }
        .cc-theme-showcase-composer { width: min(100%, 1060px); min-height: 112px; margin: 14px auto 0; padding: 16px; display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 12px; }
        .cc-theme-showcase-composer textarea { width: 100%; min-height: 72px; resize: none; border: 0; outline: 0; background: transparent; }
        .cc-theme-showcase-composer button { width: 42px; height: 42px; border-radius: 50%; }
        #protected-surfaces { position: absolute; top: 1400px; left: 320px; display: grid; gap: 8px; }
        #settings-surface, #native-menu, #native-popover, #native-dialog { width: 240px; min-height: 60px; padding: 12px; opacity: 1; pointer-events: auto; color: #202124; background: rgb(255, 255, 255); border: 1px solid #d8dde2; }
        #native-image-preview { width: 240px; min-height: 120px; padding: 12px; opacity: 1; pointer-events: auto; color: #ffffff; background: rgb(16, 18, 24); }
        @media (max-width: 980px) {
          body { grid-template-columns: 230px minmax(0, 1fr); }
          .cc-theme-shell-sidebar { width: 230px; }
          .cc-theme-shell-topbar { left: 230px; }
          .app-main { padding-right: 14px; padding-left: 14px; }
        }
      </style>
      <style>${themeCss}</style>
    </head>
    <body>
      <aside class="cc-theme-shell-sidebar">
        <button class="cc-theme-shell-product-button" type="button">Codex Compass</button>
        <button class="cc-theme-shell-search-button" type="button">搜索</button>
        <button class="cc-theme-shell-new-task" type="button">新建任务</button>
        <nav class="cc-theme-shell-nav">
          <button class="cc-theme-shell-nav-row cc-theme-shell-nav-coral" type="button">已安排</button>
          <button class="cc-theme-shell-nav-row cc-theme-shell-nav-mint" type="button">技能</button>
          <button class="cc-theme-shell-nav-row cc-theme-shell-nav-sky" type="button">站点</button>
          <button class="cc-theme-shell-nav-row cc-theme-shell-nav-violet" type="button">拉取请求</button>
        </nav>
        <div data-app-action-sidebar-scroll>
          <div class="cc-theme-shell-group-heading">项目</div>
          <button class="cc-theme-shell-project-row" type="button">虚拟舞台工作区</button>
          ${sidebarRows}
        </div>
        <button class="cc-theme-shell-account-row" type="button">本地账户</button>
      </aside>
      <main class="app-main">
        <header class="cc-theme-shell-topbar">
          <button class="cc-theme-shell-window-control cc-theme-shell-window-minimize" type="button">_</button>
          <button class="cc-theme-shell-window-control cc-theme-shell-window-maximize" type="button">[]</button>
          <button class="cc-theme-shell-window-control cc-theme-shell-window-close" type="button">x</button>
        </header>
        <section class="cc-theme-showcase-host">
          <section class="cc-theme-showcase theme-cyan-virtual-stage layout-idol cards-glass" style="--cc-showcase-hero: url('${wallpaperUrl}')">
            <div class="cc-theme-showcase-brandline">
              <span class="cc-theme-showcase-brandmark" aria-hidden="true">*</span>
              <span class="cc-theme-showcase-brandcopy">
                <span class="cc-theme-showcase-brandname">${escapeHtml(themeConcept.copy.brandName)}</span>
                <span class="cc-theme-showcase-brandmeta">${escapeHtml(themeConcept.copy.brandMeta)}</span>
              </span>
              <span class="cc-theme-showcase-status">${escapeHtml(themeConcept.copy.status)}</span>
            </div>
            <div class="cc-theme-showcase-copy">
              <p class="cc-theme-showcase-eyebrow">${escapeHtml(themeConcept.copy.eyebrow)}</p>
              <h1 class="cc-theme-showcase-title">${escapeHtml(themeConcept.copy.title)}</h1>
              <p class="cc-theme-showcase-subtitle">${escapeHtml(themeConcept.copy.subtitle)}</p>
              <span class="cc-theme-showcase-badge">${escapeHtml(themeConcept.copy.badge)}</span>
            </div>
            <div class="cc-theme-showcase-motif" aria-hidden="true"></div>
            <div class="cc-theme-showcase-companion" aria-hidden="true">
              <span class="cc-theme-showcase-companion-mark">CC</span>
              <span class="cc-theme-showcase-companion-label">${escapeHtml(themeConcept.copy.badge)}</span>
            </div>
            <div class="cc-theme-showcase-cards">${cards}</div>
          </section>
        </section>
        <section class="cc-theme-showcase-composer" data-codex-theme-native-composer="true">
          <textarea id="native-composer-input" placeholder="${escapeHtml(themeConcept.copy.composerPlaceholder)}"></textarea>
          <button type="button" aria-label="发送">-&gt;</button>
        </section>
      </main>
      <section id="protected-surfaces">
        <aside id="settings-surface">设置</aside>
        <div id="native-menu" role="menu">项目操作</div>
        <div id="native-popover">选择项目</div>
        <section id="native-dialog" role="dialog">确认操作</section>
        <section id="native-image-preview" role="dialog">图片预览</section>
      </section>
      <script>
        window.fixtureState = { quickCardClicks: 0 };
        const prompts = ${prompts};
        document.querySelectorAll('.cc-theme-showcase-card').forEach((card) => {
          card.addEventListener('click', () => {
            window.fixtureState.quickCardClicks += 1;
            const input = document.querySelector('#native-composer-input');
            input.value = prompts[Number(card.dataset.cardIndex)];
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
          });
        });
      </script>
    </body>
  </html>`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function collectSelectorHeaders(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const headers = []
  let tokenStart = 0
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index]
    if (character === '{') {
      const header = clean.slice(tokenStart, index).trim()
      if (header && !header.startsWith('@')) headers.push(header)
      tokenStart = index + 1
      continue
    }
    if (character === '}' || character === ';') tokenStart = index + 1
  }
  return headers
}

function splitTopLevelSelectors(header) {
  const selectors = []
  let tokenStart = 0
  let parentheses = 0
  let brackets = 0
  let quote = ''
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index]
    if (quote) {
      if (character === quote && header[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parentheses += 1
    if (character === ')') parentheses -= 1
    if (character === '[') brackets += 1
    if (character === ']') brackets -= 1
    if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(header.slice(tokenStart, index).trim())
      tokenStart = index + 1
    }
  }
  selectors.push(header.slice(tokenStart).trim())
  return selectors.filter(Boolean)
}
