import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA is unavailable')

const remoteRoot = path.join(appData, 'chat.ai-api.relay-meter', 'remote-control')
const settings = JSON.parse(await readFile(path.join(remoteRoot, 'settings.json'), 'utf8'))
const sensitive = JSON.parse(
  await readFile(path.join(remoteRoot, 'sensitive', 'credentials.json'), 'utf8'),
)
assert.equal(settings.enabled, true, 'remote control must be enabled')
assert.equal(settings.paused, false, 'remote control must not be paused')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

const screenshotRoot = path.join(tmpdir(), 'codex-compass-remote-live-137')
const statusScreenshot = `${screenshotRoot}-status.png`
const projectsScreenshot = `${screenshotRoot}-projects.png`
const projectLoadedScreenshot = `${screenshotRoot}-project-loaded.png`
const capabilityScreenshot = `${screenshotRoot}-capabilities.png`
const capabilitySkillsScreenshot = `${screenshotRoot}-capability-skills.png`
const historyScreenshot = `${screenshotRoot}-history.png`

const url = new URL(settings.publicWebUrl)
url.searchParams.set('room', settings.roomId)
url.searchParams.set('desktop', settings.desktopDeviceId)
url.hash = new URLSearchParams({
  token: sensitive.accessToken,
  key: sensitive.encryptionKey,
}).toString()

