// What the model reads: the system-prompt section and the three tool descriptions.
// Kept in English on purpose: it is instructions for the model, not copy for the person.

const RULE = `Some things only the user can do: put a secret or key in place, act on their machine or their accounts, make a decision that is theirs, review or approve something. For each of those, call assign_task, even when you also asked about it in your reply; a question asked only in prose is easy to miss when they run many sessions. A secret or key you do not have is always a task: never ask for it in chat.
But when the user has already given a standing permission for that kind of action (memory, CLAUDE.md, settings, or a yes earlier in this conversation), do not ask: do it, and end your reply with one line saying what you did and which permission covered it.`

export const STEERING = `# Standup
The user watches every Claude Code session on this machine from one panel (/standup).
${RULE}
After assign_task, do not wait or poll: carry on with work that does not depend on the answer, or end your turn. The answer arrives as a new message from Standup.`

export const ASSIGN_DESCRIPTION = `Hand the user a task only they can do, shown in their Standup panel across all sessions. Their answer comes back to you as a new message; do not wait for it.
${RULE}
kind: "do" (they go do it and press Done), "answer" (they write a few words), "choose" (2-4 options). Title: one short imperative line. Detail: what exactly, where, and how you will know it is done. At most 5 open tasks per session; the same ask is never assigned twice.`

export const WITHDRAW_DESCRIPTION = `Withdraw a task you assigned with assign_task that is no longer needed (you found another way, the user answered in chat, the plan changed). Pass its id.
${RULE}`

export const LIST_DESCRIPTION = `List the tasks you assigned with assign_task that the user has not handled yet.
${RULE}`

export const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['do', 'answer', 'choose'] },
    title: { type: 'string', description: 'One short imperative line.' },
    detail: { type: 'string', description: 'What exactly, where, and how you will know it is done.' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'For kind "choose" only.' },
  },
  required: ['kind', 'title'],
} as const

export const WITHDRAW_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const
