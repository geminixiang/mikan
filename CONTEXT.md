# Context

## Domain terms

- **Conversation intake**: The platform-message entry flow that decides whether an incoming chat message should start an agent run. It includes trigger/auto-reply policy, attachment preparation, conversation log writing, queue selection, and dispatch to the runtime handler.
- **Magic word**: A highest-priority chat control phrase that bypasses normal trigger policy and queueing rules, such as `stop`. Magic words should stay rare and narrowly scoped because they override normal conversation intake behavior.
- **Bare command**: A command phrase accepted without a leading slash. Bare commands should be limited to `session`; other commands require slash form to avoid accidental activation. `stop` is not treated as a normal bare command because it is a magic word.
- **Slash command**: A minimal chat control for essential, frequently needed actions. Slash commands are not a complete configuration surface and should not mirror every Admin capability.
- **Admin**: The complete operator-facing configuration surface. Detailed or infrequent settings belong in Admin rather than slash commands.
- **Platform Adapter**: Slack, Discord, or Telegram code that translates platform SDK events into mikan conversation events and provides platform-specific response operations.
- **Session key**: The conversation-scoped runtime identity used to serialize and resume work for a direct message, shared channel, or thread.
