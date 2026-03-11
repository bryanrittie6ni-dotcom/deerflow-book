---
layout: home

hero:
  name: "DeerFlow 源码解析"
  text: "ByteDance 开源 Super Agent Harness"
  tagline: 从 Skills 体系到 Sub-Agent 调度，从中间件管道到沙箱执行，全面解读 DeerFlow 2.0 的架构设计与实现细节
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-what-is-deerflow
    - theme: alt
      text: 查看目录
      link: /contents
    - theme: alt
      text: GitHub
      link: https://github.com/coolclaws/deerflow-book

features:
  - icon:
      src: /icons/skills.svg
    title: Skills 体系
    details: 深入 Skill 渐进式加载机制，解析 SKILL.md 格式、内置 Skills 全景、自定义 Skill 开发，理解 DeerFlow 能力扩展的核心单元。

  - icon:
      src: /icons/subagent.svg
    title: Sub-Agent 调度
    details: 剖析 Lead Agent 与 Sub-Agent 的委托架构、双线程池执行引擎、并发限制策略，掌握多 Agent 协作的生产级实现。

  - icon:
      src: /icons/sandbox.svg
    title: 沙箱执行环境
    details: 解读 Sandbox 抽象层、虚拟路径映射、Local/Docker/K8s 三种实现，理解 Agent 如何安全地操作文件系统与执行代码。

  - icon:
      src: /icons/memory.svg
    title: 长期记忆系统
    details: 覆盖用户画像、时间线、事实库三层记忆结构，解析异步更新流水线与原子写入，让 Agent 在会话之间保持连贯记忆。
---
