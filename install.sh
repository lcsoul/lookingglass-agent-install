#!/usr/bin/env bash
# Looking Glass agent 一键安装脚本（免 Docker，systemd 常驻）
#
# 用法（一行复制粘贴搞定）：
#   curl -sL https://raw.githubusercontent.com/lcsoul/lookingglass-agent-install/main/install.sh -o /tmp/lg-install.sh \
#     && chmod +x /tmp/lg-install.sh \
#     && sudo /tmp/lg-install.sh -e "ws://你的服务器:8080/ws/agent" -t "节点Token"
# 或者：
#   wget -qO- https://raw.githubusercontent.com/lcsoul/lookingglass-agent-install/main/install.sh \
#     | sudo bash -s -- -e "ws://你的服务器:8080/ws/agent" -t "节点Token"
#
# 参数：
#   -e, --endpoint URL     服务端地址（必填）。支持简写：
#                          "example.com" / "https://example.com" -> wss://example.com/ws/agent
#                          完整 ws(s):// 地址则原样使用
#   -t, --token TOKEN      节点 Token（必填，控制台「节点管理」新建节点后复制，一机一 token）
#   --china-mirrors        使用国内镜像（nodesource 清华源 + npm npmmirror）
#   --github-token TOKEN   仓库为 private 时，用该 GitHub PAT 下载 agent（公开仓库不需要）
#   --uninstall            卸载 agent（停服务、删文件）
#   -h, --help             显示帮助
#
# 重复执行本脚本 = 更新到最新版并重启。
set -euo pipefail

REPO="lcsoul/lookingglass-agent-install"
BRANCH="main"
INSTALL_DIR="/opt/lg-agent"
SERVICE_NAME="lg-agent"
NODE_MAJOR="20"

ENDPOINT=""
TOKEN=""
CHINA_MIRRORS=0
GITHUB_TOKEN=""
UNINSTALL=0

log()  { echo -e "\033[32m[lg-agent]\033[0m $*"; }
warn() { echo -e "\033[33m[lg-agent]\033[0m $*" >&2; }
die()  { echo -e "\033[31m[lg-agent]\033[0m $*" >&2; exit 1; }

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--endpoint)      ENDPOINT="$2"; shift 2 ;;
    -t|--token)         TOKEN="$2"; shift 2 ;;
    --china-mirrors)    CHINA_MIRRORS=1; shift ;;
    --github-token)     GITHUB_TOKEN="$2"; shift 2 ;;
    --uninstall)        UNINSTALL=1; shift ;;
    -h|--help)          usage ;;
    *) die "未知参数: $1，用 -h 查看帮助" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（如 sudo bash install.sh ...）"

# ---------- 卸载 ----------
if [[ $UNINSTALL -eq 1 ]]; then
  log "正在卸载..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  log "卸载完成"
  exit 0
fi

[[ -n "$ENDPOINT" ]] || die "缺少 -e/--endpoint（服务端地址），用 -h 查看帮助"
[[ -n "$TOKEN" ]]    || die "缺少 -t/--token（节点 Token），用 -h 查看帮助"

