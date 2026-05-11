# OpenRemote

&emsp;&emsp;OpenRemote 是一个 Claude Code 远程控制插件，通过微信小程序实现随时随地对本地 Claude Code 会话的监控与交互。无论是发送指令、查看响应、审批工具权限，还是管理多个会话，都可以在手机上完成。

> 目前处于 Beta 阶段，如遇问题欢迎提 [Issue](../../issues) 反馈。
> OpenCode 插件也在加紧开发中。

### 特性

- **无侵入** — 使用 `clauderemote` 命令启动即可，本地终端体验不变，原 `claude` 命令不受影响
- **实时同步** — AI 响应、工具调用进度、权限请求实时推送到客户端
- **远程控制** — 支持远程发送消息、审批权限、新建与切换会话
- **一键安装** — 运行安装脚本即可自动完成依赖安装、编译、hooks 配置
- **多会话** — 支持同时管理多个 Claude Code 会话
- **跨平台** — 支持 macOS、Linux、Windows

## 架构

```
客户端 (微信小程序) ──WebSocket──► 云服务器 ◄──WebSocket── claude-plugin (本地)
```

**claude-plugin** 通过 `node-pty` 启动 Claude Code 子进程，利用 Claude Code hooks 捕获事件（消息、工具调用、权限请求等），经云服务器转发到远程客户端。客户端发送的指令也通过同一条链路反向注入 PTY。

## 安装

### 前置要求

- **Node.js** >= 18、**npm**
- **C 编译器**（macOS: `xcode-select --install`，Linux: `sudo apt install build-essential`）
- **Claude Code CLI**（`npm install -g @anthropic-ai/claude-code`）

### macOS / Linux

```bash
cd claude-plugin
bash setup.sh
```

### Windows

```powershell
cd claude-plugin
powershell -ExecutionPolicy Bypass -File setup.ps1
```

安装脚本会自动完成：安装依赖 → 编译 TypeScript → 创建 `clauderemote` 命令行包装器 → 配置 PATH → 写入 Claude Code hooks。

### 配置 Token

安装完成后，需要配置认证 token（从 OpenRemote 小程序获取）：

**方式一：环境变量**
```bash
export OPENREMOTE_TOKEN=ort_xxxxx
```

**方式二：配置文件**
```bash
mkdir -p ~/.openremote
echo '{"token":"ort_xxxxx"}' > ~/.openremote/credentials.json
```

## 使用

```bash
# 启动远程控制的 Claude Code 会话
clauderemote

# 正常使用 Claude Code（不受影响）
claude
```

`clauderemote` 启动后会自动连接云服务器，在对应的 OpenRemote 小程序上即可看到会话并进行远程交互：

- **发送消息** — 客户端发送文本，插件注入到 Claude Code PTY
- **权限回复** — Claude Code 请求工具权限时，客户端可远程允许/拒绝
- **新建会话** — 客户端发送新建指令，插件在 PTY 中执行 `/clear`
- **查看输出** — AI 响应、工具调用进度实时同步到客户端

## 卸载

```bash
# macOS / Linux
cd claude-plugin && bash uninstall.sh

# Windows
cd claude-plugin && powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

## 项目结构

```
claude-plugin/
├── package.json             # 依赖配置
├── tsconfig.json            # TypeScript 配置
├── setup.sh / setup.ps1     # 安装脚本
├── uninstall.sh / uninstall.ps1  # 卸载脚本
├── hooks/
│   └── forward.cjs          # Claude Code hook 转发
└── src/
    ├── index.ts             # PTY Bridge 主入口
    ├── credentials.ts       # Token 凭证加载
    └── ansi-parser.ts       # ANSI 终端输出解析
```
