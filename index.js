/**
 * Host half of the wechat-bridge bundle.
 *
 * 把「本机已登录的微信 4.x 客户端」变成一组有边界的模型工具：
 *
 *   wechat_status    体检：微信在不在、账号是谁、数据库能不能读
 *   wechat_sessions  最近会话（含未读数）
 *   wechat_messages  某个会话的最近消息
 *   wechat_search    按名字找联系人或群，拿到 username
 *   wechat_inbox     上次之后的新消息（自动回复的入口，会推进游标）
 *   wechat_send      发一条消息（驱动真实界面）
 *
 * 真正的读写都在 `sidecar/wechat_bridge.py` 里：读走本地数据库解密，
 * 写走 UI Automation。这里只负责进程生命周期、JSON-RPC 编排和把结果
 * 投影成固定的输出形状——Sidecar 多返回字段不会破坏工具契约。
 *
 * 不 import 任何 `@deepseek-ai/*`：工作区 bundle 以链接方式安装，checkout
 * 里的包在这里解析不到。
 *
 * @module @local/dsh-wechat-bridge
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Plugin row name used for diagnostics. */
export const name = 'wechat-bridge';

/** The tool registry must exist before this plugin activates. */
export const inject = ['tools'];

/** Sidecar 默认路径（相对本模块）。 */
const DEFAULT_SCRIPT = fileURLToPath(new URL('./sidecar/wechat_bridge.py', import.meta.url));

/** 从环境变量或 PATH 里试这些解释器；第一个能跑通的就用。 */
const PYTHON_CANDIDATES = ['python', 'python3', 'py'];

/** 只读调用（解密 + 查询）的上限。首次调用要解密整库，留足余量。 */
const READ_TIMEOUT_MS = 180000;

/** 发送要走界面：热激活 UIA + 布局校准 + 输入 + 回读确认。 */
const SEND_TIMEOUT_MS = 300000;

/**
 * 常驻 sidecar：进程活着就复用，死了按需重启。
 *
 * 刻意不做并发：UI Automation 操作的是同一个窗口，两个请求交错会互相
 * 抢焦点。工具的 `isConcurrencySafe` 也返回 false，双重保险。
 */
class Sidecar {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.starting = null;
    this.stderrTail = '';
  }

  /** 懒启动；并发首调共享同一次启动。 */
  async ensure() {
    if (this.child !== null && this.child.exitCode === null) return;
    if (this.starting !== null) {
      await this.starting;
      return;
    }
    this.starting = this.#start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 依次尝试候选解释器，第一个能应答 init 的胜出。 */
  async #start() {
    const { script, dbDir, enableOcr } = this.options;
    const candidates =
      typeof this.options.python === 'string' && this.options.python.trim().length > 0
        ? [this.options.python.trim()]
        : [...(process.env.DSH_PYTHON ? [process.env.DSH_PYTHON] : []), ...PYTHON_CANDIDATES];
    const failures = [];
    for (const candidate of candidates) {
      try {
        await this.#spawnWith(candidate, script);
        await this.request('init', { dbDir, enableOcr }, 30000);
        return;
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        this.#kill();
      }
    }
    throw new Error(
      '无法启动微信 sidecar（需要 Python 3 与 wechatauto-replica）。尝试过：\n' +
        failures.join('\n'),
    );
  }

  /** 用给定解释器拉起子进程，并绑定 stdio 协议解析。 */
  #spawnWith(executable, script) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-X', 'utf8', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        this.child = child;
        this.buffer = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.#onStdout(chunk));
        child.stderr.on('data', (chunk) => {
          this.stderrTail = (this.stderrTail + chunk).slice(-4000);
        });
        child.once('exit', (code) => {
          this.#failAll(
            new Error(`微信 sidecar 退出（code=${code}）；最近 stderr：\n${this.stderrTail}`),
          );
          this.child = null;
        });
        resolve();
      });
    });
  }

  /** 一行一个 JSON；半行留在 buffer 里等下一块。 */
  #onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.#onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /** 派发一条响应到对应的挂起请求。 */
  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // 非协议输出（不该有，忽略而不是崩）
    }
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    const detail = message.trace ? `${message.error}\n${message.trace}` : message.error;
    entry.reject(new Error(String(detail)));
  }

  /** 进程没了就把所有等待者一次性失败，别让调用挂死。 */
  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 发一个 JSON-RPC 请求。 */
  async request(method, params = {}, timeoutMs = READ_TIMEOUT_MS) {
    if (this.child === null || this.child.exitCode !== null) {
      await this.ensure();
    }
    if (this.child === null) throw new Error('微信 sidecar 未启动');
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(payload, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 主动结束；再调用会重新拉起。 */
  #kill() {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // 已经死了就算了
    }
  }

  dispose() {
    this.#failAll(new Error('微信 sidecar 已停止'));
    this.#kill();
  }
}

