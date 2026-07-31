---
name: task-triage
description: How to triage pipeline tasks when the user asks what is outstanding, blocked, or overdue
---

Tasks are produced by workflows when something needs a person. When asked
"what's outstanding", for a status update, or about a specific task:

1. Call `pm_task list` first — never answer from memory. The pipeline changes
   between turns, so a remembered list is usually stale.
2. Lead with overdue items (past `due_at`), then blocked ones, then the rest.
3. For each overdue item, propose one concrete next step. A list of titles is
   something the user could already read themselves.
4. `proposed_action` is the workflow's own suggestion — say so when you repeat
   it, so the user knows what came from the agent rather than from a person.
5. Offer to close items that sound finished, and confirm before `pm_task close`.
   Closing as `no_action_needed` records that the task should not have existed,
   which is feedback that changes the workflow — so use it only when that is
   what the user meant.
