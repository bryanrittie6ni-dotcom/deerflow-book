import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'DeerFlow 源码解析',
  description: 'ByteDance 开源 Super Agent Harness 深度解析',
  lang: 'zh-CN',

  base: '/',
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#8B5CF6' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'DeerFlow 源码解析' }],
    ['meta', { property: 'og:description', content: 'ByteDance 开源 Super Agent Harness 深度解析' }],
  ],

  themeConfig: {
    logo: { src: '/logo.svg', alt: 'DeerFlow' },

    nav: [
      { text: '开始阅读', link: '/chapters/01-what-is-deerflow' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/deerflow-book' },
    ],

    sidebar: [
      {
        text: '前言',
        items: [
          { text: '关于本书', link: '/' },
          { text: '完整目录', link: '/contents' },
        ],
      },
      {
        text: '第一部分：宏观认知',
        collapsed: false,
        items: [
          { text: '第 1 章　DeerFlow 是什么，为什么重要', link: '/chapters/01-what-is-deerflow' },
          { text: '第 2 章　仓库全景与技术栈', link: '/chapters/02-repo-overview' },
          { text: '第 3 章　快速上手', link: '/chapters/03-quick-start' },
        ],
      },
      {
        text: '第二部分：Skills 体系',
        collapsed: false,
        items: [
          { text: '第 4 章　Skills 系统：能力的核心扩展单元', link: '/chapters/04-skills-system' },
          { text: '第 5 章　编写自定义 Skill', link: '/chapters/05-custom-skills' },
        ],
      },
      {
        text: '第三部分：Lead Agent 与中间件管道',
        collapsed: false,
        items: [
          { text: '第 6 章　Lead Agent：大脑的核心循环', link: '/chapters/06-lead-agent' },
          { text: '第 7 章　11 层中间件管道', link: '/chapters/07-middleware-pipeline' },
          { text: '第 8 章　Context Engineering', link: '/chapters/08-context-engineering' },
        ],
      },
      {
        text: '第四部分：Sub-Agent 系统',
        collapsed: false,
        items: [
          { text: '第 9 章　Sub-Agent 架构总览', link: '/chapters/09-subagent-overview' },
          { text: '第 10 章　SubagentExecutor 执行引擎', link: '/chapters/10-subagent-executor' },
          { text: '第 11 章　并发调度与 Orchestration', link: '/chapters/11-orchestration' },
        ],
      },
      {
        text: '第五部分：记忆系统',
        collapsed: false,
        items: [
          { text: '第 12 章　长期记忆架构', link: '/chapters/12-memory-architecture' },
          { text: '第 13 章　记忆更新流水线', link: '/chapters/13-memory-pipeline' },
        ],
      },
      {
        text: '第六部分：沙箱与执行环境',
        collapsed: false,
        items: [
          { text: '第 14 章　Sandbox 抽象层', link: '/chapters/14-sandbox-abstraction' },
          { text: '第 15 章　Local Sandbox 与 aio-sandbox', link: '/chapters/15-sandbox-implementations' },
        ],
      },
      {
        text: '第七部分：工具生态与 MCP',
        collapsed: false,
        items: [
          { text: '第 16 章　内置工具与社区工具', link: '/chapters/16-builtin-tools' },
          { text: '第 17 章　MCP 扩展：无限工具', link: '/chapters/17-mcp-extensions' },
        ],
      },
      {
        text: '第八部分：通信层与 Gateway',
        collapsed: false,
        items: [
          { text: '第 18 章　FastAPI Gateway', link: '/chapters/18-fastapi-gateway' },
          { text: '第 19 章　IM 渠道系统', link: '/chapters/19-im-channels' },
        ],
      },
      {
        text: '第九部分：配置与生产化',
        collapsed: false,
        items: [
          { text: '第 20 章　配置体系全解', link: '/chapters/20-config-system' },
          { text: '第 21 章　模型配置与适配', link: '/chapters/21-model-config' },
          { text: '第 22 章　部署与生产化', link: '/chapters/22-deployment' },
        ],
      },
      {
        text: '附录',
        collapsed: true,
        items: [
          { text: '附录 A：阅读路径指南', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：配置字段速查表', link: '/chapters/appendix-b-config-reference' },
          { text: '附录 C：术语表', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coolclaws/deerflow-book' },
    ],

    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2025-present',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
