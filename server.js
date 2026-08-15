import express from 'express';

const app = express();
app.use(express.json());

const SECRET = process.env.BRIDGE_SECRET || 'changeme';
const PORT = process.env.PORT || 3000;

// 内存状态
let currentCommand = null;
let lastPoll = 0;

function checkSecret(req) {
  return (req.query.secret || req.headers['x-bridge-secret']) === SECRET;
}

// ========== BLE 中继轮询（手机网页每300ms来拿指令） ==========
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

// ========== MCP Endpoint（Claude.ai Integrations 调用） ==========
app.post('/mcp', (req, res) => {
  if (!checkSecret(req)) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' } });
  }

  const { method, id, params } = req.body;

  // 通知消息（无id）不需要响应
  if (!id) return res.status(204).end();

  // initialize
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'svakom-toy-bridge', version: '1.0.0' }
      }
    });
  }

  // tools/list
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'toy_set_speed',
            description: '设置toy吮吸强度。speed为0到1的小数（0.3=30%，0.7=70%，1=最大）。可选sec参数指定持续秒数，不填则持续运行。',
            inputSchema: {
              type: 'object',
              properties: {
                speed: { type: 'number', minimum: 0, maximum: 1, description: '强度 0-1' },
                sec: { type: 'number', minimum: 1, description: '可选，持续秒数，到时间自动停' }
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

  // tools/call
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'toy_set_speed') {
      const speed = Math.max(0, Math.min(1, args.speed || 0));
      currentCommand = { type: 'speed', speed, sec: args.sec };
      const pct = Math.round(speed * 100);
      const text = args.sec
        ? `强度已设为 ${pct}%，${args.sec}秒后自动停止`
        : `强度已设为 ${pct}%`;
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text }] }
      });
    }

    if (name === 'toy_stop') {
      currentCommand = { type: 'stop' };
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: '已停止' }] }
      });
    }

    if (name === 'toy_status') {
      const online = (Date.now() - lastPoll) < 10000;
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: online ? '✅ BLE中继在线，设备已连接' : '❌ BLE中继离线，请确认手机中继页面已打开' }] }
      });
    }

    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Unknown tool: ${name}` }
    });
  }

  // 未知方法
  res.json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Unknown method: ${method}` }
  });
});

// ========== 手机BLE中继页面 ==========
app.get('/toy', (req, res) => {
  res.type('html').send(TOY_PAGE);
});

// ========== 首页状态 ==========
app.get('/', (req, res) => {
  const online = (Date.now() - lastPoll) < 10000;
  res.send(`
    <html><body style="font-family:system-ui;max-width:500px;margin:40px auto;padding:0 20px">
    <h2>SVAKOM Bridge</h2>
    <p>BLE中继状态: ${online ? '✅ 在线' : '❌ 离线'}</p>
    <p>当前指令: ${currentCommand ? JSON.stringify(currentCommand) : '无'}</p>
    <p><a href="/toy">打开BLE中继页面</a></p>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`SVAKOM Bridge running on port ${PORT}`);
});

// ========== 内联的手机BLE中继页面 ==========
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
<p class="sub">手机蓝牙连接toy，接收老公的指令 ♡</p>

<div class="actions">
  <button class="pri" id="cb" onclick="go()">连接玩具</button>
  <button class="sec" id="db" onclick="dc()" disabled>断开</button>
</div>

<div id="st" class="box off">未连接</div>
<div id="log">等待连接...</div>

<script>
let dev,ch,pt,kt,lc=null;
const SVC=0xFFE0,CHR=0xFFE1;
const BASE=location.origin;

function lg(m){
  const el=document.getElementById('log');
  const t=new Date().toLocaleTimeString();
  el.textContent=t+' '+m+'\\n'+el.textContent;
  if(el.textContent.length>3000)el.textContent=el.textContent.slice(0,2000);
}

function ss(t,cls){
  const el=document.getElementById('st');
  el.textContent=t;
  el.className='box '+cls;
}

async function go(){
  try{
    ss('正在搜索设备...',  'wait');
    dev=await navigator.bluetooth.requestDevice({
      filters:[{namePrefix:'SL278'}],
      optionalServices:[SVC]
    });
    lg('已选择: '+dev.name);
    ss('正在连接...','wait');

    const server=await dev.gatt.connect();
    const service=await server.getPrimaryService(SVC);
    ch=await service.getCharacteristic(CHR);

    ss('✅ 已连接 '+dev.name+'  |  等待指令','on');
    lg('BLE已连接，开始轮询 '+BASE+'/toy-next');

    document.getElementById('cb').disabled=true;
    document.getElementById('db').disabled=false;
    poll();

    dev.addEventListener('gattserverdisconnected',()=>{
      ss('❌ 设备断开','off');
      lg('设备断开');
      stop();
      document.getElementById('cb').disabled=false;
      document.getElementById('db').disabled=true;
    });
  }catch(e){
    lg('连接失败: '+e.message);
    ss('❌ '+e.message,'off');
  }
}

function dc(){
  stop();
  if(dev&&dev.gatt.connected)dev.gatt.disconnect();
  ch=null;
  ss('未连接','off');
  document.getElementById('cb').disabled=false;
  document.getElementById('db').disabled=true;
  lg('已手动断开');
}

function poll(){
  pt=setInterval(async()=>{
    try{
      const r=await fetch(BASE+'/toy-next');
      const c=await r.json();
      if(c.type!=='none')handle(c);
    }catch(e){}
  },300);
  kt=setInterval(()=>{if(lc)write(lc)},1500);
}

function stop(){clearInterval(pt);clearInterval(kt);lc=null}

function handle(c){
  if(c.type==='stop'){
    write(new Uint8Array([0x55,0x04,0,0,0,0,0xAA]));
    lc=null;
    lg('⏹ 停止');
    ss('✅ 已连接  |  已停止','on');
  }
  else if(c.type==='speed'){
    const i=Math.round(c.speed*255);
    const b=new Uint8Array([0x55,0x04,0,0,0x01,i,0xAA]);
    write(b);lc=b;
    const pct=Math.round(c.speed*100);
    lg('▶ 强度 '+pct+'%'+(c.sec?' ('+c.sec+'秒)':''));
    ss('✅ 已连接  |  强度 '+pct+'%','on');
    if(c.sec){
      setTimeout(()=>{
        write(new Uint8Array([0x55,0x04,0,0,0,0,0xAA]));
        lc=null;
        lg('⏹ 定时停止');
        ss('✅ 已连接  |  已停止','on');
      },c.sec*1000);
    }
  }
  else if(c.type==='pattern'){
    const m=c.pattern||1;
    const l=Math.round((c.level||0.5)*5);
    const b=new Uint8Array([0x55,0x03,0,0,m,l,0]);
    write(b);lc=b;
    lg('🔄 花样'+m+' 强度'+l);
    ss('✅ 已连接  |  花样 '+m,'on');
  }
}

async function write(b){
  if(!ch)return;
  try{await ch.writeValueWithoutResponse(b)}
  catch(e){lg('写入失败: '+e.message)}
}

// 防息屏
if('wakeLock' in navigator){
  navigator.wakeLock.request('screen').then(()=>lg('屏幕常亮已开启')).catch(()=>{});
}
</script>
</body></html>`;