try {
  await page.goto(url.toString())
  await page.locator('#deviceView').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('#connectionBadge').filter({ hasText: '中继已连接' }).waitFor()
  await page.locator('#sessionSummary').waitFor()
  await page.waitForFunction(() => {
    const text = document.querySelector('#sessionSummary')?.textContent || ''
    return text && !text.includes('正在同步')
  }, null, { timeout: 30_000 })

  const result = {
    deviceName: await page.locator('#deviceName').textContent(),
    codexStatus: await page.locator('#codexStatus').textContent(),
    remoteStatus: await page.locator('#remoteStatus').textContent(),
    sessionSummary: await page.locator('#sessionSummary').textContent(),
    projectCount: await page.locator('.project-group').count(),
    projectNames: await page.locator('.project-identity strong').allTextContents(),
    continuableSessions: await page.locator('.session-access.continuable').count(),
    viewOnlySessions: await page.locator('.session-access.view-only').count(),
    workspaceCount: 0,
    modelCount: 0,
    pluginRows: 0,
    skillRows: 0,
    localizedPluginTitles: [],
    localizedSkillTitle: '',
    historyMessages: 0,
    projectHistoryMessages: {},
    projectLoadedOnDemand: '',
    projectLoadedSessionTitlePresent: false,
    projectLoadedHistoryMessages: 0,
    uploadEnabledWorkspaces: 0,
    consoleErrors,
    screenshots: [
      statusScreenshot,
      projectsScreenshot,
      projectLoadedScreenshot,
      capabilityScreenshot,
      capabilitySkillsScreenshot,
      historyScreenshot,
    ],
  }
  await page.screenshot({ path: statusScreenshot, fullPage: false })
  await page.screenshot({ path: projectsScreenshot, fullPage: true })

  const projectLoadButton = page.locator('.project-load-button').first()
  await projectLoadButton.waitFor({ state: 'visible', timeout: 30_000 })
  result.projectLoadedOnDemand = (
    await projectLoadButton.locator('..').locator('..').locator('.project-identity strong').textContent()
  )?.trim() || ''
  const projectGroup = page.locator('.project-group').filter({
    has: page.getByText(result.projectLoadedOnDemand, { exact: true }),
  }).first()
  await projectLoadButton.click()
  const projectSession = projectGroup.locator('.session-row').first()
  await projectSession.waitFor({ state: 'visible', timeout: 30_000 })
  const projectLoadedSessionTitle = (
    await projectSession.locator('.session-content strong').textContent()
  )?.trim() || ''
  result.projectLoadedSessionTitlePresent = Boolean(projectLoadedSessionTitle)
  await page.screenshot({ path: projectLoadedScreenshot, fullPage: false })
  await projectSession.click()
  await page.getByText(/历史已同步/).waitFor({ timeout: 30_000 })
  result.projectLoadedHistoryMessages = await page.locator('#messageList .message').count()
  await page.locator('#backButton').click()
  await page.locator('#sessionsPanel').waitFor({ state: 'visible' })

  await page.locator('[data-view="new"]').click()
  result.workspaceCount = await page.locator('#workspaceSelect option').count()
  result.modelCount = await page.locator('#modelSelect option').count()
  const workspaceIds = await page.locator('#workspaceSelect option').evaluateAll((options) => (
    options.map((option) => option.value)
  ))
  for (const workspaceId of workspaceIds) {
    await page.locator('#workspaceSelect').selectOption(workspaceId)
    if (await page.locator('#newAttachmentButton').isEnabled()) {
      result.uploadEnabledWorkspaces += 1
    }
  }
  await page.locator('#newSkillButton').click()
  await page.locator('#capabilityDialog').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const text = document.querySelector('#capabilityList')?.textContent || ''
    return text && !text.includes('正在读取')
  }, null, { timeout: 30_000 })
  result.pluginRows = await page.locator('.capability-section').first().locator('.capability-row').count()
  result.skillRows = await page.locator('.capability-section').last().locator('.capability-row').count()
  result.localizedPluginTitles = await page.locator('.capability-section').first().locator('strong').allTextContents()
  await page.getByText('网页应用开发', { exact: true }).waitFor()
  await page.getByText('Chrome 浏览器', { exact: true }).waitFor()
  await page.locator('#capabilitySearch').fill('Build Web Apps')
  await page.locator('[data-capability-name="build-web-apps"]').filter({ hasText: '网页应用开发' }).waitFor()
  await page.locator('#capabilitySearch').fill('')
  await page.screenshot({ path: capabilityScreenshot, fullPage: false })
  await page.locator('#capabilitySearch').fill('playwright')
  const localizedSkill = page.locator('[data-capability-name="playwright"]')
  await localizedSkill.filter({ hasText: '浏览器自动化' }).waitFor()
  result.localizedSkillTitle = (await localizedSkill.locator('strong').textContent())?.trim() || ''
  await page.screenshot({ path: capabilitySkillsScreenshot, fullPage: false })
  await page.locator('#capabilitySearch').fill('')
  await page.locator('#closeCapabilityDialog').click()

  await page.locator('[data-view="sessions"]').click()
  for (const projectName of ['Kitsunebi', 'A论文']) {
    await page.locator('#sessionSearch').fill(projectName)
    await page.waitForFunction((name) => {
      const summary = document.querySelector('#sessionSummary')?.textContent || ''
      const projects = [...document.querySelectorAll('.project-identity strong')]
        .map((element) => element.textContent)
      return summary.includes('匹配') && projects.includes(name)
    }, projectName, { timeout: 30_000 })
    const group = page.locator('.project-group').filter({ hasText: projectName }).first()
    const session = group.locator('.session-row').first()
    await session.waitFor({ state: 'visible', timeout: 30_000 })
    await session.click()
    await page.getByText(/历史已同步/).waitFor({ timeout: 30_000 })
    const messageCount = await page.locator('#messageList .message').count()
    result.projectHistoryMessages[projectName] = messageCount
    result.historyMessages += messageCount
    if (projectName === 'A论文') await page.screenshot({ path: historyScreenshot, fullPage: false })
    await page.locator('#backButton').click()
    await page.locator('#sessionsPanel').waitFor({ state: 'visible' })
  }

  assert.ok(result.workspaceCount > 0, 'no authorized workspaces were returned')
  assert.ok(result.modelCount > 0, 'no models were returned')
  assert.ok(result.skillRows > 0, 'no Skills were returned')
  assert.ok(result.localizedPluginTitles.includes('文档'), 'Documents plugin was not localized')
  assert.ok(result.localizedPluginTitles.includes('网页应用开发'), 'Build Web Apps plugin was not localized')
  assert.equal(result.localizedSkillTitle, '浏览器自动化', 'Playwright skill was not localized')
  assert.ok(result.projectLoadedOnDemand, 'no project offered on-demand session loading')
  assert.equal(result.projectLoadedSessionTitlePresent, true, 'project-specific session loading returned no task')
  assert.ok(result.projectLoadedHistoryMessages > 0, 'project-specific task history was empty')
  assert.ok(result.historyMessages > 0, 'session history was empty')
  assert.equal(result.projectCount, 9, 'Codex formal project count did not match the desktop sidebar')
  assert.ok(result.projectNames.includes('Kitsunebi'), 'Kitsunebi project was not listed')
  assert.ok(result.projectNames.includes('A论文'), 'A论文 project was not listed')
  assert.equal(result.viewOnlySessions, 0, 'synced projects should not remain view-only')
  assert.ok(result.projectHistoryMessages.Kitsunebi > 0, 'Kitsunebi history was empty')
  assert.ok(result.projectHistoryMessages['A论文'] > 0, 'A论文 history was empty')
  assert.deepEqual(consoleErrors, [])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await browser.close()
}
