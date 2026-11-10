
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const {createResetToken,hashResetToken,resetExpiry,isStrongPassword,buildResetUrl}=require('./password-reset');
const {sendResetEmail}=require('./resend-email');
const nfseNacional=require('./nfse-nacional');

const ADMIN_EMAIL='admin@gestaomei.local';
const PASSWORD_RECOVERY_EMAIL=process.env.PASSWORD_RECOVERY_EMAIL||'';
const RESEND_API_KEY=process.env.RESEND_API_KEY||'';
const RESET_FROM_EMAIL=process.env.RESET_FROM_EMAIL||'Gestão MEI Pro <onboarding@resend.dev>';
const APP_BASE_URL=(process.env.APP_BASE_URL||'https://gestao-mei-pro.vercel.app').replace(/\/$/,'');
const ADMIN_SALT=process.env.ADMIN_SALT||'';
const PGMEI_URL='https://www8.receita.fazenda.gov.br/SIMPLESNACIONAL/Servicos/Grupo.aspx?grp=8';
const DAS_SERVICE_URL='https://www.gov.br/pt-br/servicos/emitir-das-para-pagamento-de-tributos-do-mei';
const SERPRO_BASE=process.env.SERPRO_BASE_URL||'https://gateway.apiserpro.serpro.gov.br';
function serproConfigured(){return Boolean(process.env.SERPRO_CONSUMER_KEY&&process.env.SERPRO_CONSUMER_SECRET&&process.env.SERPRO_CONTRATANTE&&process.env.SERPRO_AUTOR_PEDIDO)}
// Somente Produção Restrita (tpAmb=2): notas de teste, sem valor fiscal.
const NFSE_BASE_URL='https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional';
function nfseCertificate(){
  if(!process.env.NFSE_CERT_PFX_BASE64)return null;
  return nfseNacional.loadCertificate(process.env.NFSE_CERT_PFX_BASE64.replace(/\s+/g,''),process.env.NFSE_CERT_PASSWORD||'');
}
function nfseConfig(){
  let certificate={ok:false,error:'Configure NFSE_CERT_PFX_BASE64 (arquivo .pfx em base64) e NFSE_CERT_PASSWORD na Vercel.'};
  try{const c=nfseCertificate();if(c)certificate={ok:true,commonName:c.commonName,cnpj:c.cnpj,notAfter:c.notAfter,expired:c.notAfter<new Date()}}
  catch(e){certificate={ok:false,error:e.message}}
  return {environment:'producao_restrita',baseUrl:NFSE_BASE_URL,certificate,certificateConfigured:certificate.ok}
}

