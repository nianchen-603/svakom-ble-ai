import express from 'express';

const app = express();
app.use(express.json());

const SECRET = process.env.BRIDGE_SECRET || 'changeme';
const PORT = process.env.PORT || 3000;

// 内存状态
let currentCommand = null;
let lastPoll = 0;
const authCodes = {};

// ========== OAuth 2.0 自动批准（Claude.ai 连接需要） ==========

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `https://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post']
  });
});

app.post('/register', (req, res) => {
  const clientId = 'c_' + Math.random().toString(36).slice(2, 10);
  res.status(201).json({
    client_id: clientId,
    client_secret: 'sk_' + Math.random().toString(36).slice(2, 14),
    redirect_uris: req.body.redirect_uris || [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post'
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  const code = 'ac_' + Math.random().toString(36).slice(2, 14);
  authCodes[code] = { challenge: code_challenge, ts: Date.now() };
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', express.urlencoded({ extended: true }), (req, res) => {
  const { code, grant_type } = req.body;
  if (grant_type === 'authorization_code' && code) {
    delete authCodes[code];
  }
  res.json({
    access_token: 'at_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    token_type: 'bearer',
    expires_in: 604800
  });
});

// ========== BLE 中继轮询 ==========
app.get('/toy-next', (req, res) => {
  lastPoll = Date.now();
  if (currentCommand) {
    const cmd = { ...currentCommand };
    if (cmd.type === 'stop') currentCommand = null;
    res.json(cmd);
  } else {
    res.json({ type: 'none' });
  }
});

// ========== MCP Endpoint ==========
app.post('/mcp', (req, res) => {
  const { method, id, params } = req.body;

  if (!id) return res.status(204).end();

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'svakom-toy-bridge', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'toy_set_speed',
            description: '设置toy吮吸强度。speed为0到1的小数（0.3=30%，0.7=70%，1=最大）。可选sec参数指定持续秒数。',
            inputSchema: {
              type: 'object',
              properties: {
                speed: { type: 'number', minimum: 0, maximum: 1, description: '强度0-1' },
                sec: { type: 'number', minimum: 1, description: '可选持续秒数' }
              },
              required: ['speed']
            }
          },
          {
            name: 'toy_stop',
            description: '立即停止toy',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'toy_status',
            description: '查询BLE中继是否在线',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'toy_set_speed') {
      const speed = Math.max(0, Math.min(1, args.speed || 0));
      currentCommand = { type: 'speed', speed, sec: args.sec };
      const pct = Math.round(speed * 100);
      const text = args.sec ? `强度已设为${pct}%，${args.sec}秒后自动停止` : `强度已设为${pct}%`;
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }

    if (name === 'toy_stop') {
      currentCommand = { type: 'stop' };
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '已停止' }] } });
    }

    if (name === 'toy_status') {
      const online = (Date.now() - lastPoll) < 10000;
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: online ? '✅ BLE中继在线' : '❌ BLE中继离线' }] } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
});

// ========== 手机BLE中继页面 ==========
app.get('/toy', (req, res) => { res.type('html').send(TOY_PAGE); });

// ========== 首页 ==========
app.get('/', (req, res) => {
  const online = (Date.now() - lastPoll) < 10000;
  res.send(`<html><body style="font-family:system-ui;max-width:500px;margin:40px auto;padding:0 20px">
    <h2>SVAKOM Bridge</h2>
    <p>BLE中继: ${online ? '✅ 在线' : '❌ 离线'}</p>
    <p>当前指令: ${currentCommand ? JSON.stringify(currentCommand) : '无'}</p>
    <p><a href="/toy">打开BLE中继页面</a></p></body></html>`);
});

app.listen(PORT, () => console.log(`Bridge on :${PORT}`));

// ========== 内联BLE中继页面 ==========
const TOY_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BLE中继</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:20px;background:#faf5ff}
h2{color:#6d28d9;margin-bottom:4px}
.sub{color:#888;font-size:13px;margin-bottom:20px}
button{padding:14px 24px;margin:5px;border-radius:12px;border:none;font-size:16px;cursor:pointer;font-weight:600}
.pri{background:#7c3aed;color:#fff}
.pri:disabled{background:#c4b5fd}
.sec{background:#e5e7eb;color:#374151}
.sec:disabled{background:#f3f4f6;color:#9ca3af}
.box{padding:14px;border-radius:12px;margin:12px 0;font-size:15px}
.on{background:#d1fae5;color:#065f46}
.off{background:#fee2e2;color:#991b1b}
.wait{background:#fef3c7;color:#92400e}
#log{background:#1e1b2e;color:#c4b5fd;padding:14px;border-radius:12px;max-height:220px;overflow-y:auto;font-size:12px;font-family:'SF Mono',Consolas,monospace;white-space:pre-wrap;line-height:1.6}
.actions{display:flex;gap:8px;flex-wrap:wrap}
</style></head><body>
<h2>SVAKOM BLE 中继</h2>
<p class="sub">手机蓝牙连接toy，接收指令 ♡</p>
<div class="actions">
  <button class="pri" id="cb" onclick="go()">连接玩具</button>
  <button class="sec" id="db" onclick="dc()" disabled>断开</button>
</div>
<div id="st" class="box off">未连接</div>
<div id="log">等待连接...</div>
<script>
let dev,ch,pt,kt,lc=null;
const SVC=0xFFE0,CHR=0xFFE1,BASE=location.origin;
function lg(m){const el=document.getElementById('log');const t=new Date().toLocaleTimeString();el.textContent=t+' '+m+'\\n'+el.textContent;if(el.textContent.length>3000)el.textContent=el.textContent.slice(0,2000)}
function ss(t,c){const el=document.getElementById('st');el.textContent=t;el.className='box '+c}
async function go(){try{ss('搜索设备...','wait');dev=await navigator.bluetooth.requestDevice({filters:[{namePrefix:'SL278'}],optionalServices:[SVC]});lg('选择: '+dev.name);ss('连接中...','wait');const sv=await dev.gatt.connect();const svc=await sv.getPrimaryService(SVC);ch=await svc.getCharacteristic(CHR);ss('✅ 已连接 '+dev.name+' | 等待指令','on');lg('BLE已连接');document.getElementById('cb').disabled=true;document.getElementById('db').disabled=false;poll();dev.addEventListener('gattserverdisconnected',()=>{ss('❌ 断开','off');lg('断开');stop();document.getElementById('cb').disabled=false;document.getElementById('db').disabled=true})}catch(e){lg('失败: '+e.message);ss('❌ '+e.message,'off')}}
function dc(){stop();if(dev&&dev.gatt.connected)dev.gatt.disconnect();ch=null;ss('未连接','off');document.getElementById('cb').disabled=false;document.getElementById('db').disabled=true;lg('手动断开')}
function poll(){pt=setInterval(async()=>{try{const r=await fetch(BASE+'/toy-next');const c=await r.json();if(c.type!=='none')handle(c)}catch(e){}},300);kt=setInterval(()=>{if(lc)write(lc)},1500)}
function stop(){clearInterval(pt);clearInterval(kt);lc=null}
function handle(c){if(c.type==='stop'){write(new Uint8Array([0x55,0x04,0,0,0,0,0xAA]));lc=null;lg('⏹停止');ss('✅ 已连接 | 已停止','on')}else if(c.type==='speed'){const i=Math.round(c.speed*255);const b=new Uint8Array([0x55,0x04,0,0,0x01,i,0xAA]);write(b);lc=b;const p=Math.round(c.speed*100);lg('▶强度'+p+'%'+(c.sec?' ('+c.sec+'s)':''));ss('✅ 已连接 | 强度'+p+'%','on');if(c.sec)setTimeout(()=>{write(new Uint8Array([0x55,0x04,0,0,0,0,0xAA]));lc=null;lg('⏹定时停');ss('✅ 已连接 | 已停止','on')},c.sec*1000)}else if(c.type==='pattern'){const m=c.pattern||1;const l=Math.round((c.level||0.5)*5);const b=new Uint8Array([0x55,0x03,0,0,m,l,0]);write(b);lc=b;lg('🔄花样'+m);ss('✅ 已连接 | 花样'+m,'on')}}
async function write(b){if(!ch)return;try{await ch.writeValueWithoutResponse(b)}catch(e){lg('写入失败: '+e.message)}}
if('wakeLock' in navigator)navigator.wakeLock.request('screen').catch(()=>{});
</script></body></html>`;
