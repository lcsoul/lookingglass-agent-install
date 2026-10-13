# lookingglass-agent-install

Looking Glass 探测节点的一键安装（免 Docker，systemd 常驻）。

## 一行命令安装

```bash
wget -qO- https://raw.githubusercontent.com/lcsoul/lookingglass-agent-install/main/install.sh | sudo bash -s -- -e "ws://你的服务器:8080/ws/agent" -t "节点Token"
```

或：

```bash
curl -sL https://raw.githubusercontent.com/lcsoul/lookingglass-agent-install/main/install.sh -o /tmp/lg-install.sh \
  && chmod +x /tmp/lg-install.sh \
  && sudo /tmp/lg-install.sh -e "ws://你的服务器:8080/ws/agent" -t "节点Token"
```

## 参数

| 参数 | 说明 |
|---|---|
| `-e, --endpoint URL` | 服务端地址（必填）。支持简写：`example.com` / `https://example.com` 会自动补成 `wss://example.com/ws/agent`；完整 `ws(s)://` 地址原样使用 |
| `-t, --token TOKEN` | 节点 Token（必填，在 Looking Glass 控制台「节点管理」新建节点后复制，一机一 token） |
| `--china-mirrors` | 使用国内镜像（nodesource 清华源 + npm npmmirror） |
| `--uninstall` | 卸载 agent |
| `-h, --help` | 显示帮助 |

脚本会自动：安装 Node.js 20（如缺）→ 安装 `iputils-ping` / `traceroute` / `mtr` → 下载 agent → `npm install` → 注册 systemd 服务并启动。

重复执行本脚本 = 更新到最新版。`agent/` 目录与主仓库 [lcsoul/lookingglass](https://github.com/lcsoul/lookingglass) 的 `agent/` 保持同步。