function dbUrl(){return process.env.POSTGRES_URL||process.env.DATABASE_URL||process.env.POSTGRES_URL_NON_POOLING||process.env.POSTGRES_PRISMA_URL||process.env.NEON_DATABASE_URL}
function secret(){return process.env.APP_SECRET||crypto.createHash('sha256').update((dbUrl()||'gestao-mei')+'|session').digest('hex')}
function sqlClient(){const u=dbUrl();if(!u)throw Error('Banco Neon não conectado');return neon(u)}
function parseCookies(req){const o={};for(const p of (req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1))}return o}
function send(res,s,d,t='application/json; charset=utf-8'){res.statusCode=s;res.setHeader('Content-Type',t);res.setHeader('Cache-Control','no-store');res.end(t.startsWith('application/json')?JSON.stringify(d):d)}
async function body(req){return await new Promise((ok,bad)=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6)bad(Error('Payload grande'))});req.on('end',()=>{try{ok(d?JSON.parse(d):{})}catch(e){bad(e)}});req.on('error',bad)})}
function hashPassword(p){if(!ADMIN_SALT)throw Error('ADMIN_SALT não configurado');return crypto.pbkdf2Sync(p,ADMIN_SALT,200000,32,'sha256').toString('hex')}
function tokenHash(t){return crypto.createHmac('sha256',secret()).update(t).digest('hex')}
async function init(sql){
 await sql`CREATE TABLE IF NOT EXISTS app_users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`;
 await sql`CREATE TABLE IF NOT EXISTS app_sessions(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`;
 await sql`CREATE TABLE IF NOT EXISTS password_reset_tokens(id SERIAL PRIMARY KEY,user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW())`;
 await sql`CREATE TABLE IF NOT EXISTS clients(id SERIAL PRIMARY KEY,cnpj TEXT UNIQUE NOT NULL,razao TEXT NOT NULL,fantasia TEXT,situacao TEXT,cep TEXT,municipio TEXT,uf TEXT,endereco TEXT,cnae TEXT,secundarias TEXT,telefone TEXT,email TEXT,created_at TIMESTAMPTZ DEFAULT NOW())`;
 await sql`CREATE TABLE IF NOT EXISTS revenues(id SERIAL PRIMARY KEY,client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,competence TEXT NOT NULL,amount NUMERIC(14,2) DEFAULT 0,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(client_id,competence))`;
 await sql`CREATE TABLE IF NOT EXISTS obligations(id SERIAL PRIMARY KEY,client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,kind TEXT NOT NULL,competence TEXT NOT NULL,due_date DATE,amount NUMERIC(14,2) DEFAULT 0,status TEXT DEFAULT 'Pendente',created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(client_id,kind,competence))`;
 await sql`CREATE TABLE IF NOT EXISTS nfse_drafts(
   id SERIAL PRIMARY KEY,
   client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
   environment TEXT NOT NULL DEFAULT 'producao_restrita',
   tomador_doc TEXT,
   tomador_nome TEXT,
   servico_descricao TEXT,
   valor NUMERIC(14,2) DEFAULT 0,
   data_prestacao DATE,
   municipio_prestacao TEXT,
   status TEXT DEFAULT 'Rascunho',
   chave_acesso TEXT,
   numero_nfse TEXT,
   xml_nfse TEXT,
   created_at TIMESTAMPTZ DEFAULT NOW(),
   updated_at TIMESTAMPTZ DEFAULT NOW()
 )`;
 await sql`ALTER TABLE nfse_drafts
   ADD COLUMN IF NOT EXISTS op_simp_nac INTEGER,
   ADD COLUMN IF NOT EXISTS c_trib_nac TEXT,
   ADD COLUMN IF NOT EXISTS c_loc_emi TEXT,
   ADD COLUMN IF NOT EXISTS c_loc_prestacao TEXT,
   ADD COLUMN IF NOT EXISTS serie TEXT,
   ADD COLUMN IF NOT EXISTS n_dps BIGINT,
   ADD COLUMN IF NOT EXISTS id_dps TEXT,
   ADD COLUMN IF NOT EXISTS dps_xml TEXT,
   ADD COLUMN IF NOT EXISTS erro TEXT`;
}
async function userFromReq(req,sql){
 const t=parseCookies(req).gmp_session;if(!t)return null;
 const h=tokenHash(t);
 const r=await sql`SELECT u.id,u.email,u.name FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=${h} AND s.expires_at>NOW()`;
 return r[0]||null
}
async function requireUser(req,res,sql){const u=await userFromReq(req,sql);if(!u){send(res,401,{error:'Não autenticado'});return null}return u}
const CSS=`:root{--bg:#f5f7f9;--txt:#17212b;--muted:#697682;--p:#0b6b5b;--dark:#102a2e;--bd:#dde6e9}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:var(--bg);color:var(--txt)}button,input,select,textarea{font:inherit}.layout{display:grid;grid-template-columns:230px 1fr;min-height:100vh}aside{background:var(--dark);color:#fff;padding:18px}.brand{font-size:22px;font-weight:800;margin-bottom:18px}.brand small{display:block;font-size:11px;font-weight:400;opacity:.7}.account{background:#ffffff12;padding:10px;border-radius:9px;margin-bottom:14px;font-size:13px}nav button{width:100%;border:0;background:transparent;color:#dce6e5;text-align:left;padding:11px;border-radius:8px;cursor:pointer}nav button:hover{background:#1b4246}main{padding:24px;max-width:1260px;width:100%}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.card{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:14px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.grid2,.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.full{grid-column:1/-1}.metric{font-size:27px;font-weight:800;margin-top:7px}.muted{font-size:13px;color:var(--muted)}.btn{border:0;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer}.primary{background:var(--p);color:#fff}.ghost{background:#fff;border:1px solid var(--bd);color:var(--txt)}label{display:block;color:var(--muted);font-size:13px}input,select,textarea{width:100%;padding:10px;border:1px solid var(--bd);border-radius:8px;margin-top:5px}textarea{min-height:80px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 8px;border-bottom:1px solid var(--bd);text-align:left}th{font-size:11px;text-transform:uppercase;color:var(--muted)}.badge{display:inline-block;padding:5px 8px;border-radius:13px;background:#e7f4ee;color:#086652;font-size:11px;font-weight:700}.warn{background:#fff1d5;color:#875900}.danger{background:#fde9e9;color:#a33636}.info{background:#eef6ff;border:1px solid #d8e8f8;padding:12px;border-radius:10px;margin-bottom:12px}.login{max-width:420px;margin:11vh auto;padding:15px}.error{background:#fdeaea;color:#9c3333;padding:10px;border-radius:8px;margin:10px 0}.actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:800px){.layout{display:block}.grid3,.grid2,.form2{grid-template-columns:1fr}.full{grid-column:auto}main{padding:15px}.top{align-items:flex-start;flex-direction:column}}`;
function html(){return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gestão MEI Pro</title><style>${CSS}</style></head><body><div id="root"><div class="login"><div class="card"><div class="brand" style="color:#102a2e">Gestão MEI Pro</div><p class="muted">Carregando...</p></div></div></div><script>
const $=id=>document.getElementById(id),root=$('root');let currentClient=null;
const money=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
async function api(p,o={}){const r=await fetch(p,{headers:{'Content-Type':'application/json'},...o});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Erro');return d}
function login(msg=''){root.innerHTML='<div class="login"><div class="card"><div class="brand" style="color:#102a2e">Gestão MEI Pro<small style="color:#697682">Acesso do escritório</small></div>'+(msg?'<div class="error">'+msg+'</div>':'')+'<form id="lf"><label>E-mail<input id="le" type="email" value="${ADMIN_EMAIL}" required></label><label>Senha<input id="lp" type="password" required></label><button class="btn primary">Entrar</button></form><button class="btn ghost" id="forgot" style="width:100%;margin-top:10px">Esqueceu sua senha?</button></div></div>';$('lf').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:JSON.stringify({email:$('le').value,password:$('lp').value})});boot()}catch(x){login(x.message)}};$('forgot').onclick=()=>forgotPassword()}
function forgotPassword(msg=''){root.innerHTML='<div class="login"><div class="card"><div class="brand" style="color:#102a2e">Recuperar senha<small style="color:#697682">Gestão MEI Pro</small></div>'+(msg?'<div class="info">'+msg+'</div>':'')+'<p class="muted">Informe o e-mail de acesso. O link será enviado ao e-mail de recuperação cadastrado.</p><form id="ff"><label>E-mail de acesso<input id="fe" type="email" value="${ADMIN_EMAIL}" required></label><button class="btn primary">Enviar link de recuperação</button></form><button class="btn ghost" id="backLogin" style="width:100%;margin-top:10px">Voltar ao login</button></div></div>';$('backLogin').onclick=()=>login();$('ff').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/password/forgot',{method:'POST',body:JSON.stringify({email:$('fe').value})});forgotPassword(d.message||'Se o usuário estiver cadastrado, enviaremos as instruções.')}catch(x){forgotPassword(x.message)}}}
function resetPassword(token,msg=''){root.innerHTML='<div class="login"><div class="card"><div class="brand" style="color:#102a2e">Criar nova senha<small style="color:#697682">Link de uso único</small></div>'+(msg?'<div class="error">'+msg+'</div>':'')+'<p class="muted">Use pelo menos 10 caracteres, com maiúscula, minúscula, número e símbolo.</p><form id="rf"><label>Nova senha<input id="rp1" type="password" minlength="10" required></label><label>Confirmar nova senha<input id="rp2" type="password" minlength="10" required></label><button class="btn primary">Salvar nova senha</button></form></div></div>';$('rf').onsubmit=async e=>{e.preventDefault();if($('rp1').value!==$('rp2').value)return resetPassword(token,'As senhas não coincidem.');try{await api('/api/password/reset',{method:'POST',body:JSON.stringify({token,password:$('rp1').value})});login('Senha alterada com sucesso. Entre com a nova senha.')}catch(x){resetPassword(token,x.message)}}}
function shell(u){root.innerHTML='<div class="layout"><aside><div class="brand">Gestão MEI Pro<small>Sistema operacional</small></div><div class="account"><b>'+u.name+'</b><br>Administrador</div><nav><button data-p="dash">Dashboard</button><button data-p="clients">Clientes</button><button data-p="new">Novo cliente</button><button data-p="das">DAS</button><button data-p="obs">DAS / DASN</button><button data-p="nfse">NFS-e</button><button id="logout">Sair</button></nav></aside><main id="main"></main></div>';document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>show(b.dataset.p));$('logout').onclick=async()=>{await api('/api/logout',{method:'POST'}).catch(()=>{});login()};show('dash')}
async function boot(){try{const d=await api('/api/me');shell(d.user)}catch{login()}}
async function show(p){const m=$('main');m.innerHTML='<p>Carregando...</p>';try{if(p==='dash')await dash();if(p==='clients')await clients();if(p==='new')newClient();if(p==='das')await das();if(p==='obs')await obligations();if(p==='nfse')nfse()}catch(e){m.innerHTML='<div class="error">'+e.message+'</div>'}}
async function dash(){const d=await api('/api/dashboard');$('main').innerHTML='<div class="top"><div><h1>Dashboard</h1><p class="muted">Dados gravados no Neon.</p></div><span class="badge">ONLINE</span></div><div class="grid3"><div class="card"><div class="muted">Clientes</div><div class="metric">'+d.clients+'</div></div><div class="card"><div class="muted">Faturamento '+d.year+'</div><div class="metric">'+money(d.revenue)+'</div></div><div class="card"><div class="muted">Pendências</div><div class="metric">'+d.pending+'</div></div></div>'}
async function clients(){const d=await api('/api/clients');$('main').innerHTML='<div class="top"><h1>Clientes</h1><button class="btn primary" id="newbtn">Novo cliente</button></div><div class="card"><table><tr><th>Empresa</th><th>CNPJ</th><th>CNAE</th></tr>'+d.clients.map(c=>'<tr><td>'+(c.fantasia||c.razao)+'</td><td>'+c.cnpj+'</td><td>'+(c.cnae||'-')+'</td></tr>').join('')+'</table></div>';$('newbtn').onclick=()=>show('new')}
function newClient(){$('main').innerHTML='<h1>Novo cliente</h1><p class="muted">Digite o CNPJ para preencher os dados automaticamente.</p><div class="card"><div class="form2"><label class="full">CNPJ<input id="cnpj"></label><div class="full actions"><button class="btn primary" id="consultar">Consultar CNPJ</button><button class="btn ghost" id="receita">Conferir na Receita Federal</button><span id="msg" class="muted"></span></div><label>Razão social<input id="razao"></label><label>Fantasia<input id="fantasia"></label><label>Situação<input id="situacao"></label><label>CEP<input id="cep"></label><label>Município<input id="municipio"></label><label>UF<input id="uf"></label><label class="full">Endereço<input id="endereco"></label><label class="full">CNAE<input id="cnae"></label><label class="full">Atividades secundárias<textarea id="secundarias"></textarea></label><label>Telefone<input id="telefone"></label><label>E-mail<input id="email"></label><div class="full"><button class="btn primary" id="save">Salvar cliente</button></div></div></div>';$('consultar').onclick=lookup;$('receita').onclick=()=>window.open('https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/','_blank','noopener');$('save').onclick=saveClient}
async function lookup(){$('msg').textContent='Consultando...';try{const d=await api('/api/cnpj?cnpj='+encodeURIComponent($('cnpj').value));['cnpj','razao','fantasia','situacao','cep','municipio','uf','endereco','cnae','secundarias','telefone','email'].forEach(k=>{if($(k))$(k).value=d[k]||''});$('msg').textContent='Dados carregados.'}catch(e){$('msg').textContent=e.message}}
async function saveClient(){const keys=['cnpj','razao','fantasia','situacao','cep','municipio','uf','endereco','cnae','secundarias','telefone','email'],o={};keys.forEach(k=>o[k]=$(k).value);const d=await api('/api/clients',{method:'POST',body:JSON.stringify(o)});currentClient=d.id;show('clients')}
async function das(){const c=await api('/api/clients');const si=await api('/api/serpro/status');const opts=c.clients.map(x=>'<option value="'+x.id+'">'+(x.fantasia||x.razao)+' — '+x.cnpj+'</option>').join('');$('main').innerHTML='<div class="top"><div><h1>DAS</h1><p class="muted">Controle mensal do MEI e acesso à consulta oficial.</p></div></div><div class="info"><b>Integra Contador / SERPRO:</b> '+(si.configured?'configurado para integração':'ainda não configurado. Cadastre as credenciais na Vercel para liberar a sincronização automática')+'.</div><div class="card"><label>Cliente<select id="dasclient">'+opts+'</select></label><br><div class="actions"><button class="btn primary" id="loadDas">Carregar DAS</button><button class="btn primary" id="syncDas">Sincronizar PGMEI 2026</button><button class="btn ghost" id="pgmei">Consultar no PGMEI</button><button class="btn ghost" id="emitir">Emitir DAS oficial</button></div></div><div id="dasbody"></div>';if(c.clients.length){$('dasclient').value=String(currentClient||c.clients[0].id);$('loadDas').onclick=loadDas;$('syncDas').onclick=syncDas;$('pgmei').onclick=()=>window.open('${PGMEI_URL}','_blank','noopener');$('emitir').onclick=()=>window.open('${DAS_SERVICE_URL}','_blank','noopener');await loadDas()}else{$('dasbody').innerHTML='<div class="card">Cadastre um cliente primeiro.</div>'}}
async function syncDas(){const id=Number($('dasclient').value);try{const d=await api('/api/serpro/sync?client_id='+id,{method:'POST'});alert(d.message||'Sincronização concluída');await loadDas()}catch(e){alert(e.message)}}
async function loadDas(){const id=Number($('dasclient').value);currentClient=id;const d=await api('/api/das?client_id='+id);$('dasbody').innerHTML='<div class="card"><h2>'+(d.client.fantasia||d.client.razao)+'</h2><p class="muted">CNPJ: '+d.client.cnpj+' • Ano '+d.year+'</p><table><tr><th>Competência</th><th>Vencimento</th><th>Valor registrado</th><th>Status interno</th></tr>'+d.months.map(x=>'<tr><td>'+x.competence+'</td><td>'+x.due_date+'</td><td>'+money(x.amount)+'</td><td><span class="badge '+(x.status==='Vencido'?'danger':x.status==='Pendente'?'warn':'')+'">'+x.status+'</span></td></tr>').join('')+'</table></div>'}
async function obligations(){const d=await api('/api/obligations');$('main').innerHTML='<h1>DAS / DASN</h1><div class="card"><table><tr><th>Cliente</th><th>Tipo</th><th>Competência</th><th>Status</th></tr>'+d.obligations.map(o=>'<tr><td>'+o.client_name+'</td><td>'+o.kind+'</td><td>'+o.competence+'</td><td>'+o.status+'</td></tr>').join('')+'</table></div>'}
const escH=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function nfseForm(){return{
   client_id:Number($('nfseClient').value),op_simp_nac:Number($('nfseOpSimp').value),
   tomador_doc:$('nfseTomadorDoc').value,tomador_nome:$('nfseTomadorNome').value,
   c_trib_nac:$('nfseCTrib').value,servico_descricao:$('nfseServico').value,valor:$('nfseValor').value,
   data_prestacao:$('nfseData').value,c_loc_emi:$('nfseLocEmi').value,c_loc_prestacao:$('nfseLocPrest').value
}}
async function nfseFillIbge(){
 const sel=$('nfseClient');const o=sel.options[sel.selectedIndex];if(!o)return;
 try{const d=await api('/api/cnpj?cnpj='+o.dataset.cnpj);if(d.codigo_ibge){$('nfseLocEmi').value=d.codigo_ibge;if(!$('nfseLocPrest').value)$('nfseLocPrest').value=d.codigo_ibge}}catch(e){}
}
async function nfse(){
 const cfg=await api('/api/nfse/status');
 const clients=await api('/api/clients');
 const opts=clients.clients.map(c=>'<option value="'+c.id+'" data-cnpj="'+escH(c.cnpj)+'">'+escH(c.fantasia||c.razao)+' — '+escH(c.cnpj)+'</option>').join('');
 const cert=cfg.certificate;
 $('main').innerHTML=
 '<div class="top"><div><h1>NFS-e Nacional</h1><p class="muted">Ambiente: Produção Restrita (homologação) — notas sem valor fiscal</p></div>'+
 (cert&&cert.ok?'<span class="badge">Certificado configurado</span>':'<span class="badge warn">Certificado pendente</span>')+'</div>'+
 '<div class="info"><b>Como funciona:</b> o sistema monta a DPS, assina com o certificado A1 da empresa prestadora e envia para a Sefin Nacional. O certificado precisa ser do mesmo CNPJ do prestador.</div>'+
 '<div class="grid2"><div class="card"><h2>Certificado e conexão</h2>'+
 '<p><b>Ambiente:</b> Produção Restrita</p>'+
 (cert&&cert.ok?'<p><b>Titular:</b> '+escH(cert.commonName)+'</p><p><b>CNPJ:</b> '+escH(cert.cnpj||'não identificado')+'</p><p><b>Validade:</b> '+escH(String(cert.notAfter||'').slice(0,10))+'</p>':
  '<p class="muted">'+escH(cert&&cert.error||'Configure NFSE_CERT_PFX_BASE64 e NFSE_CERT_PASSWORD na Vercel.')+'</p>')+
 '<button class="btn ghost" id="nfseTest">Testar conexão</button><p id="nfseStatus" class="muted"></p></div>'+
 '<div class="card"><h2>Nova NFS-e de teste</h2>'+
 '<label>Prestador<select id="nfseClient">'+opts+'</select></label><br>'+
 '<label>Situação no Simples Nacional<select id="nfseOpSimp"><option value="3">Optante ME/EPP</option><option value="2">MEI</option><option value="1">Não optante</option></select></label><br>'+
 '<div class="form2"><label>CPF/CNPJ do tomador<input id="nfseTomadorDoc"></label>'+
 '<label>Nome do tomador<input id="nfseTomadorNome"></label>'+
 '<label>Código de tributação nacional<input id="nfseCTrib" placeholder="040205"></label>'+
 '<label>Valor do serviço<input id="nfseValor" type="number" step="0.01" min="0.01"></label>'+
 '<label class="full">Descrição do serviço<textarea id="nfseServico"></textarea></label>'+
 '<label>Data da prestação (competência)<input id="nfseData" type="date"></label>'+
 '<label>IBGE do município do prestador<input id="nfseLocEmi" placeholder="7 dígitos"></label>'+
 '<label>IBGE do local da prestação<input id="nfseLocPrest" placeholder="7 dígitos"></label></div><br>'+
 '<div class="actions"><button class="btn ghost" id="nfseSave">Salvar rascunho</button><button class="btn primary" id="nfseEmit">Emitir nota de teste</button></div>'+
 '<p id="nfseMsg" class="muted"></p></div></div>'+
 '<div class="card"><h2>Rascunhos e notas</h2><div id="nfseList">Carregando...</div></div>';
 $('nfseClient').onchange=()=>{$('nfseLocEmi').value='';nfseFillIbge()};nfseFillIbge();
 $('nfseTest').onclick=async()=>{$('nfseStatus').textContent='Testando...';try{const d=await api('/api/nfse/test',{method:'POST',body:'{}'});$('nfseStatus').textContent=d.message}catch(e){$('nfseStatus').textContent=e.message}};
 $('nfseSave').onclick=async()=>{try{await api('/api/nfse/drafts',{method:'POST',body:JSON.stringify(nfseForm())});$('nfseMsg').textContent='Rascunho salvo com sucesso.';await loadNfseList()}catch(e){$('nfseMsg').textContent=e.message}};
 $('nfseEmit').onclick=async()=>{const b=$('nfseEmit');b.disabled=true;$('nfseMsg').textContent='Assinando e enviando para a NFS-e Nacional...';try{const d=await api('/api/nfse/emitir',{method:'POST',body:JSON.stringify(nfseForm())});$('nfseMsg').textContent=d.message||'Enviado.'}catch(e){$('nfseMsg').textContent=e.message}finally{b.disabled=false;await loadNfseList()}};
 await loadNfseList();
}
async function nfseEmitDraft(id){
 if(!confirm('Emitir a NFS-e de teste deste rascunho?'))return;
 try{const d=await api('/api/nfse/emitir',{method:'POST',body:JSON.stringify({id})});alert(d.message||'Enviado.')}catch(e){alert(e.message)}
 await loadNfseList();
}
async function loadNfseList(){
 const d=await api('/api/nfse/drafts');
 const badge=s=>s==='Autorizada'?'':(s==='Rejeitada'?'danger':'warn');
 $('nfseList').innerHTML='<table><tr><th>Prestador</th><th>Tomador</th><th>Valor</th><th>Competência</th><th>Status</th><th>Nº / chave</th><th></th></tr>'+
 d.items.map(x=>'<tr><td>'+escH(x.client_name)+'</td><td>'+escH(x.tomador_nome||x.tomador_doc||'-')+'</td><td>'+money(x.valor)+'</td><td>'+escH(String(x.data_prestacao||'-').slice(0,10))+'</td>'+
  '<td><span class="badge '+badge(x.status)+'">'+escH(x.status)+'</span>'+(x.erro?'<div class="muted" style="max-width:320px;white-space:normal">'+escH(x.erro)+'</div>':'')+'</td>'+
  '<td>'+(x.numero_nfse?'<b>'+escH(x.numero_nfse)+'</b><br>':'')+'<span class="muted" style="word-break:break-all">'+escH(x.chave_acesso||'')+'</span></td>'+
  '<td>'+(x.status==='Autorizada'?'<a class="btn ghost" href="/api/nfse/xml?id='+x.id+'">XML</a>':(x.status==='Rascunho'||x.status==='Rejeitada'?'<button class="btn ghost" onclick="nfseEmitDraft('+x.id+')">Emitir</button>':''))+'</td></tr>').join('')+
 '</table>';
}
const resetToken=new URLSearchParams(location.search).get('reset_token');if(resetToken)resetPassword(resetToken);else boot().catch(e=>login(e.message));
</script></body></html>`}

async function insertNfseDraft(sql,b){
 const r=await sql`INSERT INTO nfse_drafts(
   client_id,environment,tomador_doc,tomador_nome,servico_descricao,valor,
   data_prestacao,municipio_prestacao,status,op_simp_nac,c_trib_nac,c_loc_emi,c_loc_prestacao
 ) VALUES(
   ${Number(b.client_id)},'producao_restrita',${String(b.tomador_doc||'').replace(/\D/g,'')},
   ${b.tomador_nome||''},${b.servico_descricao||''},${Number(b.valor)||0},
   ${b.data_prestacao||null},${b.c_loc_prestacao||b.municipio_prestacao||''},'Rascunho',
   ${Number(b.op_simp_nac)||2},${String(b.c_trib_nac||'').replace(/\D/g,'')},
   ${String(b.c_loc_emi||'').replace(/\D/g,'')},${String(b.c_loc_prestacao||'').replace(/\D/g,'')}
 ) RETURNING id`;
 return r[0].id;
}
module.exports=async(req,res)=>{
 try{
  const sql=sqlClient();await init(sql);const u=new URL(req.url,'https://x.local'),p=u.pathname;
  if(p==='/health')return send(res,200,{status:'ok',database:'connected'});
  if(p==='/'&&req.method==='GET')return send(res,200,html(),'text/html; charset=utf-8');
  if(p==='/api/cnpj'){
   const cnpj=String(u.searchParams.get('cnpj')||'').replace(/\D/g,'');
   if(cnpj.length!==14)return send(res,400,{error:'CNPJ inválido'});

   function normalizeCnpj(d,source){
     const secundarios=(d.cnaes_secundarios||d.cnae_secundario||[]).map(x=>x.descricao||x.texto||'').filter(Boolean).join(', ');
     const endereco=[d.descricao_tipo_de_logradouro,d.logradouro,d.numero,d.complemento,d.bairro].filter(Boolean).join(' ');
     return {
       cnpj:d.cnpj||cnpj,
       razao:d.razao_social||d.nome_empresarial||'',
       fantasia:d.nome_fantasia||d.titulo_estabelecimento||'',
       situacao:d.descricao_situacao_cadastral||d.situacao_cadastral||'',
       cep:d.cep||'',
       municipio:d.municipio||'',
       uf:d.uf||'',
       endereco,
       cnae:d.cnae_fiscal_descricao||d.descricao_cnae_fiscal||'',
       codigo_ibge:String(d.codigo_municipio_ibge||'').replace(/\D/g,''),
       secundarias:secundarios,
       telefone:[d.ddd_telefone_1,d.ddd_telefone_2].filter(Boolean).join(' / '),
       email:d.email||'',
       fonte:source
     };
   }

   try{
     const r1=await fetch('https://brasilapi.com.br/cnpj/v1/'+cnpj,{
       headers:{Accept:'application/json','User-Agent':'Gestao-MEI-Pro/1.4'}
     });
     if(r1.ok)return send(res,200,normalizeCnpj(await r1.json(),'BrasilAPI'));
   }catch(e){}

   try{
     const r2=await fetch('https://minhareceita.org/'+cnpj,{
       headers:{Accept:'application/json','User-Agent':'Gestao-MEI-Pro/1.4'}
     });
     if(r2.ok)return send(res,200,normalizeCnpj(await r2.json(),'Minha Receita'));
   }catch(e){}

   return send(res,404,{error:'CNPJ não encontrado nas fontes automáticas. Use “Conferir na Receita Federal”.'});
  }
  if(p==='/api/password/forgot'&&req.method==='POST'){
   const b=await body(req),email=String(b.email||'').trim().toLowerCase();
   const generic={ok:true,message:'Se o usuário estiver cadastrado, enviaremos as instruções para redefinir a senha.'};
   if(email!==ADMIN_EMAIL)return send(res,200,generic);
   if(!RESEND_API_KEY||!PASSWORD_RECOVERY_EMAIL)return send(res,503,{error:'Recuperação por e-mail ainda não configurada. Configure RESEND_API_KEY e PASSWORD_RECOVERY_EMAIL na Vercel.'});
   const rows=await sql`SELECT id FROM app_users WHERE email=${ADMIN_EMAIL}`;const user=rows[0];
   if(!user)return send(res,200,generic);
   const raw=createResetToken(),hash=hashResetToken(raw),expires=resetExpiry();
   await sql`DELETE FROM password_reset_tokens WHERE user_id=${user.id} OR expires_at<=NOW() OR used_at IS NOT NULL`;
   await sql`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(${user.id},${hash},${expires.toISOString()})`;
   try{await sendResetEmail({apiKey:RESEND_API_KEY,from:RESET_FROM_EMAIL,to:PASSWORD_RECOVERY_EMAIL,resetUrl:buildResetUrl(APP_BASE_URL,raw)})}
   catch(e){await sql`DELETE FROM password_reset_tokens WHERE token_hash=${hash}`;return send(res,502,{error:'Não foi possível enviar o e-mail de recuperação agora. Tente novamente em alguns minutos.'})}
   return send(res,200,generic);
  }
  if(p==='/api/password/reset'&&req.method==='POST'){
   const b=await body(req),raw=String(b.token||''),password=String(b.password||'');
   if(!isStrongPassword(password))return send(res,400,{error:'A senha precisa ter ao menos 10 caracteres, com maiúscula, minúscula, número e símbolo.'});
   const hash=hashResetToken(raw),rows=await sql`SELECT t.id token_id,t.user_id FROM password_reset_tokens t WHERE t.token_hash=${hash} AND t.used_at IS NULL AND t.expires_at>NOW()`;const item=rows[0];
   if(!item)return send(res,400,{error:'Este link é inválido ou expirou. Solicite uma nova recuperação de senha.'});
   const newHash=hashPassword(password);
   await sql`UPDATE app_users SET password_hash=${newHash} WHERE id=${item.user_id}`;
   await sql`UPDATE password_reset_tokens SET used_at=NOW() WHERE id=${item.token_id}`;
   await sql`DELETE FROM password_reset_tokens WHERE user_id=${item.user_id} AND id<>${item.token_id}`;
   await sql`DELETE FROM app_sessions WHERE user_id=${item.user_id}`;
   return send(res,200,{ok:true});
  }
  if(p==='/api/login'&&req.method==='POST'){
   const b=await body(req),rows=await sql`SELECT id,email,name,password_hash FROM app_users WHERE email=${String(b.email||'').toLowerCase()}`,user=rows[0];
   if(!user||hashPassword(String(b.password||''))!==user.password_hash)return send(res,401,{error:'Usuário ou senha inválidos'});
   const raw=crypto.randomBytes(32).toString('hex'),h=tokenHash(raw);await sql`INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES(${user.id},${h},NOW()+INTERVAL '7 days')`;res.setHeader('Set-Cookie',`gmp_session=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);return send(res,200,{ok:true});
  }
  if(p==='/api/logout'&&req.method==='POST'){const t=parseCookies(req).gmp_session;if(t)await sql`DELETE FROM app_sessions WHERE token_hash=${tokenHash(t)}`;res.setHeader('Set-Cookie','gmp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return send(res,200,{ok:true})}
  const user=await requireUser(req,res,sql);if(!user)return;
  if(p==='/api/me')return send(res,200,{user});
  if(p==='/api/dashboard'){const year=String(new Date().getFullYear()),c=(await sql`SELECT COUNT(*)::int n FROM clients`)[0].n,r=(await sql`SELECT COALESCE(SUM(amount),0)::float total FROM revenues WHERE competence LIKE ${year+'-%'}`)[0].total,pe=(await sql`SELECT COUNT(*)::int n FROM obligations WHERE status='Pendente'`)[0].n;return send(res,200,{clients:c,revenue:r,pending:pe,year})}
  if(p==='/api/clients'&&req.method==='GET'){return send(res,200,{clients:await sql`SELECT * FROM clients ORDER BY razao`})}
  if(p==='/api/clients'&&req.method==='POST'){const b=await body(req),cnpj=String(b.cnpj||'').replace(/\D/g,'');if(cnpj.length!==14||!String(b.razao||'').trim())return send(res,400,{error:'Informe CNPJ e razão social'});const r=await sql`INSERT INTO clients(cnpj,razao,fantasia,situacao,cep,municipio,uf,endereco,cnae,secundarias,telefone,email) VALUES(${cnpj},${b.razao},${b.fantasia||''},${b.situacao||''},${b.cep||''},${b.municipio||''},${b.uf||''},${b.endereco||''},${b.cnae||''},${b.secundarias||''},${b.telefone||''},${b.email||''}) RETURNING id`;return send(res,200,{id:r[0].id})}

  if(p==='/api/serpro/status'){
   return send(res,200,{configured:serproConfigured(),base:SERPRO_BASE,required:['SERPRO_CONSUMER_KEY','SERPRO_CONSUMER_SECRET','SERPRO_CONTRATANTE','SERPRO_AUTOR_PEDIDO'],certificate_required:true});
  }
  if(p==='/api/serpro/sync'&&req.method==='POST'){
   const id=Number(u.searchParams.get('client_id'));const cs=await sql`SELECT * FROM clients WHERE id=${id}`;if(!cs[0])return send(res,404,{error:'Cliente não encontrado'});
   if(!serproConfigured())return send(res,412,{error:'Integra Contador ainda não configurado na Vercel. Cadastre Consumer Key, Consumer Secret, CNPJ do contratante e autor do pedido.'});
   return send(res,501,{error:'Credenciais detectadas. Falta configurar o certificado e a autorização/procuração para habilitar a chamada oficial do PGMEI.'});
  }
  if(p==='/api/obligations'){return send(res,200,{obligations:await sql`SELECT o.*,COALESCE(c.fantasia,c.razao) client_name FROM obligations o JOIN clients c ON c.id=o.client_id ORDER BY o.due_date NULLS LAST`})}
  if(p==='/api/das'){
   const id=Number(u.searchParams.get('client_id'));const cs=await sql`SELECT * FROM clients WHERE id=${id}`;if(!cs[0])return send(res,404,{error:'Cliente não encontrado'});
   const year=new Date().getFullYear(),rows=await sql`SELECT * FROM obligations WHERE client_id=${id} AND kind='DAS' AND competence LIKE ${String(year)+'-%'}`;const by={};for(const r of rows)by[r.competence]=r;
   const months=[];for(let m=1;m<=12;m++){const comp=year+'-'+String(m).padStart(2,'0'),due=new Date(year,m,20),iso=due.toISOString().slice(0,10),r=by[comp];let status=r?.status||'Sem registro';if(r&&r.status!=='Pago'&&due<new Date())status='Vencido';months.push({competence:comp,due_date:iso,amount:Number(r?.amount||0),status})}
   return send(res,200,{client:cs[0],year,months,official:{pgmei:PGMEI_URL,emitir:DAS_SERVICE_URL}})
  }

  if(p==='/api/nfse/status'&&req.method==='GET'){
    return send(res,200,nfseConfig());
  }
  if(p==='/api/nfse/test'&&req.method==='POST'){
    let cert;
    try{cert=nfseCertificate()}catch(e){return send(res,409,{error:e.message})}
    if(!cert)return send(res,409,{error:'Certificado digital A1 ainda não configurado (NFSE_CERT_PFX_BASE64 e NFSE_CERT_PASSWORD).'});
    try{
      const r=await nfseNacional.testConnection({baseUrl:NFSE_BASE_URL,cert});
      return send(res,r.ok?200:502,r.ok?{ok:true,message:r.message}:{error:r.message});
    }catch(e){return send(res,502,{error:'Falha ao conectar na NFS-e Nacional: '+String(e.message||e).slice(0,200)})}
  }
  if(p==='/api/nfse/drafts'&&req.method==='GET'){
    const items=await sql`SELECT n.id,n.client_id,n.tomador_doc,n.tomador_nome,n.servico_descricao,n.valor,n.data_prestacao,
      n.status,n.chave_acesso,n.numero_nfse,n.erro,n.c_trib_nac,n.n_dps,n.serie,n.created_at,COALESCE(c.fantasia,c.razao) client_name
      FROM nfse_drafts n JOIN clients c ON c.id=n.client_id
      ORDER BY n.created_at DESC LIMIT 100`;
    return send(res,200,{items});
  }
  if(p==='/api/nfse/drafts'&&req.method==='POST'){
    const b=await body(req);
    if(!Number(b.client_id)||!String(b.servico_descricao||'').trim()||!Number(b.valor)){
      return send(res,400,{error:'Informe prestador, descrição do serviço e valor.'});
    }
    const id=await insertNfseDraft(sql,b);
    return send(res,200,{id,ok:true});
  }
  if(p==='/api/nfse/emitir'&&req.method==='POST'){
    const b=await body(req);
    let cert;
    try{cert=nfseCertificate()}catch(e){return send(res,409,{error:e.message})}
    if(!cert)return send(res,409,{error:'Emissão bloqueada: configure primeiro o certificado digital A1 da empresa (NFSE_CERT_PFX_BASE64 e NFSE_CERT_PASSWORD).'});
    if(cert.notAfter<new Date())return send(res,409,{error:'O certificado digital A1 está vencido.'});
    let id=Number(b.id);
    if(!id){
      if(!Number(b.client_id)||!String(b.servico_descricao||'').trim()||!Number(b.valor)){
        return send(res,400,{error:'Informe prestador, serviço e valor.'});
      }
      id=await insertNfseDraft(sql,b);
    }
    const rows=await sql`SELECT n.*,c.cnpj FROM nfse_drafts n JOIN clients c ON c.id=n.client_id WHERE n.id=${id}`;
    const d=rows[0];
    if(!d)return send(res,404,{error:'Rascunho não encontrado.'});
    const cnpj=String(d.cnpj||'').replace(/\D/g,'');
    if(!cert.cnpj||cert.cnpj.slice(0,8)!==cnpj.slice(0,8)){
      await sql`UPDATE nfse_drafts SET erro=${'O certificado configurado ('+(cert.cnpj||'CNPJ não identificado')+') não pertence ao prestador '+cnpj+'.'},updated_at=NOW() WHERE id=${id}`;
      return send(res,409,{error:'O certificado configurado ('+(cert.cnpj||'CNPJ não identificado')+') não pertence ao CNPJ do prestador ('+cnpj+'). A NFS-e Nacional exige o e-CNPJ da própria empresa.'});
    }
    // Trava contra envio duplicado: só um envio por vez para o mesmo rascunho.
    const prev=d.status;
    const lock=await sql`UPDATE nfse_drafts SET status='Enviando',updated_at=NOW() WHERE id=${id} AND status IN ('Rascunho','Rejeitada') RETURNING id`;
    if(!lock[0])return send(res,409,{error:'Esta nota já foi enviada (situação: '+prev+').'});
    const serie=String(process.env.NFSE_SERIE||'1');
    const seq=await sql`SELECT COALESCE(MAX(n_dps),0)+1 AS n FROM nfse_drafts WHERE client_id=${d.client_id} AND serie=${serie} AND environment='producao_restrita'`;
    const nDPS=Number(seq[0].n);
    const dCompet=d.data_prestacao instanceof Date?d.data_prestacao.toISOString().slice(0,10):String(d.data_prestacao||'').slice(0,10);
    let built,signed;
    try{
      built=nfseNacional.buildDps({
        tpAmb:2,versao:process.env.NFSE_DPS_VERSAO||'1.00',prestadorCnpj:cnpj,opSimpNac:d.op_simp_nac||2,
        cLocEmi:d.c_loc_emi,cLocPrestacao:d.c_loc_prestacao,serie,nDPS,dCompet,
        tomadorDoc:d.tomador_doc,tomadorNome:d.tomador_nome,cTribNac:d.c_trib_nac,xDescServ:d.servico_descricao,vServ:d.valor
      });
      signed=nfseNacional.signDps(built.xml,built.id,cert,process.env.NFSE_SIGNATURE_ALG||'sha1');
    }catch(e){
      await sql`UPDATE nfse_drafts SET status=${prev},erro=${e.message},updated_at=NOW() WHERE id=${id}`;
      return send(res,400,{error:e.message});
    }
    await sql`UPDATE nfse_drafts SET serie=${serie},n_dps=${nDPS},id_dps=${built.id},dps_xml=${signed},erro=NULL,updated_at=NOW() WHERE id=${id}`;
    let r;
    try{r=await nfseNacional.transmitDps({baseUrl:NFSE_BASE_URL,cert,signedXml:signed})}
    catch(e){
      const msg='Falha de comunicação com a NFS-e Nacional: '+String(e.message||e).slice(0,200)+'. Confira no portal se a nota foi gerada antes de reenviar.';
      await sql`UPDATE nfse_drafts SET status='Falha de comunicação',erro=${msg},updated_at=NOW() WHERE id=${id}`;
      return send(res,502,{error:msg});
    }
    if(r.ok){
      const alertas=r.alertas&&r.alertas.length?'Alertas: '+r.alertas.join(' | '):null;
      await sql`UPDATE nfse_drafts SET status='Autorizada',chave_acesso=${r.chaveAcesso},numero_nfse=${r.numero},xml_nfse=${r.xml},erro=${alertas},updated_at=NOW() WHERE id=${id}`;
      return send(res,200,{ok:true,id,chaveAcesso:r.chaveAcesso,numero:r.numero,message:'NFS-e de teste autorizada'+(r.numero?' nº '+r.numero:'')+'. Chave: '+r.chaveAcesso}); 
    }
    await sql`UPDATE nfse_drafts SET status='Rejeitada',erro=${r.error},updated_at=NOW() WHERE id=${id}`;
    return send(res,422,{error:'Rejeitada pela NFS-e Nacional: '+r.error});
  }
  if(p==='/api/nfse/xml'&&req.method==='GET'){
    const id=Number(u.searchParams.get('id'));
    const rows=await sql`SELECT chave_acesso,xml_nfse FROM nfse_drafts WHERE id=${id}`;
    if(!rows[0]||!rows[0].xml_nfse)return send(res,404,{error:'XML não disponível.'});
    res.setHeader('Content-Disposition','attachment; filename="NFSe_'+String(rows[0].chave_acesso||id).replace(/[^0-9A-Za-z]/g,'')+'.xml"');
    return send(res,200,rows[0].xml_nfse,'application/xml; charset=utf-8');
  }

  return send(res,404,{error:'Rota não encontrada'});
 }catch(e){console.error(e);return send(res,500,{error:'Erro interno: '+String(e.message||e).slice(0,160)})}
}
