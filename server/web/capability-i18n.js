const PLUGIN_TRANSLATIONS = {
  documents: ['文档', '创建和编辑 Word、Google Docs 等文档'],
  pdf: ['PDF 工具', '读取、创建并校验 PDF 文件'],
  spreadsheets: ['电子表格', '创建和编辑 Excel、CSV 等电子表格'],
  presentations: ['演示文稿', '创建和编辑 PowerPoint、Google Slides 演示文稿'],
  'template-creator': ['模板创建器', '创建或更新文档、电子表格和演示文稿模板'],
  chrome: ['Chrome 浏览器', '使用现有登录状态控制 Chrome 浏览器'],
  'computer-use': ['电脑操作', '控制 Windows 桌面应用'],
  latex: ['LaTeX 排版', '使用 Tectonic 或 TeX Live 编译 LaTeX'],
  cloudflare: ['Cloudflare 平台', '使用官方工具开发和管理 Cloudflare 服务'],
  'build-web-apps': ['网页应用开发', '开发前端网页应用、生成素材并进行浏览器测试'],
  'build-web-data-visualization': ['网页数据可视化', '设计、开发、测试并导出网页数据可视化'],
  render: ['Render 部署平台', '在 Render 上部署、调试、监控和迁移应用'],
  'mixpanel-headless': ['Mixpanel 数据分析', '使用 Python 分析 Mixpanel 产品数据'],
  github: ['GitHub 协作', '处理 PR、Issue、CI 和代码发布流程'],
}

