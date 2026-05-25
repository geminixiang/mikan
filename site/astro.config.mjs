import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://geminixiang.github.io/mikan",
  integrations: [
    starlight({
      title: "mikan",
      description: "A multi-platform AI coding agent for Slack, Telegram, and Discord.",
      logo: {
        src: "./src/assets/mikan-logo.svg",
        replacesTitle: false,
      },
      customCss: ["./src/styles/mikan.css"],
      social: {
        github: "https://github.com/geminixiang/mikan",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Overview", link: "/" },
            { label: "Installation", link: "/install/" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", link: "/architecture/" },
            { label: "Sessions", link: "/sessions/" },
            { label: "Sandbox & Vault", link: "/sandbox/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Chat Commands", link: "/commands/" },
            { label: "Configuration", link: "/configuration/" },
            { label: "Events", link: "/events/" },
            { label: "Skills", link: "/skills/" },
          ],
        },
        {
          label: "Platforms",
          items: [
            { label: "Slack Bot Setup", link: "/slack-bot-minimal-guide/" },
            { label: "Slack QA Test Plan", link: "/slack-qa-test-plan/" },
          ],
        },
        {
          label: "OAuth providers",
          items: [
            { label: "GitHub", link: "/oauth/github/" },
            { label: "Google Cloud SDK", link: "/oauth/google-cloud-sdk/" },
            { label: "Google Workspace", link: "/oauth/google-workspace/" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Deployment", link: "/deployment/" },
            { label: "Development", link: "/development/" },
            { label: "Firecracker Setup", link: "/firecracker-setup/" },
          ],
        },
      ],
    }),
  ],
});
