import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..')
const conceptRoot = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'concepts',
)
const cssPath = path.join(conceptRoot, 'warm-manuscript.css')
const jsonPath = path.join(conceptRoot, 'warm-manuscript.json')
const [css, contractText] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(jsonPath, 'utf8'),
])
const contract = JSON.parse(contractText)
const themeScope = 'html[data-codex-compass-theme="warm-manuscript"]'

function splitSelectorList(selectorText) {
  const selectors = []
  let start = 0
  let roundDepth = 0
  let squareDepth = 0
  let quote = ''

  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index]
    if (quote) {
      if (character === quote && selectorText[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') roundDepth += 1
    if (character === ')') roundDepth -= 1
    if (character === '[') squareDepth += 1
    if (character === ']') squareDepth -= 1
    if (character === ',' && roundDepth === 0 && squareDepth === 0) {
      selectors.push(selectorText.slice(start, index).trim())
      start = index + 1
    }
  }

  selectors.push(selectorText.slice(start).trim())
  return selectors.filter(Boolean)
}

function collectRules(source, atRules = [], output = []) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let cursor = 0

  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    if (open === -1) break
    const prelude = text.slice(cursor, open).trim()
    let depth = 1
    let quote = ''
    let close = open + 1

    for (; close < text.length && depth > 0; close += 1) {
      const character = text[close]
      if (quote) {
        if (character === quote && text[close - 1] !== '\\') quote = ''
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '{') depth += 1
      if (character === '}') depth -= 1
    }

    assert.equal(depth, 0, `Unbalanced CSS block near: ${prelude}`)
    const body = text.slice(open + 1, close - 1)
    if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
      collectRules(body, [...atRules, prelude], output)
    } else if (prelude && !prelude.startsWith('@')) {
      output.push({ selector: prelude, body, atRules })
    }
    cursor = close
  }

  return output
}

const rules = collectRules(css)

test('contract defines the final Fortune Worker concept', () => {
  assert.equal(contract.themeId, 'warm-manuscript')
  assert.equal(contract.layoutStyle, 'fortune')
  assert.equal(contract.displayName, '财神打工版')
  assert.equal(contract.copy.title, '今天先把项目搞赚钱')
  assert.equal(contract.copy.status, '今日财运在线')
  assert.equal(contract.copy.cards.length, 4)
  assert.deepEqual(contract.copy.cards.map((card) => card.title), [
    '成本优化',
    '技术债清账',
    '自动报表总结',
    '冲突合并开运',
  ])
  assert.equal(contract.asset.type, 'pure-wallpaper')
  assert.match(contract.asset.subject, /原创/)
  assert.match(contract.asset.subject, /成年/)
  assert.equal(contract.appearance.codexMode, 'light')
  assert.equal(contract.appearance.nativeTitleBarGlyph, 'black')
  assert.equal(contract.layout.composer.usesNativeComposer, true)
  assert.equal(contract.layout.composer.createsReplacementComposer, false)
})

