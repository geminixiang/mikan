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
      pagination: true,
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Overview", link: "/" },
            { label: "Configuration", link: "/configuration/" },
            { label: "Commands", link: "/commands/" },
            { label: "Development", link: "/development/" },
          ],
        },
        {
          label: "Runtime",
          items: [
            { label: "Architecture", link: "/architecture/" },
            { label: "Sessions", link: "/sessions/" },
            { label: "Sandbox", link: "/sandbox/" },
            { label: "Events", link: "/events/" },
            { label: "Skills", link: "/skills/" },
          ],
        },
        {
          label: "Setup",
          items: [
            { label: "Deployment", link: "/deployment/" },
            { label: "Slack Bot Setup", link: "/slack-bot-minimal-guide/" },
            { label: "Slack QA Test Plan", link: "/slack-qa-test-plan/" },
            { label: "Firecracker Setup", link: "/firecracker-setup/" },
            { label: "Portal Auth Model", link: "/portal-auth-model/" },
          ],
        },
        {
          label: "OAuth",
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
