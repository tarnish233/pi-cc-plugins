# pi-cc-plugins

> 把 Claude Code 的几个小行为搬到 Pi：↑ 可取回排队的消息；Ctrl+C 清掉的输入，按 ↑ 能找回；每轮结束显示一行摘要（工具统计、用时、完成时刻）。

## 安装

```bash
pi install npm:pi-cc-plugins
```

安装后执行 `/reload`。本地开发时把仓库软链接到扩展目录即可：

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-plugins
```

## 功能

| 功能 | 说明 | 扩展 |
| --- | --- | --- |
| CC 键 | 有排队时 ↑ / Ctrl+P 放回输入框，最后一个可视行上 ↓ / Ctrl+N 收回。Enter 不动，仍是 Pi 自己的键（干活时 steer，空闲时发送） | `cc-keys.ts` |
| Ctrl+C 找回 | Ctrl+C 清掉的内容，在空输入框按 ↑ / Ctrl+P 原样放回，最后一个可视行上 ↓ / Ctrl+N 收回；没找回的在下次发送时进 ↑ 历史 | `draft.ts` |
| 回合摘要 | 每轮结束一行：`Ran 3 commands, read 2 files · Completed for 42s · done 6:51 PM`，中断的写 `Interrupted for 2s · …` | `turn-summary.ts` |

包只有一个入口 `index.ts`，在 `pi config` 和启动横幅里显示为一行 `pi-cc-plugins`，和 pi-cc-loop 一样；`pi config` 对它整包启停。三个功能各自在自己的模块里，互不依赖。

## /plugins_settings

本包独立提供 `/plugins_settings`，只管理这三个功能：

- **Draft recall**（`draft`，默认开）：`/plugins_settings draft on|off`
- **Turn summary**（`turnSummary`，默认开）：`/plugins_settings summary on|off`
- **CC keys**（`ccKeys`，默认开）：`/plugins_settings keys on|off`

TUI 中打开单页面板，上下键选择、Enter/空格切换、Esc 关闭；RPC 中不带参数输出文字摘要。切换即时生效，不用 `/reload`：找回和 CC 键的补丁当场装/卸，摘要从下一轮起变化。

默认配置是 `~/.pi/agent/pi-cc-plugins.json`，跟随 `PI_CODING_AGENT_DIR`。新文件缺失时继承旧 `pi-cc.json` 中本包的有效字段，首次保存带入新文件；已有新文件不会被覆盖，旧文件不修改、不删除。`PI_CC_CONFIG_FILE` 显式指定路径时不回读旧文件。

`PI_CC_DRAFT`、`PI_CC_TURN_SUMMARY`、`PI_CC_KEYS` 可临时覆盖，面板中的相应项锁定，变量值不写入文件。其他插件的选项不出现在本面板，也不能通过本命令修改。

本包不再注册共享的 `/pi_cc`；旧脚本改用 `/plugins_settings`。`config.ts`、`settings.ts` 只维护本包的选项，不再要求与其他仓库一致。

## Ctrl+C 找回

对齐 Claude Code 2.1.308（输入框状态里的 `holdCleared` / `restoreCleared`）：

- Ctrl+C 清空输入框前先把内容存下来，粘贴内容一起存；空白内容不存，正在浏览的一条没改过的历史也不存（它本来就在历史里）。
- 输入框为空时按 ↑ 原样放回，光标在末尾，只放回一次。"↑" 指所有绑定到 cursor up 或 history previous 的键：在 `keybindings.json` 里把 Ctrl+P 绑上去，Ctrl+P 也算。
- 放回后，在最后一个可视行按 ↓ / Ctrl+N 回到按 ↑ 之前的样子（通常是清空）：放回的内容不算历史条目，Pi 自己的 ↓ 只会移动光标，所以由本扩展在边界把它收回。多行或自动折行的文本，内部上下键仍然逐行移动。放回的内容改动过（或已经发送）后，↓ 就恢复普通行为。
- 没放回的内容，下次发送消息时先于这条消息进入 ↑ 历史；再按一次 Ctrl+C 时，上一份也会先进历史。
- 只在输入框有焦点时生效，选择器、对话框里的 ↑ 不受影响。连按两次 Ctrl+C 退出，和原来一样。

Pi 没有提供这个钩子：`ctrl+c` 是保留键，扩展不能注册；在 `up` 上注册快捷键会把整个 ↑ 抢走；扩展 API 也写不了输入框的历史。
所以本扩展给 Pi 所有编辑器共用的 `CustomEditor` 类打补丁，不占编辑器插槽，和 pi-cc-extensions 的 `❯` 输入框（PromptEditor）兼容。
补丁在 TUI 会话开始时装上、结束时卸下（`/reload` 会装上新代码）；Pi 的编辑器缺少补丁用到的方法时不装，Ctrl+C 保持原样。

## 回合摘要

每轮完全结束（`agent_settled`：交互完成、中断、失败重试耗尽）写一行，用 pi-cc-extensions 的 agent-summary 的格式：引用块加斜体，文字取主题的引用色，数字用 success / error 色。请求失败自动重试时不会中途多写（`agent_end` 每次底层循环结束都发、且扩展侧事件没有 willRetry 标记，等 settle 才写）；统计覆盖整轮，含重试的那几次尝试。

```text
> Ran 3 commands, read 2 files · Completed for 42s · done 6:51 PM     工具调用 2 次以上
> Completed for 11s · done 6:51 PM                                     工具调用不到 2 次
> Interrupted for 2s · done 6:51 PM                                    按 Esc 中断的回合
> Failed for 3s · done 6:51 PM                                          出错的回合
```

- 工具统计照 agent-summary：bash / powershell 按调用次数；read / edit / write 按不同路径去重；其他工具按调用次数；失败单独计。
- 完成段每轮都有：动词跟随回合结局 —— 正常 Completed、中断（比如按 Esc）Interrupted、出错 Failed，取自回合里最后一条 assistant 消息的结局，和 Pi 自己判定回合结果的方式一致；用时加上完成时刻（en-US `h:mm AM/PM`），时长和时刻的数字用 CC 自己的橙色 rgb(215,119,87)（CC 标志的颜色），AM/PM 后缀不上色。不设时长门槛；loop、monitor 触发的回合一样写。
- 用 `appendEntry` 写进会话：只显示在聊天区，不进模型上下文。

**它替代 agent-summary**：本功能就是 agent-summary 加上完成时间，两个同时开着会出现两行统计。
用本包时，请在 pi-cc-extensions 的设置里关掉 agent-summary（`enableAgentSummary: false`）。

## 排队消息找回

本功能不碰 Enter：Pi 自己的键就是**干活时 steer**（工具批次结束即插入本轮）、**空闲时发送**，排队等整轮跑完的是 Alt+Enter 的 follow-up。这里只补上 CC 的 ↑：在空输入框按 ↑ / Ctrl+P 取回会话可见的待发消息。

**压缩期间请用原生 dequeue**：Pi 把这时排队的消息放在单独的压缩队列里，公开的 `ctx.hasPendingMessages()` 看不到它。↑ 可能只是把历史副本放回输入框，**原消息仍然排队**，修改重发可能导致原版和新版都发送；Ctrl+P 则可能仍执行原绑定（例如切模型）。请用 `app.message.dequeue`：macOS/Linux 默认 **Alt+Up**，Windows/WSL 默认 **Alt+Q**，自定义过键位就用你自己的绑定。原生 dequeue 会真正清空并取回会话队列和压缩队列。本包暂不增加宿主私有查询补丁，↑ / Ctrl+P 对压缩队列的盲区仍是明确保留的限制。

| 键 | Pi 里做什么 |
| --- | --- |
| Enter | **Pi 原生，本包不接管**：干活时 steer，工具批次结束后插入本轮；空闲时正常发送 |
| Ctrl+Enter | 本包不绑定，也不会用它把已排队的消息改为立即发送 |
| ↑ / Ctrl+P（输入框为空时） | 取回会话可见的排队消息；没有可见排队时保留原行为，压缩队列限制见上 |
| ↓ / Ctrl+N（放回的文本上） | 最后一个可视行上回到按 ↑ 之前的样子（通常是清空）；内部逐行移动 |
| ↑ / ↓（翻出的历史上） | 先在当前 query 内逐行移动；首个／末个可视行上才切换历史 query |
| 原生 dequeue（默认 Alt+Up） | **仍然可用、没改键**：真正取回会话与压缩队列；空时提示 No queued messages to restore。Windows/WSL 默认 Alt+Q；放回后最后一个可视行上 ↓ 同样收回 |

Pi 的 Enter 原样保留：干活时 steer、空闲时发送，Alt+Enter 仍然是 follow-up。本包不写任何键位补丁，`keybindings.json` 和 Pi 的默认键位表都没有被改动。

- **不接管 Enter**（v0.6.0 起）：以前这个功能把 `app.message.followUp` 绑到 `enter`，让 Enter 在干活时排队、等这一轮彻底结束再发；现在这条路去掉了，Enter 就是 Pi 自己的。想恢复旧行为，自己往 `keybindings.json` 写 `"app.message.followUp": "enter"` 即可。
- **斜杠菜单、禁用提交保留 Enter**：菜单打开时 ↑ 留给补全列表，不取回排队。
- **↑ / Ctrl+P 只在真有排队时接管**：补丁先问会话有没有待发消息（`ctx.hasPendingMessages()`），有才调用 Pi 自己的 dequeue；没有时 ↑ 照旧翻历史。Ctrl+P 按字节识别，不要求 `keybindings.json` 把它指到 `tui.editor.cursorUp` —— 它只在和 ↑ 相同的窄状态（输入框为空、确实有排队）里接管，那时 Pi 原本会拿它切模型。`app.message.dequeue` 这个动作还是原来的 Alt+Up（Pi 的提示 “Option+Up to edit all queued messages” 也是它），本功能没有换掉、也没有解绑 —— ↑ / Ctrl+P 只是多了一条“有排队时”的路。
- **↓ / Ctrl+N 在边界回到草稿**：补丁只记住本包放回的草稿或排队消息，在最后一个可视行上收回；文本改动过就不再介入。排队的消息本来就进了 ↑ 历史，收回后仍能按 ↑ 找回来。
- **历史 query 保留 Pi 原生多行编辑**：不再强制调用 `navigateHistory(1)`。在历史浏览状态下，↑ / ↓ 以及绑定到 `tui.editor.cursorUp` / `cursorDown` 的 Ctrl+P / Ctrl+N，先在当前 query 的可视行间移动，到首个／末个可视行后才翻历史；真实换行、自动折行、终端缩放都按 Pi 的布局处理。↑ 召回历史后的光标仍在第一行开头，所以此时再按 ↑ 会翻更旧的 query，按 ↓ 则进入下一行。真正改动文字后，Pi 会结束历史浏览，按普通草稿编辑；普通草稿需要到首个可视行的行首，才能用 ↑ 再进入历史。
- **独立历史快捷键不受行边界限制**：绑定到 `tui.editor.historyPrevious` / `historyNext` 的键继续直接翻整条 query；同一个键同时绑定到光标移动和独立历史动作时，独立历史动作优先。本包不替你修改这些键位。
- **只做单条排队**：这个功能只考虑"干活时发一条、↑ 拿回来改"这一种用法。Pi 的 dequeue 没有"只取一条"的接口，所以万一真排了多条，↑ 会把它们一次性全部放回输入框；不提供 CC 那种逐条选择，也不打算做。
- **终端按键限制**：如果终端把 Ctrl+Enter 报告成普通 Enter，Pi 无法区分，两者都会按 Enter 的规则处理；本包只是不再主动绑定可区分的 Ctrl+Enter。
- 关掉：`/plugins_settings keys off`，或 `PI_CC_KEYS=0`，或直接删掉 pi-cc-plugins。

## 兼容性

本轮修复与完整回归在 Pi 1.5.2 验收通过；Pi 1.5.1 及更早版本本轮未重新验证，历史验收记录不代表本轮已重测。

## 本地开发

```bash
node --test tests/*.test.mjs
npm run typecheck
```

测试加载真实的 Pi 模块：Ctrl+C 找回和 CC 键都直接对 Pi 的 `CustomEditor` 模拟按键。
测别的 Pi 版本时，把 `PI_AGENT_DIR` 指到只装了那个版本的目录（`<dir>/install/releases/<version>`）。
类型检查使用本地 TypeScript 开发依赖，并自动定位本地 peer dependencies 或当前安装的 Pi release；不要为此安装第二份 Pi。可用 `PI_AGENT_DIR` 选择隔离安装，用 `PI_TYPESCRIPT_PATH` 指向已有的 `typescript/lib/typescript.js`。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。三个扩展都不改模型看到的内容：Ctrl+C 找回和 CC 键只在输入框里工作；回合摘要是 custom entry，不进上下文。
两者都不注册会改 prompt 或历史的钩子（`before_agent_start` / `context` / `before_provider_request` 等）。
`tests/cache.test.mjs` 守住这一点，并用 Pi 自己的 `buildSessionContext` 确认摘要条目不在上下文里。

## 与 Claude Code 的差异

- Ctrl+C 找回：CC 把没找回的内容另存一个列表（本会话最多 10 条），按清空时间插进 ↑ 历史；这里直接写进 Pi 输入框的历史，和发送过的消息放在一起（Pi 最多 100 条）。CC 在查看子 agent 时不写历史，Pi 没有这个视图。
- CC 键：只对齐「取回单条排队消息」这一种用法——CC 的排队在有多条时按 ↑ 可以逐条选，这里不做选择器；那种情况下 ↑ / Ctrl+P 走 Pi 的 dequeue，会把排队的消息一起放回输入框，和 Alt+Up 相同。
- 多行编辑优先：历史 query 的上下键保留 Pi 原生行内导航，仅在首个／末个可视行翻历史。排队消息或 Ctrl+C 草稿用 `setText` 放回后，本包只在最后一个可视行上用 ↓ 收回，避免抢走内部逐行移动。
- 双击 Esc：CC 双击 Esc 也会清空输入框，并写进持久历史；Pi 的 Esc 不清空输入框（bash 模式除外），空输入框双击 Esc 按设置打开 `/tree` 或 `/fork`，所以不在本包范围。
- 回合摘要：CC 的耗时行是 `✻ Worked for 42s · done 6:51 PM`，整行 dim，动词从 Baked、Brewed、Worked 等词里选，和工具统计分开显示，按 Esc 中断的回合不显示；不是当天的会带上星期或日期。
  这里按 agent-summary 的引用块格式把两者合成一行：正常回合动词固定为 Completed，中断的写 Interrupted、出错的写 Failed，时刻固定为 `h:mm AM/PM`，中断的回合也显示；用时和时刻的数字上 CC 的橙色（AM/PM 后缀不上；CC 那一行整行 dim，不上色）。

## 许可证

MIT。回合摘要的工具统计来自 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 的 agent-summary（MIT，© 2026 minuque），许可文本附在 LICENSE 里。
