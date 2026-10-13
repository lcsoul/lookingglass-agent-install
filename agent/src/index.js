import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import os from 'node:os';
import iconv from 'iconv-lite';
import { pathToFileURL } from 'node:url';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080/ws/agent';
const NODE_TOKEN = process.env.NODE_TOKEN || '';
const VERSION = '1.2.0';
export const AGENT_VERSION = VERSION;
const MAX_SESSION_MS = parseInt(process.env.MAX_SESSION_MS || '180000', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '10', 10);
// 目标地址白名单校验（与服务端双重校验，纵深防御）
const TARGET_RE = /^[a-zA-Z0-9._:-]{1,253}$/;

// Windows 适配标记（命令参数、输出编码均据此切换）
const IS_WIN = process.platform === 'win32';

// 供 Electron 托盘读取的连接状态：idle/connecting/online/offline/disabled/error
const agentStatus = { state: 'idle', nodeName: '', serverUrl: SERVER_URL };
export function getAgentStatus() { return { ...agentStatus }; }

// ---------- 连接保活与重连自愈（适配 ESA/CDN 等多层代理） ----------
// 应用层心跳：agent 定期发送 heartbeat，server 回 ack。数据帧流过边缘节点可重置 idle 计时器，
// 防止长连接因空闲被 ESA 断开（WS 协议层 ping 帧不被所有 CDN 计入数据传输）。
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
// ack 超时：超过此时长未收到 ack，认定连接异常（可能被单侧断开），主动重连
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 2 + 10000;
// 重连退避上限：指数增长至此封顶（避免频繁重连触发边缘节点速率限制/临时封禁）
const MAX_RECONNECT_DELAY = parseInt(process.env.MAX_RECONNECT_DELAY || '60000', 10);
// 连续失败冷却：达到阈值后等待 COOLDOWN_MS 再重试，让边缘节点的临时封禁过期
const FAIL_COOLDOWN_THRESHOLD = parseInt(process.env.FAIL_COOLDOWN_THRESHOLD || '8', 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000', 10);
// 节点被管理员停用时的探活间隔：低频连接，便于重新启用后自动恢复（agent 在 NAT 后无法被主动唤醒）
const PROBE_INTERVAL = parseInt(process.env.PROBE_INTERVAL || '600000', 10);

if (!NODE_TOKEN) {
  console.warn('[agent] 警告：未设置 NODE_TOKEN，将无法通过服务端认证');
}

let ws = null;
let reconnectDelay = 1000;
let failCount = 0; // 连续失败计数（成功注册后重置）
let disabled = false; // 节点被管理员停用，进入休眠探活模式
let lastAckTs = 0; // 最近一次收到 heartbeat_ack 的时间
let heartbeatTimer = null;
let pendingTimer = null; // 重连 / 冷却 / 探活定时器（统一引用，便于清理）
const sessions = new Map(); // sessionId -> { proc, timer }
let cachedPublicIp = null; // 启动时探测一次，重连直接复用，不再重复请求外部服务
let lastManualDetectTs = 0; // 上次手动触发探测的时间（服务端下发 detect_public_ip）

/**
 * 收集本机可用协议地址（控制台据此展示节点 IPv4/IPv6 支持情况）。
 * 注意：容器内无全局 v6 地址时说明不具备 v6 连通性（需 host 网络或 Docker 开启 IPv6）。
 */
function collectAddrs() {
  const ipv4 = [];
  const ipv6 = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it.internal) continue;
        const fam = it.family;
        if (fam === 'IPv4' || fam === 4) {
          ipv4.push(it.address);
        } else if ((fam === 'IPv6' || fam === 6) && !it.address.toLowerCase().startsWith('fe80:')) {
          ipv6.push(it.address); // 过滤链路本地地址
        }
      }
    }
  } catch {
    /* 忽略采集失败 */
  }
  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