/** 取字符串，带默认值；sidecar 返回 null 时也不崩。 */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** 取整数，带默认值。 */
function integer(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** 把任意值收敛成字符串数组（防御 sidecar 形状变化）。 */
function list(value) {
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ 输出形状 */

/** 会话条目的投影。 */
function projectSession(raw) {
  return {
    username: text(raw?.username),
    name: text(raw?.name),
    isGroup: raw?.isGroup === true,
    unread: integer(raw?.unread),
    summary: text(raw?.summary),
    lastTimeText: text(raw?.lastTimeText),
  };
}

/** 消息条目的投影（群消息的 chat 字段可选）。 */
function projectMessage(raw) {
  const base = {
    id: integer(raw?.id),
    timeText: text(raw?.timeText),
    sender: text(raw?.sender),
    isSelf: raw?.isSelf === true,
    type: text(raw?.type),
    text: text(raw?.text),
  };
  if (raw?.chat === undefined) return base;
  return { ...base, chat: projectChat(raw.chat) };
}

/** 会话标识的投影。 */
function projectChat(raw) {
  return {
    username: text(raw?.username),
    name: text(raw?.name),
    isGroup: raw?.isGroup === true,
  };
}

/* ------------------------------------------------------------------ 渲染 */

/** 每条消息一行。 */
function renderMessageLine(message) {
  const who = message.isSelf ? '我' : message.sender || '对方';
  const body = message.text.replace(/\s+/gu, ' ').slice(0, 200);
  return `  ${message.timeText} ${who}: ${body}`;
}

/** 把工具结果包成模型可读文本。 */
function asText(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

/* ------------------------------------------------------------------ 插件 */

/**
 * Register the WeChat tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional deployment config (`python`, `script`, `dbDir`, `enableOcr`).
 */
export function apply(ctx, config = {}) {
  const sidecar = new Sidecar({
    python: typeof config?.python === 'string' ? config.python : '',
    script:
      typeof config?.script === 'string' && config.script.trim().length > 0
        ? config.script.trim()
        : DEFAULT_SCRIPT,
    dbDir: typeof config?.dbDir === 'string' && config.dbDir.trim().length > 0
      ? config.dbDir.trim()
      : process.env.WECHAT_DB_DIR ?? null,
    enableOcr: config?.enableOcr === true,
  });

  // 插件卸载时收掉子进程，避免留下一个孤儿 Python。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => sidecar.dispose());
  }

  ctx.tools.register({
    name: 'wechat_status',
    description:
      '体检本机微信桥：微信客户端是否在运行、登录的账号是谁、本地数据库能不能解密读出来、OCR 是否启用。' +
      '任何其它 wechat_* 工具报错时先跑这个——它能把「微信没开」「密钥读不到」「库路径不对」分开说清楚。' +
      '只读，不驱动界面。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          wechatRunning: { type: 'boolean' },
          version: { type: 'string' },
          account: {
            type: 'object',
            properties: {
              wxid: { type: 'string' },
              nick: { type: 'string' },
            },
            required: ['wxid', 'nick'],
            additionalProperties: false,
          },
          readable: { type: 'boolean' },
          keyCount: { type: 'integer' },
          ocrEnabled: { type: 'boolean' },
          dbDir: { type: 'string' },
          dbError: { type: 'string' },
          python: { type: 'string' },
        },
        required: [
          'wechatRunning',
          'version',
          'account',
          'readable',
          'keyCount',
          'ocrEnabled',
          'dbDir',
          'dbError',
          'python',
        ],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [`微信：${value.wechatRunning ? `运行中（${value.version || '版本未知'}）` : '未运行'}`];
        if (value.account.wxid.length > 0) {
          lines.push(`账号：${value.account.nick || '(无昵称)'} / ${value.account.wxid}`);
        }
        lines.push(
          value.readable
            ? `数据库：可读（${value.keyCount} 个库密钥，${value.dbDir || '自动探测'}）`
            : `数据库：不可读${value.dbError ? ` — ${value.dbError}` : ''}`,
        );
        lines.push(`发送链路：UI Automation（OCR ${value.ocrEnabled ? '开' : '关'}），Python ${value.python}`);
        return asText(lines);
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute() {
      const result = await sidecar.request('doctor', {}, READ_TIMEOUT_MS);
      const account = result?.account ?? {};
      const processes = list(result?.processes);
      return {
        wechatRunning: result?.wechatRunning === true,
        version: text(processes[0]?.version),
        account: { wxid: text(account.wxid), nick: text(account.nick) },
        readable: result?.readable === true,
        keyCount: integer(account.keyCount),
        ocrEnabled: result?.ocrEnabled === true,
        dbDir: text(account.dbDir || result?.dbDir),
        dbError: text(result?.dbError),
        python: text(result?.python),
      };
    },
  });

  ctx.tools.register({
    name: 'wechat_sessions',
    description:
      '列出微信最近会话（名字、未读数、最后一条摘要、时间）。' +
      '要发消息或读消息之前先用它拿准确的会话名或 username——重名时只有 username 是唯一可靠的。' +
      '只读，不驱动界面。',
    parameters: {
      limit: { type: 'integer', description: '返回多少条，默认 20，上限 50。' },
      unreadOnly: { type: 'boolean', description: '只看有未读的会话。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                name: { type: 'string' },
                isGroup: { type: 'boolean' },
                unread: { type: 'integer' },
                summary: { type: 'string' },
                lastTimeText: { type: 'string' },
              },
              required: ['username', 'name', 'isGroup', 'unread', 'summary', 'lastTimeText'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'sessions'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.sessions.length === 0) return asText(['没有会话。']);
        const lines = [`${value.count} 个会话：`];
        for (const session of value.sessions) {
          const flag = session.unread > 0 ? `(${session.unread} 未读) ` : '';
          const kind = session.isGroup ? '群' : '人';
          lines.push(
            `• [${kind}] ${session.name} ${flag}${session.lastTimeText}\n    ${session.summary}\n    username: ${session.username}`,
          );
        }
        return asText(lines);
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Math.max(1, Math.min(integer(args?.limit, 20), 50));
      const result = await sidecar.request(
        'sessions',
        { limit, unreadOnly: args?.unreadOnly === true },
        READ_TIMEOUT_MS,
      );
      const sessions = list(result?.sessions).map(projectSession);
      return { count: sessions.length, sessions };
    },
  });

  ctx.tools.register({
    name: 'wechat_messages',
    description:
      '读某个会话最近的消息（非文本消息折叠成 [图片]/[文件] 这类摘要，不会吐出原始 XML 和密钥）。' +
      'chat 可以是会话名、备注名或 username；重名会直接报错并要求改用 username。' +
      '只读，不驱动界面，不会把消息标成已读。',
    parameters: {
      chat: { type: 'string', description: '会话名、备注名或 username（如 xxx@chatroom）。' },
      limit: { type: 'integer', description: '读多少条，默认 20，上限 100。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          chat: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              name: { type: 'string' },
              isGroup: { type: 'boolean' },
            },
            required: ['username', 'name', 'isGroup'],
            additionalProperties: false,
          },
          count: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                timeText: { type: 'string' },
                sender: { type: 'string' },
                isSelf: { type: 'boolean' },
                type: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['id', 'timeText', 'sender', 'isSelf', 'type', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['chat', 'count', 'messages'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const head = `${value.chat.name}${value.chat.isGroup ? '（群）' : ''} · ${value.count} 条`;
        return asText([head, ...value.messages.map(renderMessageLine)]);
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const chat = text(args?.chat).trim();
      if (chat.length === 0) throw new Error('wechat_messages 需要 chat');
      const limit = Math.max(1, Math.min(integer(args?.limit, 20), 100));
      const result = await sidecar.request('messages', { chat, limit }, READ_TIMEOUT_MS);
      const messages = list(result?.messages).map(projectMessage);
      return { chat: projectChat(result?.chat), count: messages.length, messages };
    },
  });

  ctx.tools.register({
    name: 'wechat_search',
    description:
      '按名字在联系人/群里搜，返回 username。用微信昵称的片段也能搜到。' +
      '拿不准一个会话到底是谁时先用它——直接拿昵称去发消息，重名会发错人。只读。',
    parameters: {
      keyword: { type: 'string', description: '昵称、备注名或群名的一部分。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                username: { type: 'string' },
                name: { type: 'string' },
                isGroup: { type: 'boolean' },
              },
              required: ['username', 'name', 'isGroup'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'results'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.results.length === 0) return asText(['没有匹配的联系人或群。']);
        const lines = [`${value.count} 个结果：`];
        for (const item of value.results) {
          lines.push(`• ${item.isGroup ? '[群] ' : ''}${item.name}  →  ${item.username}`);
        }
        return asText(lines);
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const keyword = text(args?.keyword).trim();
      if (keyword.length === 0) throw new Error('wechat_search 需要 keyword');
      const result = await sidecar.request('search', { keyword }, READ_TIMEOUT_MS);
      return { count: integer(result?.count), results: list(result?.results).map(projectChat) };
    },
  });

  ctx.tools.register({
    name: 'wechat_inbox',
    description:
      '取「上次之后别人发来的新消息」，并推进游标——自动回复的入口。' +
      '第一次遇到某个会话只建基线、不返回历史，所以不会把陈年旧消息当新消息回。' +
      '默认只看有未读的会话；给 chats 就只盯这几个。' +
      '拿到的每条都带 chat.username，回的时候把它传给 wechat_send 最稳。' +
      '返回里有两个闸门：window 是发言时段（不在时段内既不回消息、也不主动发言），' +
      'proactive 是主动发言的节流（距上次多久 / 今日几条 / 不许重复）。' +
      '两者判据全部来自磁盘配置与发送账本，不靠记忆；allowed=false 就照 reason 停手。' +
      '只读数据库，不驱动界面。',
    parameters: {
      chats: {
        type: 'array',
        items: { type: 'string' },
        description: '只盯这些会话（名字或 username）；不给就看有未读的会话。',
      },
      limit: { type: 'integer', description: '最多返回多少条，默认 20。' },
      deep: { type: 'boolean', description: 'true 时连没有未读的会话也扫（慢很多）。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chat: {
                  type: 'object',
                  properties: {
                    username: { type: 'string' },
                    name: { type: 'string' },
                    isGroup: { type: 'boolean' },
                  },
                  required: ['username', 'name', 'isGroup'],
                  additionalProperties: false,
                },
                id: { type: 'integer' },
                timeText: { type: 'string' },
                sender: { type: 'string' },
                isSelf: { type: 'boolean' },
                type: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['chat', 'id', 'timeText', 'sender', 'isSelf', 'type', 'text'],
              additionalProperties: false,
            },
          },
          proactive: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              allowed: { type: 'boolean' },
              reason: { type: 'string' },
              lastPostAt: { type: 'string' },
              lastPostText: { type: 'string' },
              minutesSinceLastPost: { type: 'integer' },
              minMinutesBetween: { type: 'integer' },
              todayCount: { type: 'integer' },
              dailyCap: { type: 'integer' },
              recentTexts: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'enabled',
              'allowed',
              'reason',
              'lastPostAt',
              'lastPostText',
              'minutesSinceLastPost',
              'minMinutesBetween',
              'todayCount',
              'dailyCap',
              'recentTexts',
            ],
            additionalProperties: false,
          },
          window: {
            type: 'object',
            properties: {
              allowed: { type: 'boolean' },
              window: { type: 'array', items: { type: 'string' } },
              now: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['allowed', 'window', 'now', 'reason'],
            additionalProperties: false,
          },
        },
        required: ['count', 'messages', 'proactive', 'window'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const gate = value.proactive;
        const windowLine = value.window.allowed
          ? `发言时段：可以（${value.window.window.join('–')}，现在 ${value.window.now}）`
          : `发言时段：不可以（${value.window.reason}）——本轮不回消息，也不主动发言`;
        const gateLine = gate.allowed
          ? `主动发言：可以（今日 ${gate.todayCount}/${gate.dailyCap}${
              gate.lastPostAt ? `，上次 ${gate.lastPostAt}` : ''
            }）`
          : `主动发言：不可以（${gate.reason}）`;
        if (value.messages.length === 0) {
          return asText([`没有新消息。${windowLine}。${gateLine}`]);
        }
        const lines = [`${value.count} 条新消息：`];
        for (const message of value.messages) {
          const where = message.chat.isGroup
            ? `${message.chat.name} / ${message.sender}`
            : message.chat.name;
          lines.push(
            `• ${message.timeText} ${where}: ${message.text.replace(/\s+/gu, ' ').slice(0, 300)}`,
          );
        }
        lines.push(windowLine);
        lines.push(gateLine);
        if (gate.recentTexts.length > 0) {
          lines.push(`最近发过（别重复）：${gate.recentTexts.join(' / ')}`);
        }
        return asText(lines);
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const chats = list(args?.chats).filter((item) => typeof item === 'string');
      const limit = Math.max(1, Math.min(integer(args?.limit, 20), 50));
      const result = await sidecar.request(
        'poll',
        { chats, limit, deep: args?.deep === true },
        READ_TIMEOUT_MS,
      );
      const messages = list(result?.messages).map(projectMessage);
      const rawWindow = result?.window ?? {};
      const window = {
        allowed: rawWindow.allowed === true,
        window: list(rawWindow.window).map((item) => text(item)),
        now: text(rawWindow.now),
        reason: text(rawWindow.reason),
      };
      const raw = result?.proactive ?? {};
      const proactive = {
        enabled: raw.enabled === true,
        allowed: raw.allowed === true,
        reason: text(raw.reason),
        lastPostAt: text(raw.lastPostAt),
        lastPostText: text(raw.lastPostText),
        minutesSinceLastPost: integer(raw.minutesSinceLastPost, -1),
        minMinutesBetween: integer(raw.minMinutesBetween),
        todayCount: integer(raw.todayCount),
        dailyCap: integer(raw.dailyCap),
        recentTexts: list(raw.recentTexts).map((item) => text(item)).filter((item) => item.length > 0),
      };
      return { count: messages.length, messages, proactive, window };
    },
  });

  ctx.tools.register({
    name: 'wechat_send',
    description:
      '用本机已登录的微信发一条文本消息。会真实驱动微信窗口（前置窗口、搜索会话、输入、回车），' +
      '约 10-30 秒，期间会抢焦点。' +
      'chat 必须是准确的会话名或 username：重名会报错而不是猜；拿不准就先 wechat_search。' +
      '发送后桥会回读数据库确认，confirmed=false 表示「界面点了发送但库里没确认」，需要人工看一眼。' +
      '只发用户明确要发的内容；不要拿它群发、不要发给没被点名的人。',
    parameters: {
      chat: { type: 'string', description: '目标会话名、备注名或 username。' },
      text: { type: 'string', description: '消息正文（纯文本，最多 3000 字）。' },
      dryRun: {
        type: 'boolean',
        description: 'true 时只解析目标、打印将发给谁，不发。拿不准目标时先这样试一次。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          chat: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              name: { type: 'string' },
              isGroup: { type: 'boolean' },
            },
            required: ['username', 'name', 'isGroup'],
            additionalProperties: false,
          },
          text: { type: 'string' },
          ok: { type: 'boolean' },
          sent: { type: 'boolean' },
          confirmed: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          message: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
        required: ['chat', 'text', 'ok', 'sent', 'confirmed', 'dryRun', 'message', 'elapsedMs'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const head = value.dryRun
          ? `[dryRun] 将发给 ${value.chat.name}（${value.chat.username}）：${value.text}`
          : `发送${value.ok ? '成功' : '失败'} → ${value.chat.name}（${value.chat.username}）`;
        const lines = [head];
        if (!value.dryRun) {
          lines.push(`数据库回读：${value.confirmed ? '已确认' : '未确认（请人工核对）'}`);
          lines.push(`耗时 ${value.elapsedMs}ms`);
        }
        if (value.message.length > 0) lines.push(value.message);
        return asText(lines);
      },
    },
    timeoutMs: SEND_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `微信发送 → ${text(args?.chat, '(未指定)')}`,
      kind: 'execute',
      rawInput: args,
    }),
    async execute(args) {
      const chat = text(args?.chat).trim();
      const body = text(args?.text);
      if (chat.length === 0) throw new Error('wechat_send 需要 chat');
      if (body.trim().length === 0) throw new Error('wechat_send 需要非空 text');
      if (body.length > 3000) throw new Error('单条消息最多 3000 字，请先精简');
      const result = await sidecar.request(
        'send',
        { chat, text: body, dryRun: args?.dryRun === true },
        SEND_TIMEOUT_MS,
      );
      return {
        chat: projectChat(result?.chat),
        text: text(result?.text, body),
        ok: result?.ok === true,
        sent: result?.sent === true,
        confirmed: result?.confirmed === true,
        dryRun: result?.dryRun === true,
        message: text(result?.uiaMessage || result?.note),
        elapsedMs: integer(result?.elapsedMs),
      };
    },
  });
}