const SKILL_TRANSLATIONS = {
  'agently-mail': ['邮件管理', '发送、回复、转发、搜索邮件并管理附件和收件箱'],
  'artifact-template-resume-cn': ['电子信息工程中文简历', '使用中文简历模板创建电子信息工程方向简历'],
  'build-web-apps:frontend-app-builder': ['前端应用设计与开发', '根据高质量视觉方案开发完整前端应用'],
  'build-web-apps:frontend-testing-debugging': ['前端测试与调试', '通过浏览器测试流程调试和验证前端页面'],
  'build-web-apps:react-best-practices': ['React 最佳实践', '应用 React 与 Next.js 性能优化规范'],
  'build-web-apps:shadcn': ['shadcn/ui 组件管理', '添加、查找、修复、调试和组合 shadcn/ui 组件'],
  'build-web-apps:stripe-best-practices': ['Stripe 集成指南', '指导 Stripe 支付集成、迁移和架构选择'],
  'build-web-apps:supabase-postgres-best-practices': ['Supabase PostgreSQL 优化', '优化 PostgreSQL 查询、表结构和数据库配置'],
  'build-web-data-visualization:accessibility-and-inclusive-visualization': ['无障碍数据可视化', '让数据可视化更易访问并兼顾不同用户'],
  'build-web-data-visualization:canvas2d-data-visualization': ['Canvas 2D 数据可视化', '使用 Canvas 2D 渲染数据可视化'],
  'build-web-data-visualization:d3-data-visualization': ['D3 数据可视化', '使用 D3 开发自定义数据可视化'],
  'build-web-data-visualization:dashboards-and-real-time-visualization': ['仪表盘与实时可视化', '设计仪表盘和实时数据可视化系统'],
  'build-web-data-visualization:data-visualization': ['数据可视化任务路由', '为数据可视化需求选择合适的专业技能'],
  'build-web-data-visualization:gantt-chart-visualization': ['甘特图可视化', '设计并实现甘特图和日程可视化'],
  'build-web-data-visualization:geospatial-and-cartographic-visualization': ['地理与地图可视化', '设计地理空间和地图类数据可视化'],
  'build-web-data-visualization:grammar-of-graphics-and-declarative-visualization': ['图形语法与声明式可视化', '使用声明式图形语法开发数据可视化'],
  'build-web-data-visualization:node-link-and-diagram-layout': ['节点关系图布局', '为节点关系图选择和实现合适的布局策略'],
  'build-web-data-visualization:react-and-nextjs-data-visualization': ['React 数据可视化', '在 React 和 Next.js 应用中集成数据可视化'],
  'build-web-data-visualization:reports-pdfs-and-slide-automation': ['报告、PDF 与幻灯片自动化', '排版并导出包含丰富数据的报告和文档'],
  'build-web-data-visualization:scrollytelling-and-parallax-data-visualization': ['滚动叙事与视差可视化', '设计滚动叙事和视差效果数据可视化'],
  'build-web-data-visualization:statistical-and-uncertainty-visualization': ['统计与不确定性可视化', '设计准确表达统计结果和不确定性的图表'],
  'build-web-data-visualization:testing-data-visualizations': ['数据可视化测试', '测试数据可视化和仪表盘的正确性'],
  'build-web-data-visualization:threejs-data-visualization': ['Three.js 与 WebGL 可视化', '使用 WebGL 加速渲染数据可视化'],
  'build-web-data-visualization:typescript-data-visualization-engineering': ['TypeScript 可视化工程', '使用 TypeScript 开发类型安全的数据可视化'],
  'build-web-data-visualization:uml-and-software-architecture-visualization': ['UML 与软件架构图', '设计并实现 UML 和软件架构图'],
  'build-web-data-visualization:visualization-strategy-and-critique': ['可视化策略与评审', '选择、布局、评审并解释数据可视化方案'],
  'chrome:control-chrome': ['Chrome 浏览器控制', '控制浏览器标签页、登录会话和扩展等现有状态'],
  'cloudflare:agents-sdk': ['Cloudflare 智能体 SDK', '在 Cloudflare Workers 上开发有状态智能体'],
  'cloudflare:building-ai-agent-on-cloudflare': ['构建 Cloudflare AI 智能体', '在 Cloudflare Workers 上开发有状态 AI 智能体'],
  'cloudflare:building-mcp-server-on-cloudflare': ['构建 Cloudflare MCP 服务', '在 Cloudflare Workers 上开发远程 MCP 服务'],
  'cloudflare:cloudflare': ['Cloudflare 产品导航', '为需求选择合适的 Cloudflare 产品和工作流'],
  'cloudflare:durable-objects': ['Durable Objects', '在 Cloudflare Workers 上开发有状态协调服务'],
  'cloudflare:sandbox-sdk': ['沙箱 SDK', '开发安全隔离的代码执行环境'],
  'cloudflare:web-perf': ['网页性能分析', '使用 Chrome DevTools 工具审计页面性能'],
  'cloudflare:workers-best-practices': ['Workers 最佳实践', '编写和评审生产级 Cloudflare Workers 代码'],
  'cloudflare:wrangler': ['Wrangler 命令行工具', '安全使用 Cloudflare Workers 命令行工具'],
  'computer-use:computer-use': ['Windows 电脑操作', '控制 Windows 桌面应用'],
  'develop-web-game': ['网页游戏开发', '开发网页游戏并使用 Playwright 进行交互测试'],
  'documents:documents': ['Word 与在线文档', '创建和编辑 Word、Google Docs 文档'],
  'frontend-skill': ['前端视觉设计', '设计高质量落地页、网站、应用和界面'],
  'github:gh-address-comments': ['处理代码评审意见', '处理 Pull Request 中可执行的评审反馈'],
  'github:gh-fix-ci': ['GitHub CI 调试', '调试失败的 GitHub Actions 检查'],
  'github:github': ['GitHub 项目检查', '检查 PR、Issue、CI 和发布流程'],
  'github:yeet': ['发布代码变更', '提交、推送代码并创建 Pull Request'],
  'latex:latex-compile': ['编译 LaTeX 项目', '优先使用 Tectonic，并按需回退到 TeX Live 或 MacTeX'],
  'latex:latex-doctor': ['LaTeX 环境诊断', '检测 LaTeX 工具、报告缺失组件并运行编译测试'],
  'latex:texlive-runtime-installer': ['TeX Live 运行时安装', '检测现有环境，并在需要时安装 Codex 管理的 TeX Live'],
  'mixpanel-headless:dashboard-expert': ['Mixpanel 仪表盘专家', '创建、读取、分析和管理 Mixpanel 仪表盘'],
  'mixpanel-headless:mixpanel-auth': ['Mixpanel 账号认证', '管理 Mixpanel 登录、账号、项目和工作区'],
  'mixpanel-headless:mixpanel-headless-setup': ['Mixpanel 分析环境配置', '安装分析依赖并验证 Mixpanel 服务账号或 OAuth 凭据'],
  'mixpanel-headless:mixpanelyst': ['Mixpanel 产品数据分析', '分析漏斗、留存、分群、用户路径和产品指标'],
  pdf: ['PDF 编辑与评审', '创建、编辑和检查 PDF 文件'],
  'pdf:pdf': ['PDF 读取与生成', '读取、创建、渲染并校验 PDF 文件'],
  playwright: ['浏览器自动化', '通过命令行自动控制真实浏览器'],
  'playwright-trace': ['Playwright 跟踪分析', '检查 Playwright 跟踪中的操作、请求、日志和截图'],
  'presentations:Presentations': ['演示文稿制作', '创建精美的 PowerPoint 和 Google Slides 演示文稿'],
  'render:render-background-workers': ['Render 后台工作进程', '配置处理队列任务的 Render 后台工作进程'],
  'render:render-blueprints': ['Render 蓝图配置', '编写并校验 Render Blueprint YAML'],
  'render:render-cli': ['Render 命令行工具', '安装并使用 Render CLI 执行部署、日志和 SSH 操作'],
  'render:render-cron-jobs': ['Render 定时任务', '配置并排查 Render 定时任务'],
  'render:render-debug': ['Render 部署调试', '根据状态和日志诊断 Render 部署失败'],
  'render:render-deploy': ['部署到 Render', '从代码仓库准备并校验 Render 部署'],
  'render:render-disks': ['Render 持久磁盘', '挂载并管理 Render 服务的持久磁盘'],
  'render:render-docker': ['Render Docker 部署', '在 Render 上构建和部署 Docker 容器'],
  'render:render-domains': ['Render 域名与 TLS', '配置 Render 自定义域名和 TLS 证书'],
  'render:render-env-vars': ['Render 环境变量', '配置 Render 环境变量、密钥和变量组'],
  'render:render-keyvalue': ['Render 键值数据库', '创建和配置 Render Key Value 实例'],
  'render:render-mcp': ['Render MCP 配置', '连接并配置 Render MCP 服务'],
  'render:render-migrate-from-heroku': ['从 Heroku 迁移到 Render', '将 Heroku 应用映射到合适的 Render 服务'],
  'render:render-monitor': ['Render 服务监控', '检查 Render 服务健康、部署状态和日志'],
  'render:render-networking': ['Render 私有网络', '通过私有网络连接 Render 服务'],
  'render:render-postgres': ['Render PostgreSQL', '创建并优化 Render 托管 PostgreSQL'],
  'render:render-private-services': ['Render 私有服务', '配置仅内部访问的 Render 私有服务'],
  'render:render-scaling': ['Render 服务扩缩容', '扩缩 Render 服务并选择合适的实例类型'],
  'render:render-static-sites': ['Render 静态网站', '部署并配置 Render 静态网站'],
  'render:render-web-services': ['Render Web 服务', '配置 Render Web 服务和健康检查'],
  'render:render-workflows': ['Render 工作流', '创建并校验 Render Workflows 项目'],
  'spreadsheets:Spreadsheets': ['电子表格制作', '创建和编辑 Excel 或 Google Sheets 可用文件'],
  'spreadsheets:excel-live-control': ['Excel 实时控制', '控制当前打开的 Microsoft Excel 工作簿'],
  'template-creator:template-creator': ['个人模板创建器', '创建或更新个人文档、表格和演示文稿模板'],
  'vps-deploy-yanwu': ['烟雾项目 VPS 部署', '处理烟雾项目上传、部署、数据保护和服务器故障排查'],
  imagegen: ['图像生成', '为网站、游戏等场景生成或编辑图片'],
  'openai-docs': ['OpenAI 官方文档', '查询 OpenAI、Codex 和模型迁移相关官方资料'],
  'plugin-creator': ['插件创建器', '创建插件目录和市场条目'],
  'skill-creator': ['技能创建器', '创建或更新 Codex 技能'],
  'skill-installer': ['技能安装器', '从官方列表或其他代码仓库安装技能'],
}

function localize(source, translations, fallbackDescription) {
  const translation = translations[source.name]
  const originalTitle = source.displayName || source.name || ''
  const originalDescription = source.description || ''
  return {
    title: translation?.[0] || originalTitle,
    description: translation?.[1] || originalDescription || fallbackDescription,
    originalTitle,
    originalDescription,
  }
}

export function localizePlugin(plugin) {
  return localize(plugin, PLUGIN_TRANSLATIONS, '本机已安装并启用')
}

export function localizeSkill(skill) {
  return localize(skill, SKILL_TRANSLATIONS, '本机可用技能')
}

export function capabilitySearchText(source, localized) {
  return [
    localized.title,
    localized.description,
    localized.originalTitle,
    localized.originalDescription,
    source.name,
    source.id,
    ...(source.skillNames || []),
  ].filter(Boolean).join(' ').toLowerCase()
}

export function localizeScope(scope) {
  if (scope === 'system') return '系统技能'
  if (scope === 'user') return '用户技能'
  return scope || ''
}