test('every style selector is limited to the warm-manuscript runtime scope', () => {
  assert.ok(rules.length > 40, `Expected a complete concept slice, found ${rules.length} rules`)
  for (const rule of rules) {
    for (const selector of splitSelectorList(rule.selector)) {
      assert.ok(
        selector.startsWith(themeScope),
        `Unscoped selector: ${selector}`,
      )
      assert.doesNotMatch(selector, /\s(?:aside|nav|main|body)(?:\s|,|$)/)
      assert.doesNotMatch(selector, /\[class\*=["'](?:sidebar|content)/i)
    }
  }
})

test('rows and quick cards cannot become independent scroll containers', () => {
  const protectedRules = rules.filter(({ selector }) =>
    /cc-theme-(?:shell-(?:project|thread)-row|showcase-card)(?:\b|[.:#\[])/.test(selector)
  )
  assert.ok(protectedRules.length >= 8)

  for (const rule of protectedRules) {
    assert.doesNotMatch(
      rule.body,
      /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/i,
      `Scrollable row/card rule: ${rule.selector}`,
    )
  }

  const rowRule = protectedRules.find(({ selector, body }) =>
    selector.includes('.cc-theme-shell-project-row')
    && selector.includes('.cc-theme-shell-thread-row')
    && /overflow\s*:\s*clip/i.test(body)
  )
  const cardRule = protectedRules.find(({ selector, body }) =>
    selector.includes('.cc-theme-showcase-card')
    && /overflow\s*:\s*clip/i.test(body)
  )
  assert.ok(rowRule, 'Project and thread rows must explicitly use overflow: clip')
  assert.ok(cardRule, 'Quick cards must explicitly use overflow: clip')
  assert.equal(contract.layout.sidebar.independentRowScrollbars, false)
})

test('card grid is four columns on desktop and stable two by two when compact', () => {
  const desktopGrid = rules.find(({ selector, body, atRules }) =>
    atRules.length === 0
    && selector.includes('.cc-theme-showcase-cards')
    && /grid-template-columns\s*:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/i.test(body)
  )
  const compactGrid = rules.find(({ selector, body, atRules }) =>
    selector.includes('.cc-theme-showcase-cards')
    && atRules.some((rule) => /max-width:\s*1080px/i.test(rule))
    && /grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/i.test(body)
  )
  const narrowGrid = rules.find(({ selector, body, atRules }) =>
    selector.includes('.cc-theme-showcase-cards')
    && atRules.some((rule) => /max-width:\s*720px/i.test(rule))
    && /grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/i.test(body)
  )

  assert.ok(desktopGrid, 'Desktop layout must render one row of four cards')
  assert.ok(compactGrid, 'Compact layout must render a two-column card grid')
  assert.ok(narrowGrid, 'Narrow layout must preserve the two-column card grid')
  assert.equal(contract.layout.desktop.cardColumns, 4)
  assert.equal(contract.layout.compact.cardColumns, 2)
  assert.equal(contract.layout.compact.cardRows, 2)
})

test('operational surfaces stay opaque while image preview remains untouched', () => {
  const menuProtection = rules.find(({ selector, body }) =>
    selector.includes('[role="menu"]')
    && selector.includes('[data-slot="popover-content"]')
    && /background-color\s*:\s*var\(--wm-paper-raised\)/i.test(body)
    && /opacity\s*:\s*1/i.test(body)
  )
  const dialogProtection = rules.find(({ selector, body }) =>
    selector.includes('[role="dialog"]')
    && selector.includes(':not([aria-label="图片预览"])')
    && selector.includes(':not([aria-label="Image preview"])')
    && /background-color\s*:\s*var\(--wm-paper-raised\)/i.test(body)
    && /opacity\s*:\s*1/i.test(body)
  )
  const previewSelectors = rules
    .filter(({ selector }) => /图片预览|Image preview/.test(selector))
    .map(({ selector }) => selector)

  assert.ok(menuProtection, 'Menus, listboxes, popovers, and command panels need an opaque surface')
  assert.ok(dialogProtection, 'Ordinary dialogs need an opaque surface')
  assert.deepEqual(previewSelectors, [dialogProtection.selector])
  assert.match(previewSelectors[0], /:not\(\[aria-label="图片预览"\]\)/)
  assert.match(previewSelectors[0], /:not\(\[aria-label="Image preview"\]\)/)
  assert.match(contract.selectors.untouchedSurface, /图片预览/)
  assert.ok(contract.acceptanceContract.operationalSurfaces.some((item) => item.includes('图片预览')))
})

test('Chromium renders desktop and compact layouts without card, row, or surface regressions', async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.setContent(`
    <!doctype html>
    <html data-codex-compass-theme="warm-manuscript" data-codex-compass-theme-page="home">
      <head>
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; min-height: 100%; }
          body { padding: 20px; background: #fbf3dd; }
          .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); gap: 18px; }
          .cc-theme-shell-sidebar { position: relative; min-width: 0; height: 760px; padding: 12px; overflow: hidden; }
          .cc-theme-shell-product-button,
          .cc-theme-shell-nav-row,
          .cc-theme-shell-account-row { position: relative; width: 100%; display: flex; align-items: center; }
          .cc-theme-shell-product-button { margin-bottom: 8px; }
          .cc-theme-shell-nav-row { min-height: 32px; padding: 0 8px; }
          .cc-theme-shell-project-row,
          .cc-theme-shell-thread-row { width: 100%; }
          .cc-theme-shell-account-row { min-height: 38px; margin-top: 18px; padding: 0 8px; }
          .workspace { min-width: 0; }
          .cc-theme-showcase { position: relative; isolation: isolate; width: 100%; display: grid; background-image: linear-gradient(90deg, #fbf3dd, #f6e4b7); background-size: cover; }
          .cc-theme-showcase::before,
          .cc-theme-showcase::after { content: ""; position: absolute; z-index: -1; pointer-events: none; }
          .cc-theme-showcase::before { inset: 0; }
          .cc-theme-showcase-brandline { position: absolute; z-index: 3; display: flex; align-items: center; }
          .cc-theme-showcase-brandmark,
          .cc-theme-showcase-card-icon,
          .cc-theme-showcase-card-arrow { display: grid; place-items: center; }
          .cc-theme-showcase-brandcopy { display: grid; }
          .cc-theme-showcase-status { margin-left: auto; }
          .cc-theme-showcase-copy,
          .cc-theme-showcase-cards { position: relative; z-index: 2; }
          .cc-theme-showcase-title,
          .cc-theme-showcase-subtitle { margin: 0; }
          .cc-theme-showcase-card { position: relative; width: 100%; }
          .cc-theme-showcase-card-copy { min-width: 0; }
          .cc-theme-showcase-card-description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
          .cc-theme-showcase-card-index { position: absolute; top: 7px; right: 8px; }
          .cc-theme-showcase-motif,
          .cc-theme-showcase-companion { position: absolute; z-index: 2; pointer-events: none; }
          .cc-theme-showcase-motif::before,
          .cc-theme-showcase-motif::after { content: ""; position: absolute; }
          .cc-theme-shell-composer { width: 100%; min-height: 76px; margin-top: 14px; padding: 10px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; align-items: end; }
          .cc-theme-shell-composer textarea { width: 100%; min-width: 0; height: 48px; resize: none; border: 0; }
          .cc-theme-shell-composer button { min-height: 34px; }
          [role="menu"], [role="dialog"] { margin-top: 8px; padding: 12px; border: 1px solid; }
          [role="dialog"][aria-label="图片预览"] { background: transparent; }
        </style>
        <style>${css}</style>
      </head>
      <body>
        <div class="shell">
          <aside class="cc-theme-shell-sidebar">
            <button class="cc-theme-shell-product-button" data-cc-theme-mark="福" data-cc-theme-label="财神打工版">Codex</button>
            <button class="cc-theme-shell-nav-row cc-theme-shell-new-task">新建任务</button>
            <div class="cc-theme-shell-group-heading">项目</div>
            <div class="cc-theme-shell-project-row cc-theme-shell-nav-row">财神招财项目</div>
            <div class="cc-theme-shell-thread-row cc-theme-shell-nav-row cc-theme-shell-active-row">成本优化任务</div>
            <div class="cc-theme-shell-thread-row cc-theme-shell-nav-row">技术债清账</div>
            <button class="cc-theme-shell-account-row">财神打工人</button>
          </aside>
          <main class="workspace">
            <section class="cc-theme-showcase theme-warm-manuscript layout-fortune cards-paper">
              <div class="cc-theme-showcase-brandline">
                <span class="cc-theme-showcase-brandmark">福</span>
                <span class="cc-theme-showcase-brandcopy">
                  <span class="cc-theme-showcase-brandname">财神工作台</span>
                  <span class="cc-theme-showcase-brandmeta">财神打工版 · Codex Compass</span>
                </span>
                <span class="cc-theme-showcase-status">今日财运在线</span>
              </div>
              <div class="cc-theme-showcase-copy">
                <span class="cc-theme-showcase-eyebrow">财神打工版 · Codex Compass</span>
                <h1 class="cc-theme-showcase-title">今天先把项目搞赚钱</h1>
                <p class="cc-theme-showcase-subtitle">优化成本、清理技术债、催进度，让代码为结果服务。</p>
                <span class="cc-theme-showcase-badge">今日财运在线</span>
              </div>
              <div class="cc-theme-showcase-motif"></div>
              <div class="cc-theme-showcase-companion">
                <span class="cc-theme-showcase-companion-mark">福</span>
                <span class="cc-theme-showcase-companion-label">多写代码，多发红包</span>
              </div>
              <div class="cc-theme-showcase-cards">
                ${contract.copy.cards.map((card, index) => `
                  <button class="cc-theme-showcase-card">
                    <span class="cc-theme-showcase-card-icon">${index + 1}</span>
                    <span class="cc-theme-showcase-card-copy">
                      <span class="cc-theme-showcase-card-label">${card.title}</span>
                      <span class="cc-theme-showcase-card-description">${card.shortDescription}</span>
                    </span>
                    <span class="cc-theme-showcase-card-arrow">›</span>
                    <span class="cc-theme-showcase-card-index">0${index + 1}</span>
                  </button>
                `).join('')}
              </div>
            </section>
            <div class="cc-theme-shell-composer">
              <button class="cc-theme-shell-attach-button">+</button>
              <textarea aria-label="任务输入"></textarea>
              <button class="cc-theme-shell-model-button">gpt-5.6-sol</button>
              <button class="cc-theme-shell-send-button">发送</button>
            </div>
            <div role="menu">原生项目菜单</div>
            <div role="dialog" aria-label="Codex 设置">原生设置弹窗</div>
            <div role="dialog" aria-label="图片预览">原生图片预览</div>
          </main>
        </div>
      </body>
    </html>
  `, { waitUntil: 'domcontentloaded' })

  const desktop = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    const projectRow = document.querySelector('.cc-theme-shell-project-row')
    const threadRow = document.querySelector('.cc-theme-shell-thread-row')
    const menu = document.querySelector('[role="menu"]')
    const settings = document.querySelector('[role="dialog"][aria-label="Codex 设置"]')
    const preview = document.querySelector('[role="dialog"][aria-label="图片预览"]')
    return {
      cardTops: cards.map((card) => Math.round(card.getBoundingClientRect().top)),
      cardOverflow: cards.map((card) => ({
        x: getComputedStyle(card).overflowX,
        y: getComputedStyle(card).overflowY,
        scrollable: card.scrollHeight > card.clientHeight || card.scrollWidth > card.clientWidth,
      })),
      projectOverflow: [getComputedStyle(projectRow).overflowX, getComputedStyle(projectRow).overflowY],
      threadOverflow: [getComputedStyle(threadRow).overflowX, getComputedStyle(threadRow).overflowY],
      menuBackground: getComputedStyle(menu).backgroundColor,
      menuOpacity: getComputedStyle(menu).opacity,
      settingsBackground: getComputedStyle(settings).backgroundColor,
      settingsOpacity: getComputedStyle(settings).opacity,
      previewBackground: getComputedStyle(preview).backgroundColor,
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })

  assert.equal(new Set(desktop.cardTops).size, 1, JSON.stringify(desktop))
  assert.ok(desktop.cardOverflow.every((entry) =>
    entry.x === 'clip' && entry.y === 'clip' && entry.scrollable === false
  ), JSON.stringify(desktop))
  assert.deepEqual(desktop.projectOverflow, ['clip', 'clip'])
  assert.deepEqual(desktop.threadOverflow, ['clip', 'clip'])
  assert.notEqual(desktop.menuBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(desktop.menuOpacity, '1')
  assert.notEqual(desktop.settingsBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(desktop.settingsOpacity, '1')
  assert.equal(desktop.previewBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(desktop.documentFits, true)

  await page.setViewportSize({ width: 720, height: 980 })
  const compact = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    const rects = cards.map((card) => card.getBoundingClientRect())
    const distinctTops = [...new Set(rects.map((rect) => Math.round(rect.top)))]
    const distinctLefts = [...new Set(rects.map((rect) => Math.round(rect.left)))]
    return {
      rows: distinctTops.length,
      columns: distinctLefts.length,
      cardWidths: rects.map((rect) => Math.round(rect.width)),
      companionDisplay: getComputedStyle(document.querySelector('.cc-theme-showcase-companion')).display,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })

  assert.equal(compact.rows, 2, JSON.stringify(compact))
  assert.equal(compact.columns, 2, JSON.stringify(compact))
  assert.ok(compact.cardWidths.every((width) => width >= 160), JSON.stringify(compact))
  assert.equal(compact.companionDisplay, 'none')
  assert.equal(compact.noHorizontalOverflow, true)
})