/**
 * 探测公网出口 IP（容器网卡多为内网地址，公网 IP 需向外部查询）。
 * 主用 ipify，失败回退 ip.sb；单源超时 6 秒，整体不阻塞注册（并行+超时兜底）。
 * ip.sb 官方文档要求：必须带自定义 User-Agent（默认 UA 会被边缘节点拦截返回 403）。
 */
const IP_DETECT_UA = `lookingglass-agent/${VERSION}`;
function fetchPublicIp(url, wantV6, timeoutMs = 6000) {
  return (async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': IP_DETECT_UA } });
      clearTimeout(t);
      if (!r.ok) return null;
      const ip = (await r.text()).trim();
      const ok = wantV6
        ? /^[0-9a-fA-F:]{2,45}$/.test(ip) && ip.includes(':')
        : /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
      return ok ? ip : null;
    } catch {
      return null;
    }
  })();
}

async function detectPublicIps() {
  // 注意：必须用协议专用域名。api.ipify.org 在双栈主机上会优先走 IPv6 解析，
  // 返回 v6 地址导致 v4 格式校验失败；api4/api6、api-ipv4/api-ipv6 的 DNS 只返回对应族的记录
  const [v4, v6] = await Promise.all([
    (async () => (await fetchPublicIp('https://api4.ipify.org', false)) || (await fetchPublicIp('https://api-ipv4.ip.sb/ip', false)))(),
    (async () => (await fetchPublicIp('https://api6.ipify.org', true)) || (await fetchPublicIp('https://api-ipv6.ip.sb/ip', true)))(),
  ]);
  if (v4) console.log(`[agent] 公网 IPv4: ${v4}`);
  if (v6) console.log(`[agent] 公网 IPv6: ${v6}`);
  return { v4, v6 };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * 构造测试命令（参数以数组传递，不经过 shell，避免注入）
 */
function buildCommand(testType, protocol, target, platform = process.platform) {
  const v6 = protocol === 'ipv6';
  const win = platform === 'win32';
  if (testType === 'ping') {
    // Windows ping：-n 次数，-w 超时（毫秒）；-4/-6 在 Win10+ 可用
    if (win) return { cmd: 'ping', args: [v6 ? '-6' : '-4', '-n', '4', '-w', '2000', target] };
    return { cmd: 'ping', args: [v6 ? '-6' : '-4', '-c', '4', '-W', '2', target] };
  }
  if (testType === 'mtr') {
    if (win) return null; // Windows 无原生 mtr，调用方需给出明确提示
    // mtr：报告模式（-r），宽表（-w），不反向解析（-n），10 轮探测
    return { cmd: 'mtr', args: [v6 ? '-6' : '-4', '-n', '-r', '-w', '-c', '10', target] };
  }
  // traceroute：-I 用 ICMP 探测（与本地命令行行为一致，到对端即停），
  // -n 不反向解析、-q 1 每跳一次、-m 30 最大跳数
  // Windows 用 tracert（默认即 ICMP 探测，-d 不解析，-h 最大跳数）
  if (win) return { cmd: 'tracert', args: ['-d', '-w', '2000', '-h', '30', ...(v6 ? ['-6'] : []), target] };
  return { cmd: 'traceroute', args: [v6 ? '-6' : '-4', '-I', '-n', '-w', '2', '-q', '1', '-m', '30', target] };
}
// 导出供单测验证 Windows 分支（platform 参数可注入）
export { buildCommand };

/**
 * Windows 中文版 cmd 默认输出 GBK，直接 toString('utf8') 会乱码；
 * 先按 UTF-8 解，出现替换符则回退 GBK（英文系统纯 ASCII 不受影响）。
 */
function decodeChunk(buf) {
  if (!IS_WIN) return buf.toString();
  const s = buf.toString('utf8');
  return s.includes('\uFFFD') ? iconv.decode(buf, 'gbk') : s;
}

function killSession(sessionId, reason) {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(sessionId);
  try { s.proc.kill('SIGKILL'); } catch {}
  if (reason) send({ type: 'output', sessionId, requestId: s.requestId, data: `\n[agent] ${reason}\n` });
}

function startSession(msg) {
  const { sessionId, requestId, testType, protocol, target } = msg;

  if (!sessionId || !requestId) return;
  if (!TARGET_RE.test(String(target || ''))) {
    return send({ type: 'error', sessionId, requestId, message: '目标地址格式无效' });
  }
  if (sessions.size >= MAX_CONCURRENT) {
    return send({ type: 'error', sessionId, requestId, message: `节点并发任务已达上限 (${MAX_CONCURRENT})，请稍后重试` });
  }

  const cmdInfo = buildCommand(testType, protocol, target);
  if (!cmdInfo) {
    return send({ type: 'error', sessionId, requestId, message: '该节点为 Windows 系统，不支持 mtr 测试，请使用 Ping 或路由追踪' });
  }
  const { cmd, args } = cmdInfo;

  let proc;
  try {
    proc = spawn(cmd, args);
  } catch (e) {
    return send({ type: 'error', sessionId, requestId, message: `命令启动失败: ${e.message}` });
  }

  const timer = setTimeout(() => killSession(sessionId, `任务超时 (${MAX_SESSION_MS / 1000}s)，已强制终止`), MAX_SESSION_MS);
  sessions.set(sessionId, { proc, timer, requestId });

  let settled = false;
  const settle = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sessions.delete(sessionId);
    fn();
  };

  send({ type: 'output', sessionId, requestId, data: `$ ${cmd} ${args.join(' ')}\n` });
  proc.stdout.on('data', (d) => send({ type: 'output', sessionId, requestId, data: decodeChunk(d) }));
  proc.stderr.on('data', (d) => send({ type: 'output', sessionId, requestId, data: decodeChunk(d) }));
  proc.on('error', (e) => settle(() => send({ type: 'error', sessionId, requestId, message: `执行失败: ${e.message}` })));
  proc.on('close', (code) => settle(() => send({ type: 'done', sessionId, requestId, code })));
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearPending() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/** 启动应用层心跳：定期发送 heartbeat，并检测 ack 超时（被 ESA 单侧断开时主动重连） */
function startHeartbeat() {
  clearHeartbeat();
  // lastAckTs 由 registered 时重置为 0、收到 ack 时更新；为 0 时不检测超时，
  // 兼容不回应用层心跳的旧版 server（此时 heartbeat 仅作保活数据帧，仍可防 ESA idle 断开）
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 仅在曾收到过 ack 时检测超时：连接可能已被边缘节点单侧断开，主动 terminate 触发重连
    if (lastAckTs > 0 && Date.now() - lastAckTs > HEARTBEAT_TIMEOUT) {
      console.warn('[agent] 心跳 ack 超时，连接可能已失效，主动断开重连');
      try { ws.terminate(); } catch {}
      return;
    }
    send({ type: 'heartbeat' });
  }, HEARTBEAT_INTERVAL);
}

