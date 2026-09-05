const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function collect(env) {
  if (!env.NEXTDNS_API_KEY || !env.NEXTDNS_PROFILE_ID) {
    await env.DB.prepare('UPDATE sync_state SET last_sync=?, last_error=? WHERE id=1')
      .bind(new Date().toISOString(), 'NEXTDNS_API_KEY / NEXTDNS_PROFILE_ID não configurados')
      .run();
    return { ok: false, setupRequired: true };
  }

  let cursor = null;
  let received = 0;
  let pages = 0;

  try {
    do {
      const url = new URL(`https://api.nextdns.io/profiles/${encodeURIComponent(env.NEXTDNS_PROFILE_ID)}/logs`);
      url.searchParams.set('limit', '500');
      if (cursor) url.searchParams.set('cursor', cursor);

      const response = await fetch(url, {
        headers: { 'X-Api-Key': env.NEXTDNS_API_KEY, Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`NextDNS ${response.status}: ${(await response.text()).slice(0, 180)}`);

      const payload = await response.json();
      const rows = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload) ? payload : []);
      const statements = [];

      for (const row of rows) {
        const ts = row.timestamp || row.time || new Date().toISOString();
        const domain = row.domain || row.qname || row.query?.name || 'unknown';
        const queryType = row.query_type || row.type || row.query?.type || '';
        const status = row.status || row.action || '';
        const clientName = row.client_name || row.client?.name || '';
        const clientIp = row.client_ip || row.client?.ip || '';
        const protocol = row.protocol || '';
        const reasons = Array.isArray(row.reasons) ? row.reasons.join(', ') : (row.reason || row.reasons || '');
        const eventKey = [ts, domain, queryType, clientName, clientIp, status].join('|');

        statements.push(env.DB.prepare(`
          INSERT OR IGNORE INTO logs(event_key,ts,domain,query_type,status,client_name,client_ip,protocol,reasons,raw)
          VALUES(?,?,?,?,?,?,?,?,?,?)
        `).bind(eventKey, ts, domain, queryType, status, clientName, clientIp, protocol, reasons, JSON.stringify(row)));
      }

      if (statements.length) await env.DB.batch(statements);
      received += rows.length;
      pages += 1;
      cursor = payload?.meta?.pagination?.cursor || payload?.meta?.cursor || null;
      if (pages >= 10) cursor = null;
    } while (cursor);

    await env.DB.prepare('UPDATE sync_state SET last_sync=?, last_error=NULL WHERE id=1')
      .bind(new Date().toISOString()).run();
    return { ok: true, received, pages };
  } catch (error) {
    const message = String(error?.message || error);
    await env.DB.prepare('UPDATE sync_state SET last_sync=?, last_error=? WHERE id=1')
      .bind(new Date().toISOString(), message).run();
    return { ok: false, error: message };
  }
}

async function stats(env) {
  const [total, blocked, top, clients, sync] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) n FROM logs').first(),
    env.DB.prepare("SELECT COUNT(*) n FROM logs WHERE lower(status)='blocked'").first(),
    env.DB.prepare('SELECT domain, COUNT(*) count FROM logs GROUP BY domain ORDER BY count DESC LIMIT 8').all(),
    env.DB.prepare("SELECT client_name name, COUNT(*) count FROM logs WHERE client_name!='' GROUP BY client_name ORDER BY count DESC LIMIT 6").all(),
    env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first()
  ]);
  const n = total?.n || 0;
  const b = blocked?.n || 0;
  return { total: n, blocked: b, allowed: Math.max(0, n - b), topDomains: top.results || [], clients: clients.results || [], sync: sync || {} };
}

async function logs(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(10, Number(url.searchParams.get('limit') || 100)));
  const q = (url.searchParams.get('q') || '').trim();
  const fields = 'id,ts,domain,query_type,status,client_name,client_ip,protocol,reasons';
  const result = q
    ? await env.DB.prepare(`SELECT ${fields} FROM logs WHERE domain LIKE ? OR client_name LIKE ? ORDER BY ts DESC LIMIT ?`).bind(`%${q}%`, `%${q}%`, limit).all()
    : await env.DB.prepare(`SELECT ${fields} FROM logs ORDER BY ts DESC LIMIT ?`).bind(limit).all();
  return result.results || [];
}

const HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NextDNS Cyber Monitor</title><style>
:root{--cyan:#32f5ff;--green:#13f7a3;--pink:#ff2f7d;--line:#12323d}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 70% 0,#08222c,#03080c 42%);color:#d9fbff;font:14px ui-monospace,Consolas,monospace}.wrap{max-width:1450px;margin:auto;padding:18px}.top,.card,.panel{border:1px solid var(--line);background:#061018e8;box-shadow:inset 0 0 24px #00eaff08}.top{display:flex;justify-content:space-between;align-items:center;padding:17px}.brand{font-size:22px;font-weight:800;letter-spacing:2px;color:var(--cyan);text-shadow:0 0 12px #33f3ff88}.muted{color:#6fa7b5;font-size:11px;letter-spacing:1.3px}.online{color:var(--green)}.warn{color:#ffcc66}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0}.card,.panel{padding:15px}.num{font-size:30px;margin-top:8px}.cyan{color:var(--cyan)}.green{color:var(--green)}.pink{color:var(--pink)}.grid{display:grid;grid-template-columns:2fr 1fr;gap:12px}h3{margin:0 0 12px;color:#9befff;font-size:13px}.bars{display:flex;align-items:end;gap:5px;height:125px}.bar{flex:1;min-height:5px;background:linear-gradient(var(--cyan),#0c7480)}.bar:nth-child(5n){background:linear-gradient(var(--pink),#7c153c)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #0c2630;font-size:12px}th{color:#59d9e9;font-size:11px}.search{display:flex;gap:8px;margin-bottom:10px}input,button{background:#05131a;color:#c9fbff;border:1px solid #17414d;padding:10px;font:inherit}input{flex:1}button{color:var(--cyan)}.list{display:grid;gap:8px}.row{display:grid;grid-template-columns:1fr auto;gap:10px}.meter{height:6px;background:#0b222b;margin-top:4px}.meter i{display:block;height:100%;background:var(--pink)}.badge{padding:3px 6px;border:1px solid #1c4954;border-radius:4px}.badge.blocked{color:var(--pink);border-color:#8b2048}.badge.allowed{color:var(--green);border-color:#167c58}@media(max-width:850px){.cards{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column;gap:8px}}
</style></head><body><div class="wrap"><div class="top"><div><div class="brand">NEXTDNS // CYBER MONITOR</div><div class="muted">CLOUDFLARE EDGE SECURITY CONSOLE</div></div><div id="state" class="online">● SYSTEM ONLINE</div></div><div class="cards"><div class="card"><div class="muted">TOTAL QUERIES</div><div id="total" class="num cyan">0</div></div><div class="card"><div class="muted">BLOCKED</div><div id="blocked" class="num pink">0</div></div><div class="card"><div class="muted">ALLOWED</div><div id="allowed" class="num green">0</div></div><div class="card"><div class="muted">LAST SYNC</div><div id="sync" style="margin-top:12px">--</div></div></div><div class="grid"><div class="panel"><h3>DNS ACTIVITY // LIVE</h3><div id="bars" class="bars"></div></div><div class="panel"><h3>TOP DOMAINS</h3><div id="top" class="list"></div></div><div class="panel"><h3>RECENT DNS REQUESTS</h3><div class="search"><input id="q" placeholder="search domain or client"><button onclick="loadLogs()">FILTER</button><button onclick="doSync()">SYNC</button></div><div style="overflow:auto"><table><thead><tr><th>TIME</th><th>CLIENT</th><th>DOMAIN</th><th>TYPE</th><th>STATUS</th></tr></thead><tbody id="rows"></tbody></table></div></div><div class="panel"><h3>CLIENTS</h3><div id="clients" class="list"></div></div></div></div><script>
const F=n=>Number(n||0).toLocaleString('pt-BR'),E=s=>{const d=document.createElement('div');d.textContent=s??'';return d.innerHTML},G=async(p,o)=>(await fetch(p,o)).json();async function loadStats(){const x=await G('/api/stats');total.textContent=F(x.total);blocked.textContent=F(x.blocked);allowed.textContent=F(x.allowed);sync.textContent=x.sync?.last_sync?new Date(x.sync.last_sync).toLocaleString('pt-BR'):'aguardando';state.textContent=x.sync?.last_error?'● SETUP REQUIRED':'● SYSTEM ONLINE';state.className=x.sync?.last_error?'warn':'online';const m=Math.max(1,...x.topDomains.map(v=>v.count));top.innerHTML=x.topDomains.map(v=>'<div><div class="row"><span>'+E(v.domain)+'</span><b>'+F(v.count)+'</b></div><div class="meter"><i style="width:'+Math.round(v.count/m*100)+'%"></i></div></div>').join('')||'<span class="muted">Sem dados ainda</span>';clients.innerHTML=x.clients.map(v=>'<div class="row"><span>'+E(v.name||'unknown')+'</span><b class="green">'+F(v.count)+'</b></div>').join('')||'<span class="muted">Sem clientes</span>';bars.innerHTML=Array.from({length:34},()=>'<i class="bar" style="height:'+(20+Math.random()*80)+'%"></i>').join('')}async function loadLogs(){const x=await G('/api/logs?limit=120&q='+encodeURIComponent(q.value));rows.innerHTML=x.map(v=>'<tr><td>'+new Date(v.ts).toLocaleTimeString('pt-BR')+'</td><td>'+E(v.client_name||v.client_ip||'-')+'</td><td>'+E(v.domain)+'</td><td>'+E(v.query_type||'-')+'</td><td><span class="badge '+(String(v.status).toLowerCase()==='blocked'?'blocked':'allowed')+'">'+E(v.status||'allowed')+'</span></td></tr>').join('')}async function doSync(){state.textContent='● SYNCING';await G('/api/sync',{method:'POST'});await loadStats();await loadLogs()}loadStats();loadLogs();setInterval(()=>{loadStats();loadLogs()},30000);
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stats') return json(await stats(env));
    if (url.pathname === '/api/logs') return json(await logs(request, env));
    if (url.pathname === '/api/sync' && request.method === 'POST') return json(await collect(env));
    if (url.pathname === '/health') return json({ ok: true, db: !!env.DB, nextdnsConfigured: !!(env.NEXTDNS_API_KEY && env.NEXTDNS_PROFILE_ID) });
    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(collect(env));
  }
};
