import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import mikanTheme, { mikanAgentMarkdown, mikanCodeTheme } from "starlight-theme-mikan";
import { defineConfig } from "astro/config";
import remarkGfm from "remark-gfm";

export default defineConfig({
  site: "https://geminixiang.github.io/",
  devToolbar: { enabled: false },
  outDir: "./site-dist",
  integrations: [
    starlight({
      title: "mikan",
      description: "Multi-platform AI coding agent for Slack, Telegram, and Discord.",
      locales: {
        root: { label: "English", lang: "en" },
        "zh-tw": { label: "繁體中文", lang: "zh-TW" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
        ja: { label: "日本語", lang: "ja" },
      },
      defaultLocale: "root",
      pagination: true,
      sidebar: [
        {
          label: "Start",
          translations: { "zh-TW": "開始", "zh-CN": "开始", ja: "はじめに" },
          items: [
            {
              label: "Overview",
              translations: { "zh-TW": "總覽", "zh-CN": "总览", ja: "概要" },
              link: "/",
            },
            {
              label: "Configuration",
              translations: { "zh-TW": "設定", "zh-CN": "配置", ja: "設定" },
              link: "/configuration/",
            },
            {
              label: "Commands",
              translations: { "zh-TW": "指令", "zh-CN": "命令", ja: "コマンド" },
              link: "/commands/",
            },
            {
              label: "Development",
              translations: { "zh-TW": "開發", "zh-CN": "开发", ja: "開発" },
              link: "/development/",
            },
          ],
        },
        {
          label: "Runtime",
          translations: { "zh-TW": "執行階段", "zh-CN": "运行时", ja: "ランタイム" },
          items: [
            {
              label: "Architecture",
              translations: { "zh-TW": "架構", "zh-CN": "架构", ja: "アーキテクチャ" },
              link: "/architecture/",
            },
            {
              label: "Sessions",
              translations: { "zh-TW": "工作階段", "zh-CN": "会话", ja: "セッション" },
              link: "/sessions/",
            },
            {
              label: "Sandbox",
              translations: { "zh-TW": "沙盒", "zh-CN": "沙盒", ja: "サンドボックス" },
              items: [
                {
                  label: "Overview",
                  translations: { "zh-TW": "總覽", "zh-CN": "总览", ja: "概要" },
                  link: "/sandbox/",
                },
                {
                  label: "Vault",
                  translations: { "zh-TW": "Vault", "zh-CN": "Vault", ja: "Vault" },
                  link: "/sandbox/vault/",
                },
              ],
            },
            {
              label: "Events",
              translations: { "zh-TW": "事件", "zh-CN": "事件", ja: "イベント" },
              link: "/events/",
            },
            {
              label: "Skills",
              translations: { "zh-TW": "技能", "zh-CN": "技能", ja: "スキル" },
              link: "/skills/",
            },
          ],
        },
        {
          label: "Setup",
          translations: { "zh-TW": "設定指南", "zh-CN": "设置指南", ja: "セットアップ" },
          items: [
            {
              label: "Deployment",
              translations: { "zh-TW": "部署", "zh-CN": "部署", ja: "デプロイ" },
              link: "/deployment/",
            },
            {
              label: "Slack Bot Setup",
              translations: {
                "zh-TW": "Slack Bot 設定",
                "zh-CN": "Slack Bot 设置",
                ja: "Slack Bot セットアップ",
              },
              link: "/slack-bot-minimal-guide/",
            },
            {
              label: "Slack QA Test Plan",
              translations: {
                "zh-TW": "Slack QA 測試計畫",
                "zh-CN": "Slack QA 测试计划",
                ja: "Slack QA テスト計画",
              },
              link: "/slack-qa-test-plan/",
            },
            {
              label: "Firecracker Setup",
              translations: {
                "zh-TW": "Firecracker 設定",
                "zh-CN": "Firecracker 设置",
                ja: "Firecracker セットアップ",
              },
              link: "/firecracker-setup/",
            },
            {
              label: "Portal Auth Model",
              translations: {
                "zh-TW": "Portal 驗證模型",
                "zh-CN": "Portal 认证模型",
                ja: "Portal 認証モデル",
              },
              link: "/portal-auth-model/",
            },
          ],
        },
        {
          label: "OAuth",
          translations: { "zh-TW": "OAuth", "zh-CN": "OAuth", ja: "OAuth" },
          items: [{ autogenerate: { directory: "oauth" } }],
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/geminixiang/mikan",
        },
      ],
      plugins: [mikanTheme(), mikanAgentMarkdown()],
    }),
    mdx(),
  ],
  markdown: {
    remarkPlugins: [remarkGfm],
    shikiConfig: {
      theme: mikanCodeTheme,
    },
  },
});