# ---------- endpoint 归一化 ----------
normalize_endpoint() {
  local e="$1"
  if [[ "$e" =~ ^wss?:// ]]; then echo "$e"; return; fi
  if [[ "$e" =~ ^https?:// ]]; then
    e="${e/#https:/wss:}"; e="${e/#http:/ws:}"
  else
    e="wss://$e"
  fi
  [[ "$e" == */ws/agent ]] || e="${e%/}/ws/agent"
  echo "$e"
}
SERVER_URL="$(normalize_endpoint "$ENDPOINT")"
log "服务端地址: $SERVER_URL"

# ---------- 系统检测 ----------
if command -v apt-get >/dev/null; then PM="apt";
elif command -v dnf >/dev/null; then PM="dnf";
elif command -v yum >/dev/null; then PM="yum";
elif command -v apk >/dev/null; then PM="apk";
else die "不支持的系统：未找到 apt/dnf/yum/apk"; fi
log "包管理器: $PM"

# ---------- Node.js ----------
need_node=0
if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$v" -ge 18 ]]; then log "Node.js 已安装: $(node -v)，跳过"; else need_node=1; fi
else
  need_node=1
fi

if [[ $need_node -eq 1 ]]; then
  log "安装 Node.js ${NODE_MAJOR}.x ..."
  case "$PM" in
    apt)
      apt-get update
      apt-get install -y --no-install-recommends ca-certificates curl gnupg
      NS_BASE="https://deb.nodesource.com"
      [[ $CHINA_MIRRORS -eq 1 ]] && NS_BASE="https://mirrors.tuna.tsinghua.edu.cn/nodesource"
      curl -fsSL "${NS_BASE}/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
      echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] ${NS_BASE}/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
      apt-get update
      apt-get install -y --no-install-recommends nodejs
      ;;
    dnf|yum) curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; "$PM" install -y nodejs ;;
    apk) apk add --no-cache nodejs npm ;;
  esac
  command -v node >/dev/null || die "Node.js 安装失败"
  log "Node.js 安装完成: $(node -v)"
fi

# ---------- 诊断工具 ----------
log "安装 ping / traceroute / mtr ..."
case "$PM" in
  apt) apt-get install -y --no-install-recommends iputils-ping traceroute mtr ;;
  dnf|yum) "$PM" install -y iputils traceroute mtr ;;
  apk) apk add --no-cache iputils traceroute mtr ;;
esac

# ---------- 下载 agent ----------
log "下载 agent（${REPO}@${BRANCH}）..."
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
CURL_AUTH=()
[[ -n "$GITHUB_TOKEN" ]] && CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
curl -fsSL "${CURL_AUTH[@]}" "$TARBALL_URL" -o "$TMPD/repo.tar.gz" \
  || die "下载失败（仓库为 private？加 --github-token 参数或把仓库公开）"
tar xzf "$TMPD/repo.tar.gz" -C "$TMPD"
SRC="$TMPD/${REPO##*/}-${BRANCH}/agent"
[[ -d "$SRC" ]] || die "压缩包中未找到 agent 目录"

# ---------- 安装到 /opt/lg-agent ----------
if systemctl is-active -q "$SERVICE_NAME" 2>/dev/null; then
  log "停止旧服务..."
  systemctl stop "$SERVICE_NAME"
fi
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$SRC/src" "$SRC/package.json" "$SRC/package-lock.json" "$INSTALL_DIR/"
cd "$INSTALL_DIR"
NPM_REG=()
[[ $CHINA_MIRRORS -eq 1 ]] && NPM_REG=(--registry=https://registry.npmmirror.com)
log "安装依赖（npm install --omit=dev）..."
npm install --omit=dev --no-audit --no-fund "${NPM_REG[@]}"

# ---------- systemd 服务 ----------
if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
  warn "未检测到 systemd，改用 nohup 后台运行（重启后需手动再跑一次）"
  pkill -f "node $INSTALL_DIR/src/index.js" 2>/dev/null || true
  SERVER_URL="$SERVER_URL" NODE_TOKEN="$TOKEN" nohup node "$INSTALL_DIR/src/index.js" \
    > "$INSTALL_DIR/agent.log" 2>&1 &
  log "已后台启动，日志: $INSTALL_DIR/agent.log"
  exit 0
fi

log "注册 systemd 服务..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Looking Glass Agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${INSTALL_DIR}
Environment=SERVER_URL=${SERVER_URL}
Environment=NODE_TOKEN=${TOKEN}
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active -q "$SERVICE_NAME"; then
  log "安装成功，服务运行中 ✅"
  log "查看状态: systemctl status $SERVICE_NAME"
  log "查看日志: journalctl -u $SERVICE_NAME -f"
  log "更新: 重新执行本脚本即可 | 卸载: $0 --uninstall"
else
  die "服务启动失败，查看日志: journalctl -u $SERVICE_NAME -n 50"
fi