/** 异常断开后的重连调度：指数退避 + 连续失败冷却 */
function scheduleReconnect() {
  failCount += 1;
  // 连续失败超阈值：进入冷却，避免频繁重连触发边缘节点速率限制 / 临时封禁
  if (failCount >= FAIL_COOLDOWN_THRESHOLD) {
    console.warn(`[agent] 连续失败 ${failCount} 次，冷却 ${COOLDOWN_MS / 1000}s 后再试`);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      reconnectDelay = 1000;
      failCount = 0;
      connect();
    }, COOLDOWN_MS);
    return;
  }
  console.log(`[agent] ${reconnectDelay / 1000}s 后重连（第 ${failCount} 次失败）...`);
  pendingTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function connect() {
  console.log(`[agent] 正在连接服务端: ${SERVER_URL}`);
  agentStatus.state = 'connecting';
  agentStatus.serverUrl = SERVER_URL;
  ws = new WebSocket(SERVER_URL);

  ws.on('open', async () => {
    reconnectDelay = 1000;
    // 公网出口 IP 只在进程启动时探测一次，重连直接复用缓存，避免频繁请求外部 IP 服务被拉黑
    const pub = cachedPublicIp || { v4: null, v6: null };
    send({
      type: 'register',
      token: NODE_TOKEN,
      version: VERSION,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      addrs: collectAddrs(),
      publicIpv4: pub.v4,
      publicIpv6: pub.v6,
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'registered':
        failCount = 0;
        disabled = false; // 成功注册说明节点已被重新启用
        agentStatus.state = 'online';
        agentStatus.nodeName = msg.name || '';
        lastAckTs = 0; // 重置，等待本轮连接的 ack（未收到则不检测超时，兼容旧 server）
        console.log(`[agent] 注册成功，节点: ${msg.name} (${msg.nodeId})`);
        startHeartbeat();
        break;
      case 'register_error':
        console.error(`[agent] 注册失败: ${msg.error}`);
        agentStatus.state = 'error';
        break;
      case 'disabled':
        // 服务端告知节点已被停用：进入休眠探活模式
        disabled = true;
        agentStatus.state = 'disabled';
        clearHeartbeat();
        console.log(`[agent] 节点已被停用（${msg.reason || '管理员操作'}），进入休眠探活模式`);
        break;
      case 'heartbeat_ack':
        lastAckTs = Date.now();
        break;
      case 'exec':
        startSession(msg);
        break;
      case 'kill':
        killSession(msg.sessionId, '任务已被用户停止');
        break;
      case 'detect_public_ip': {
        // 管理员手动触发刷新：节流 60 秒，防止外部 IP 服务被刷
        const now = Date.now();
        if (now - lastManualDetectTs < 60000) {
          console.log('[agent] 手动探测 IP 被节流（60s 内已探测过）');
          send({ type: 'public_ip', publicIpv4: cachedPublicIp?.v4 ?? null, publicIpv6: cachedPublicIp?.v6 ?? null, throttled: true });
          break;
        }
        lastManualDetectTs = now;
        console.log('[agent] 收到手动刷新公网 IP 指令，开始探测…');
        detectPublicIps().then((pub) => {
          cachedPublicIp = pub;
          send({ type: 'public_ip', publicIpv4: pub.v4, publicIpv6: pub.v6 });
        }).catch(() => {
          send({ type: 'public_ip', publicIpv4: null, publicIpv6: null, error: '探测失败' });
        });
        break;
      }
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? String(reason) : '';
    console.log(`[agent] 连接断开 (code=${code}${reasonStr ? ', reason=' + reasonStr : ''})`);
    if (code === 4003) {
      // 服务端拒绝重复注册：该节点已有 agent 在线（先到先得）。降频重试避免刷屏；
      // 若旧 agent 之后停掉，本进程会在某次重试中自动接管。
      console.warn('[agent] 注册被拒绝：该节点已有另一个 agent 在线。请检查是否重复启动了 agent（容器起了两个？同一 token 配到多台机器？），只保留一个。如需迁移节点请先停掉旧 agent。');
      reconnectDelay = Math.max(reconnectDelay, 30000);
    }
    // 连接断开时终止所有进行中的任务，避免孤儿进程
    for (const sessionId of [...sessions.keys()]) killSession(sessionId, '与服务端连接断开');
    clearHeartbeat();
    ws = null;
    if (agentStatus.state !== 'disabled') agentStatus.state = 'offline';
    if (disabled) {
      // 停用导致的断开：低频探活，等待管理员重新启用
      console.log(`[agent] 节点停用中，${PROBE_INTERVAL / 1000}s 后探活...`);
      pendingTimer = setTimeout(connect, PROBE_INTERVAL);
      return;
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[agent] 连接错误: ${err.message}`);
  });
}

// 进程启动时探测一次公网出口 IP，之后重连复用缓存，连接期间不再请求外部服务
export async function startAgent() {
  cachedPublicIp = await detectPublicIps().catch(() => ({ v4: null, v6: null }));
  connect();
}

// 直接用 node 运行时（CLI / Docker）：自动启动；
// 被 Electron 主进程 import 时，由宿主在配好环境变量后调用 startAgent()
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) startAgent();
