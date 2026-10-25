# pi-cc-plugins

> 把 Claude Code 的几个小行为搬到 Pi：Ctrl+C 清掉的输入，按 ↑ 能找回；每轮结束显示一行摘要（工具统计、用时、完成时刻）。

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
| Ctrl+C 找回 | Ctrl+C 清掉的内容，在空输入框按 ↑ / Ctrl+P 原样放回；没找回的在下次发送时进 ↑ 历史 | `draft.ts` |
| 回合摘要 | 每轮结束一行：`Ran 3 commands, read 2 files · Completed for 42s · done 6:51 PM`，中断的写 `Interrupted for 2s · …` | `turn-summary.ts` |

包只有一个入口 `index.ts`，在 `pi config` 和启动横幅里显示为一行 `pi-cc-plugins`，和 pi-cc-loop 一样；`pi config` 对它整包启停。两个功能各自在自己的模块里，互不依赖。

## /pi_cc

本包和 pi-cc-loop、pi-cc-monitor、pi-cc-compaction 共同提供 `/pi_cc`：pi-cc 家族的设置命令。装了任意一个 pi-cc 包它就在；装了多个，也只有一个
`/pi_cc`（同名命令会被 Pi 改名成 `/pi_cc:1`、`/pi_cc:2`，所以由最先加载的包认领注册）。

- TUI 里输入 `/pi_cc` 打开设置面板，按插件分页（Tab / Shift+Tab 切换页，上下键选择，Enter/空格切换，Esc 关闭）；非 TUI 输出文字摘要
- 文字命令：`/pi_cc <项> on|off`，适合脚本和 RPC
- 本包的两个功能在面板的 Plugins 页：**Draft recall**（`draft`，默认开，Ctrl+C 找回）和 **Turn summary**（`turnSummary`，默认开，回合摘要）；`/pi_cc draft on|off`、`/pi_cc summary on|off` 切换
- 切换即时生效，不用 `/reload`：Ctrl+C 找回的补丁当场装/卸，回合摘要从下一轮开始（或停止）写
- 环境变量 `PI_CC_DRAFT=0`、`PI_CC_TURN_SUMMARY=0` 可临时覆盖，面板里相应项锁定
- 另外几项本包不用：`messages`、`footer` 对 loop 和 monitor 的渲染生效，`compact`、`idle` 属于 pi-cc-compaction

## Ctrl+C 找回

对齐 Claude Code 2.1.308（输入框状态里的 `holdCleared` / `restoreCleared`）：

- Ctrl+C 清空输入框前先把内容存下来，粘贴内容一起存；空白内容不存，正在浏览的一条没改过的历史也不存（它本来就在历史里）。
- 输入框为空时按 ↑ 原样放回，光标在末尾，只放回一次。"↑" 指所有绑定到 cursor up 或 history previous 的键：在 `keybindings.json` 里把 Ctrl+P 绑上去，Ctrl+P 也算。
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

## 兼容性

Pi 1.3.0 / 1.4.0。

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes -p typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

测试加载真实的 Pi 模块：Ctrl+C 找回直接对 Pi 的 `CustomEditor` 模拟按键。
测别的 Pi 版本时，把 `PI_AGENT_DIR` 指到只装了那个版本的目录（`<dir>/install/releases/<version>`）。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。两个扩展都不改模型看到的内容：Ctrl+C 找回只在输入框里工作；回合摘要是 custom entry，不进上下文。
两者都不注册会改 prompt 或历史的钩子（`before_agent_start` / `context` / `before_provider_request` 等）。
`tests/cache.test.mjs` 守住这一点，并用 Pi 自己的 `buildSessionContext` 确认摘要条目不在上下文里。

## 与 Claude Code 的差异

- Ctrl+C 找回：CC 把没找回的内容另存一个列表（本会话最多 10 条），按清空时间插进 ↑ 历史；这里直接写进 Pi 输入框的历史，和发送过的消息放在一起（Pi 最多 100 条）。CC 在查看子 agent 时不写历史，Pi 没有这个视图。
- 双击 Esc：CC 双击 Esc 也会清空输入框，并写进持久历史；Pi 的 Esc 不清空输入框（bash 模式除外），空输入框双击 Esc 按设置打开 `/tree` 或 `/fork`，所以不在本包范围。
- 回合摘要：CC 的耗时行是 `✻ Worked for 42s · done 6:51 PM`，整行 dim，动词从 Baked、Brewed、Worked 等词里选，和工具统计分开显示，按 Esc 中断的回合不显示；不是当天的会带上星期或日期。
  这里按 agent-summary 的引用块格式把两者合成一行：正常回合动词固定为 Completed，中断的写 Interrupted、出错的写 Failed，时刻固定为 `h:mm AM/PM`，中断的回合也显示；用时和时刻的数字上 CC 的橙色（AM/PM 后缀不上；CC 那一行整行 dim，不上色）。

## 许可证

MIT。回合摘要的工具统计来自 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) 的 agent-summary（MIT，© 2026 minuque），许可文本附在 LICENSE 里。
