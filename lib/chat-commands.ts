export type ChatCommandCategory = 'Session' | 'Workspace' | 'Work' | 'Git' | 'Research' | 'Memory' | 'Publish';

export interface ChatCommandDefinition {
  id: string;
  syntax: string;
  insert: string;
  description: string;
  category: ChatCommandCategory;
  aliases?: string[];
}

/** One catalog drives composer autocomplete, in-chat /help, tests, and docs. */
export const CHAT_COMMANDS: ChatCommandDefinition[] = [
  { id: 'help', syntax: '/help', insert: '/help', description: 'Show the complete command reference', category: 'Session', aliases: ['/commands', '/'] },
  { id: 'clear', syntax: '/clear', insert: '/clear', description: 'Clear this conversation after confirmation', category: 'Session' },
  { id: 'agent', syntax: '/agent <name|grok|all>', insert: '/agent ', description: 'Switch who answers this chat', category: 'Session' },
  { id: 'model', syntax: '/model <name>', insert: '/model ', description: 'Switch the session model', category: 'Session' },
  { id: 'tools', syntax: '/tools on|off', insert: '/tools ', description: 'Enable or disable automatic tool calls for this chat', category: 'Session' },
  { id: 'project', syntax: '/project <name|off>', insert: '/project ', description: 'Link or unlink a project context', category: 'Session' },

  { id: 'workspace', syntax: '/workspace [path|off]', insert: '/workspace ', description: 'Bind, pick, or detach a workspace folder', category: 'Workspace' },
  { id: 'annotate', syntax: '/annotate', insert: '/annotate', description: 'Open the visual annotation sub-browser', category: 'Workspace' },

  { id: 'task', syntax: '/task <title> | <description>', insert: '/task ', description: 'Create a card on the shared Board', category: 'Work' },
  { id: 'board', syntax: '/board [status|query]', insert: '/board ', description: 'List and filter Board cards', category: 'Work' },

  { id: 'git-status', syntax: '/git status', insert: '/git status', description: 'Branch, changed files, and recent commits', category: 'Git' },
  { id: 'git-diff', syntax: '/git diff [--staged]', insert: '/git diff', description: 'Show the current workspace diff', category: 'Git' },
  { id: 'git-log', syntax: '/git log [count]', insert: '/git log ', description: 'Show up to 50 recent commits', category: 'Git' },
  { id: 'git-checkout', syntax: '/git checkout <branch>', insert: '/git checkout ', description: 'Switch to a branch, or create it', category: 'Git' },
  { id: 'git-commit', syntax: '/git commit <message>', insert: '/git commit ', description: 'Stage all changes and commit', category: 'Git' },
  { id: 'git-pull', syntax: '/git pull', insert: '/git pull', description: 'Fast-forward the current branch', category: 'Git' },
  { id: 'git-push', syntax: '/git push', insert: '/git push', description: 'Push the current branch to origin', category: 'Git' },
  { id: 'git-pr', syntax: '/git pr <title> | <body>', insert: '/git pr ', description: 'Push and open a GitHub pull request', category: 'Git' },

  { id: 'search', syntax: '/search <query>', insert: '/search ', description: 'Search the web and bring results into chat', category: 'Research' },
  { id: 'fetch', syntax: '/fetch <url>', insert: '/fetch ', description: 'Read a web page as clean text', category: 'Research' },

  { id: 'remember', syntax: '/remember <key> | <content>', insert: '/remember ', description: 'Save memory for this chat target', category: 'Memory' },
  { id: 'recall', syntax: '/recall [keyword]', insert: '/recall ', description: 'Recall matching active memories', category: 'Memory' },
  { id: 'forget', syntax: '/forget <key>', insert: '/forget ', description: 'Delete one memory by exact key', category: 'Memory' },
  { id: 'memories', syntax: '/memories', insert: '/memories', description: 'Open the full memory manager', category: 'Memory', aliases: ['/memory'] },

  { id: 'note', syntax: '/note <path> | <content>', insert: '/note ', description: 'Create an Obsidian note', category: 'Publish' },
  { id: 'x', syntax: '/x <text>', insert: '/x ', description: 'Post to X through the configured integration', category: 'Publish' },
];

const CATEGORY_ORDER: ChatCommandCategory[] = ['Session', 'Workspace', 'Work', 'Git', 'Research', 'Memory', 'Publish'];

export function slashCommandMatches(input: string): ChatCommandDefinition[] {
  const typed = input.trimStart().toLowerCase();
  if (!typed.startsWith('/') || typed.includes('\n')) return [];
  const directMatches = CHAT_COMMANDS.filter((command) => {
    const candidates = [command.syntax, command.insert, ...(command.aliases || [])].map((value) => value.toLowerCase());
    return candidates.some((candidate) => candidate.startsWith(typed));
  });
  // Exact command/alias prefixes must outrank fuzzy description matches. For
  // example, `/memories` should never select `/recall` merely because its
  // description contains the word "memories".
  if (directMatches.length > 0) return directMatches;
  if (typed.includes(' ')) return [];
  const query = typed.slice(1);
  return CHAT_COMMANDS.filter((command) =>
    [command.description, command.category, command.id].join(' ').toLowerCase().includes(query),
  );
}

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed === '/') return { name: 'help', args: '' };
  const firstSpace = trimmed.search(/\s/);
  const token = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace).trim();
  const direct = CHAT_COMMANDS.find((command) => `/${command.id}` === token || command.aliases?.some((alias) => alias === token));
  if (direct) return { name: direct.id, args };
  // Families whose catalog ids describe subcommands are dispatched by their
  // first token. Exact token matching avoids /searching being treated as /search.
  if (token === '/git') return { name: 'git', args };
  return null;
}

export function renderChatCommandHelp(contextLine?: string): string {
  const lines = ['## Chat commands', '', 'Type `/` for autocomplete. Commands act immediately and write their result into the conversation.'];
  for (const category of CATEGORY_ORDER) {
    const commands = CHAT_COMMANDS.filter((command) => command.category === category);
    lines.push('', `### ${category}`, '', '| Command | What it does |', '| --- | --- |');
    for (const command of commands) {
      lines.push(`| \`${command.syntax.replace(/\|/g, '\\|')}\` | ${command.description} |`);
    }
  }
  if (contextLine) lines.push('', `_${contextLine}_`);
  return lines.join('\n');
}
