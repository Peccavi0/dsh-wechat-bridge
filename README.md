# dsh-wechat-bridge

把本机**已登录的微信桌面客户端**接进 [DeepSeek Harness](https://github.com/deepseek-ai)，变成一组有边界的模型工具；再配一个定时巡检循环，让模型按你自己的口吻回消息、在群里搭话。

> **先看风险**：这是第三方自动化。个人号自动化违反微信服务协议，存在被限制登录的风险。只在你**本人有权控制**的账号、设备和会话里使用；不要群发、不要加陌生人、不要高频操作。默认配置是按「不被看出是机器人」调过的，调激进之前先想清楚。

---

## 它能做什么

| 工具 | 作用 | 是否驱动界面 |
|---|---|---|
| `wechat_status` | 体检：微信在不在、账号是谁、数据库能不能读 | 否 |
| `wechat_sessions` | 最近会话（未读数、最后一条摘要） | 否 |
| `wechat_messages` | 某个会话的最近消息 | 否 |
| `wechat_search` | 按昵称/备注/群名找会话，拿 `username` | 否 |
| `wechat_inbox` | 上次之后的新消息 + 主动发言闸门 | 否 |
| `wechat_send` | 发一条文本消息 | **是**（前置窗口、输入、回车） |

读走本地数据库解密，写走 UI Automation。非文本消息（图片、文件、卡片）会被折叠成 `[图片]`、`[文件] xxx.xlsx` 这类摘要——**不会**把原始 XML 里的 aeskey、CDN 凭证吐进模型上下文。

## 为什么不用现成的

| 路线 | 代表项目 | 卡在哪 |
|---|---|---|
| 网页/协议 | itchat、wechaty | itchat 的网页协议早已封；wechaty 的 iPad 协议要买昂贵 token，还要养号 |
| Hook 注入 | WeChatFerry、ntchat | 只支持微信 3.9.x；hook 类已被大规模扫描封号 |
| UIA 自动化 | [wxauto4](https://docs.wxauto.org/) / wxautox4 | 免费版只支持到 4.1.8.107，付费版要激活码 |
| **本项目** | [wechatauto-replica](https://pypi.org/project/wechatauto-replica/) | 4.1.12+ 可用，读库 + UIA 双通道 |

关键点：微信 4.x 改成自绘渲染后，冷启动时 UI Automation 只能看到 `Qt51514QWindowIcon` 空壳。`wechatauto-replica` 的做法是往 `Weixin.dll` 里写 Qt accessibility gate 字节**热激活**控件树，之后锚点变成 `mmui::MainWindow`，搜索框、输入框才可用。本项目直接复用它，没有另造轮子。

## 环境要求

- Windows 10 / 11
- 微信桌面版 **4.1.12+**（在 4.1.15.13 上验证）
- Python 3.9+（3.13 实测可用）
- 一个能装 bundle 的 DSH profile

### 关于 `winsdk` 与 OCR

`wechatauto-replica` 把 `winsdk` 列为硬依赖，但它只在 OCR 那条路用得上，而 `winsdk` 在 Python 3.13 上没有预编译轮子（会去拉 VS 编译）。

本项目的处理：**装包时 `--no-deps` 跳过 winsdk，运行时把 `WxParam.ENABLE_OCR` 置 False**，发送链路自动改走 UIA。代价是极少数生僻字会话名可能匹配不到；如果你用的是 Python 3.9–3.12，也可以装 winsdk 后把 `enableOcr` 打开。

## 安装

```powershell
# 1. 主库（跳过 winsdk）
python -m pip install --no-deps wechatauto-replica

# 2. 其余依赖
python -m pip install "uiautomation>=2.0.18" "pywin32>=305" "pyperclip>=1.8.2" ^
  "Pillow>=9.0.0" "colorama>=0.4.6" "cryptography>=41.0.0" ^
  "imageio-ffmpeg>=0.4.9" "zstandard>=0.19.0" "pyautogui>=0.9.53"

# 3. 装上 bundle（把路径换成你的）
#    在 DSH 里让模型执行 plugin_manager install_bundle <本仓库绝对路径>
```

装完先跑一次体检，确认数据库密钥能提取出来：

```
wechat_status
```

期望看到 `readable: true`、`keyCount > 0`。读不到密钥通常是三个原因：32 位 Python、权限与微信不一致、多账号选错。

## 配置

把 `examples/` 里的两个文件复制到 `sidecar/.state/` 再改（这个目录被 `.gitignore` 排除，不会进版本库）：

```powershell
New-Item -ItemType Directory sidecar\.state -Force
copy examples\autoreply.example.json sidecar\.state\autoreply.json
copy examples\proactive.example.json sidecar\.state\proactive.json
```

### `autoreply.json`

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关，`false` 时巡检第一行就退出 |
| `activeWindow` | 允许说话的时段，如 `["07:00", "01:00"]` 表示到次日 1 点；**可以跨午夜** |
| `whitelist` | 允许自动回复的会话，用 `username`（群名带 emoji 时尤其要用 username） |
| `selfAliases` | 你自己的各种名字（群昵称、微信昵称、别人对你的称呼），用于判断「是否 @ 我」 |
| `groupMode` | `all` = 群里没 @ 也搭话；`at-only` = 只回 @ |
| `minMinutesBetweenReplies` | 同一个会话两次搭话的最小间隔 |
| `maxChatsPerRound` | 一轮最多回几个会话 |

### `proactive.json`

没人说话时主动发一句的节流：`minMinutesBetween`（间隔）、`dailyCap`（日上限）、`recentAvoid`（不许重复最近几条）。

闸门判据全部来自磁盘事实——`outbox.jsonl` 就是每次真实发送的账本，不靠模型记忆，也不需要在提示里维护计数器。

## 自动回复循环

在 DSH 里建一个定时提醒，定期唤醒模型执行巡检：

```
schedule_create(
  title: "微信自动回复巡检",
  every_seconds: 180,
  prompt: <examples/reminder-prompt.md 的内容>
)
```

提示词模板见 [`examples/reminder-prompt.md`](examples/reminder-prompt.md)，行为契约见 [`AUTOREPLY.md`](AUTOREPLY.md)。建议先读后者再改前者——两者冲突时会出乱子。

## 风险与边界

- **封号**：个人号自动化违反微信服务协议。本项目不注入 DLL、不改内存写库，只「读本地数据库 + 模拟人手点击」，风险低于 hook，但不是零。
- **四条硬底线**（写在 `AUTOREPLY.md` 里，建议别删）：不替你谈钱、不约时间、不做承诺、不发文件链接。角色可以变，账不能让 AI 替你认。
- **白名单**：默认只回你点名的会话。放开到所有私聊之前想清楚——它是在拿你的号跟真人说话。
- **抢焦点**：发送会前置微信窗口并模拟输入，10–30 秒内别用键盘鼠标。
- **隐私**：数据库密钥来自微信进程内存的只读扫描；聊天记录不出本机。但 `sidecar/.state/outbox.jsonl` 会记录每次发送的原文，**这个目录不要提交、不要分享**。

## 已知限制

- OCR 默认关闭（见上），生僻字会话名可能搜索不到。
- 微信小版本升级后 UIA 布局可能失配，`open_chat` 会失败——此时读库仍然可用，发送需要重新校准。
- 群名带 emoji 时，按 `username` 打不开会话，桥会先换成显示名再驱动界面（已验证）。
- **改了 `index.js` 或 `wechat_bridge.py` 必须重载 bundle**（关掉再打开），常驻进程不会热加载。
- 首次调用要解密整库 + 热激活 UIA，约 10–20 秒；之后复用连接，发送约 2–6 秒。

## 目录结构

```
.
├── index.js                      # Host 半部分：注册工具、管理 sidecar 子进程
├── cordis.patch.yml              # bundle 挂载声明
├── package.json
├── icon.svg
├── locale/                       # 插件显示用的标题与描述
├── sidecar/
│   └── wechat_bridge.py          # Python：JSON-RPC over stdio，读库 + UIA 发送
├── AUTOREPLY.md                  # 自动回复的行为契约
└── examples/
    ├── autoreply.example.json
    ├── proactive.example.json
    └── reminder-prompt.md
```

## License

MIT。底层依赖 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) 为 Apache-2.0。
