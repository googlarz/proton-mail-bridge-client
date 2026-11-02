// Ready-made workflows the client can offer as menu items (MCP prompts). Each one is only an instruction to the
// assistant, naming the tools to use; it changes nothing by itself, and every one tells the assistant to ask before
// it sends or changes anything.

import { isToolListed } from "../tools/definitions.js";

export interface MailPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface MailPrompt {
  name: string;
  title: string;
  description: string;
  arguments?: MailPromptArgument[];
  /** The tools this workflow names; a test keeps this list and the tool list in step. */
  tools: string[];
  render(args: Record<string, string>): string;
}

const ASK_FIRST = "Do not send anything or change the mailbox without asking me first.";

export const MAIL_PROMPTS: MailPrompt[] = [
  {
    name: "morning-brief",
    title: "Morning brief",
    description: "What needs you today: unread, who is waiting on you, and what you are waiting on.",
    tools: ["get_inbox_digest", "get_follow_up_candidates"],
    render: () =>
      `Give me a short brief of my mail. Use get_inbox_digest for what is unread and what is waiting on me, and ` +
      `get_follow_up_candidates for what I sent that nobody answered. Group it as: (1) needs me today, (2) can wait, ` +
      `(3) I am waiting on others. One line per thread, with the sender and why it matters. ${ASK_FIRST}`,
  },
  {
    name: "who-is-waiting-on-me",
    title: "Who is waiting on me",
    description: "Threads where the last word was theirs and a reply is due.",
    arguments: [{ name: "account", description: "Only this account (address or slug). Default: all." }],
    tools: ["get_actionable_threads", "get_thread_brief"],
    render: (args) =>
      `List the threads where someone is waiting for my reply${args.account ? ` in the account ${args.account}` : ""}, ` +
      `oldest first, using get_actionable_threads. For the five most urgent, use get_thread_brief and say in one ` +
      `sentence what they want from me. ${ASK_FIRST}`,
  },
  {
    name: "waiting-on-others",
    title: "Waiting on others",
    description: "Mail you sent that nobody answered, with a nudge or a reminder for each.",
    tools: ["get_follow_up_candidates", "set_reply_reminder", "list_reply_reminders"],
    render: () =>
      `Find the mail I sent that nobody has answered, using get_follow_up_candidates, and skip the ones that already ` +
      `have a reminder (list_reply_reminders). For each, say how long it has waited and suggest either a short nudge ` +
      `(as a draft, not sent) or a reminder date (set_reply_reminder). Show me the list first; set no reminder until ` +
      `I pick. ${ASK_FIRST}`,
  },
  {
    name: "prepare-for-meeting",
    title: "Prepare for a meeting",
    description: "Recent history with a person or a company before you talk to them.",
    arguments: [{ name: "who", description: "A person's name or e-mail, or a domain such as example.com.", required: true }],
    tools: ["prepare_meeting_context"],
    render: (args) =>
      `I am about to talk to ${args.who}. Use prepare_meeting_context to find our recent threads and summarise: ` +
      `what we last discussed, what is still open on each side, and anything with a date. Keep it to what I can read ` +
      `in a minute. ${ASK_FIRST}`,
  },
  {
    name: "answer-invitations",
    title: "Answer calendar invitations",
    description: "Find invitations you have not answered and propose accept, tentative or decline.",
    tools: ["search_emails", "respond_to_invite"],
    render: () =>
      `Find calendar invitations in my inbox that I have not answered, using search_emails with an attachment filter ` +
      `for .ics files. For each, give the title, the time and the organizer, and propose accept, tentative or ` +
      `decline with a reason. Use respond_to_invite with dryRun first so I see the reply; send nothing until I say ` +
      `which ones. ${ASK_FIRST}`,
  },
  {
    name: "clean-up-newsletters",
    title: "Clean up newsletters",
    description: "The senders that fill your inbox, and which you could unsubscribe from.",
    tools: ["top_senders", "get_unsubscribe_info"],
    render: () =>
      `Use top_senders to find who sends me the most mail, and get_unsubscribe_info to see which of them offer an ` +
      `unsubscribe link. Show me a table (sender, how many in the last 90 days, can unsubscribe). Unsubscribe from ` +
      `none until I name them. ${ASK_FIRST}`,
  },
  {
    name: "draft-replies",
    title: "Draft replies",
    description: "Drafts for the threads waiting on you. Nothing is sent.",
    arguments: [{ name: "count", description: "How many threads (default 3)." }],
    tools: ["get_actionable_threads", "create_reply_draft"],
    render: (args) =>
      `Take the ${args.count?.trim() || "3"} most urgent threads waiting on me (get_actionable_threads) and write a ` +
      `reply draft for each with create_reply_draft, in my voice and as short as the thread allows. Save them as ` +
      `drafts only and list them so I can review. ${ASK_FIRST}`,
  },
];

/** The prompts whose tools the active profile (PROTONMAIL_TOOLSET) lists, so no prompt tells the model to call a refused tool. */
export function listedPrompts(): MailPrompt[] {
  return MAIL_PROMPTS.filter((prompt) => prompt.tools.every((tool) => isToolListed(tool)));
}
