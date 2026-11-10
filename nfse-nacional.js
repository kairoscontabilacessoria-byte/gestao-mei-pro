// Emissão de NFS-e pelo Sistema Nacional (Sefin Nacional):
// monta a DPS, assina (XMLDSig) com o certificado A1 e transmite via mTLS.
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const forge = require('node-forge');

const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ALGS = {
  sha1: { sig: NS_DSIG + 'rsa-sha1', digest: NS_DSIG + 'sha1', node: 'RSA-SHA1', hash: 'sha1' },
  sha256: { sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', digest: 'http://www.w3.org/2001/04/xmlenc#sha256', node: 'RSA-SHA256', hash: 'sha256' }
};

const digits = v => String(v ?? '').replace(/\D/g, '');
// Escapes compatíveis com a canonicalização C14N, para que o XML gerado já seja a forma canônica.
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const el = (name, content) => `<${name}>${content}</${name}>`;
const txt = (name, value) => el(name, escText(value));
const cleanText = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Valor do serviço inválido.');
  return n.toFixed(2);
}

// Data/hora de Brasília (UTC-03:00), um minuto no passado para não ser rejeitada como futura.
function dhEmiBrasilia(now = new Date()) {
  const t = new Date(now.getTime() - 60_000 - 3 * 3600_000);
  return t.toISOString().slice(0, 19) + '-03:00';
}

function buildDpsId({ cLocEmi, tpInsc, inscFed, serie, nDPS }) {
  return 'DPS' + cLocEmi + tpInsc + String(inscFed).padStart(14, '0') + String(serie).padStart(5, '0') + String(nDPS).padStart(15, '0');
}

function validateDps(d) {
  const errs = [];
  if (digits(d.prestadorCnpj).length !== 14) errs.push('CNPJ do prestador inválido');
  if (!/^\d{7}$/.test(digits(d.cLocEmi))) errs.push('Código IBGE do município do prestador deve ter 7 dígitos');
  if (!/^\d{7}$/.test(digits(d.cLocPrestacao))) errs.push('Código IBGE do local da prestação deve ter 7 dígitos');
  if (!/^\d{6}$/.test(digits(d.cTribNac))) errs.push('Código de tributação nacional deve ter 6 dígitos (ex.: 04.02.05 → 040205)');
  if (![1, 2, 3].includes(Number(d.opSimpNac))) errs.push('Situação no Simples Nacional inválida');
  if (!/^[0-9]{1,5}$/.test(String(d.serie))) errs.push('Série da DPS inválida');
  if (!/^[1-9][0-9]{0,14}$/.test(String(d.nDPS))) errs.push('Número da DPS inválido');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.dCompet || ''))) errs.push('Informe a data da prestação');
  const desc = cleanText(d.xDescServ);
  if (!desc) errs.push('Informe a descrição do serviço');
  if (desc.length > 2000) errs.push('Descrição do serviço acima de 2000 caracteres');
  const tdoc = digits(d.tomadorDoc);
  if (tdoc && tdoc.length !== 11 && tdoc.length !== 14) errs.push('CPF/CNPJ do tomador inválido');
  if (tdoc && !cleanText(d.tomadorNome)) errs.push('Informe o nome do tomador');
  if (!(Number(d.vServ) > 0)) errs.push('Valor do serviço inválido');
  if (errs.length) throw new Error(errs.join('; ') + '.');
}

// Monta o XML da DPS (sem assinatura) conforme o leiaute nacional.
function buildDps(d) {
  validateDps(d);
  const tpAmb = String(d.tpAmb || 2);
  const versao = d.versao || '1.00';
  const cnpj = digits(d.prestadorCnpj);
  const cLocEmi = digits(d.cLocEmi);
  const id = buildDpsId({ cLocEmi, tpInsc: 2, inscFed: cnpj, serie: d.serie, nDPS: d.nDPS });
  const op = Number(d.opSimpNac);

  const regTrib = txt('opSimpNac', op) + (op === 3 ? txt('regApTribSN', d.regApTribSN || 1) : '') + txt('regEspTrib', d.regEspTrib || 0);
  const prest = el('prest', txt('CNPJ', cnpj) + el('regTrib', regTrib));

  const tdoc = digits(d.tomadorDoc);
  const toma = tdoc ? el('toma', txt(tdoc.length === 14 ? 'CNPJ' : 'CPF', tdoc) + txt('xNome', cleanText(d.tomadorNome).slice(0, 300))) : '';

  const serv = el('serv',
    el('locPrest', txt('cLocPrestacao', digits(d.cLocPrestacao))) +
    el('cServ', txt('cTribNac', digits(d.cTribNac)) + txt('xDescServ', cleanText(d.xDescServ))));

  const totTrib = d.pTotTribSN && op === 3
    ? txt('pTotTribSN', Number(d.pTotTribSN).toFixed(2))
    : txt('indTotTrib', 0);
  const valores = el('valores',
    el('vServPrest', txt('vServ', money(d.vServ))) +
    el('trib', el('tribMun', txt('tribISSQN', 1) + txt('tpRetISSQN', d.tpRetISSQN || 1)) + el('totTrib', totTrib)));

  const inf = txt('tpAmb', tpAmb) + txt('dhEmi', d.dhEmi || dhEmiBrasilia()) + txt('verAplic', (d.verAplic || 'GestaoMEIPro-1.0').slice(0, 20)) +
    txt('serie', d.serie) + txt('nDPS', d.nDPS) + txt('dCompet', d.dCompet) + txt('tpEmit', 1) + txt('cLocEmi', cLocEmi) +
    prest + toma + serv + valores;

  const infDps = `<infDPS Id="${escAttr(id)}">${inf}</infDPS>`;
  const xml = `<DPS xmlns="${NS_NFSE}" versao="${escAttr(versao)}">${infDps}</DPS>`;
  return { id, xml };
}

// Lê o .pfx/.p12 e devolve chave e certificado em PEM, com o CNPJ do titular.
function loadCertificate(pfx, password) {
  const buf = Buffer.isBuffer(pfx) ? pfx : Buffer.from(String(pfx || ''), 'base64');
  if (!buf.length) throw new Error('Certificado A1 não configurado.');
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary'))), false, String(password || ''));
  } catch (e) {
    throw new Error('Não foi possível abrir o certificado A1: verifique o arquivo e a senha.');
  }
  const keyBag = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])][0];
  if (!keyBag || !keyBag.key) throw new Error('O arquivo do certificado não contém a chave privada.');
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map(b => b.cert).filter(Boolean);
  const key = keyBag.key;
  const cert = certs.find(c => c.publicKey.n && c.publicKey.n.equals(key.n)) || certs[0];
  if (!cert) throw new Error('O arquivo do certificado não contém o certificado.');
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const cn = (cert.subject.getField('CN') || {}).value || '';
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(cert),
    certB64: Buffer.from(der, 'binary').toString('base64'),
    commonName: cn,
    cnpj: extractCnpj(der, cn),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter
  };
}

// e-CNPJ ICP-Brasil: OID 2.16.76.1.3.3 no SubjectAltName; alternativa: "RAZAO:CNPJ" no CN.
function extractCnpj(derBinary, cn) {
  const oid = '\x06\x05\x60\x4c\x01\x03\x03';
  const i = derBinary.indexOf(oid);
  if (i >= 0) {
    const m = derBinary.slice(i + oid.length, i + oid.length + 40).match(/\d{14}/);
    if (m) return m[0];
  }
  const m = String(cn).match(/:(\d{14})\b/);
  return m ? m[1] : '';
}

// Assinatura XMLDSig envelopada sobre infDPS (C14N inclusivo).
function signDps(xml, id, cert, alg = 'sha1') {
  const a = ALGS[alg] || ALGS.sha1;
  const start = xml.indexOf('<infDPS ');
  const end = xml.indexOf('</infDPS>') + '</infDPS>'.length;
  if (start < 0 || end < start) throw new Error('XML da DPS inválido.');
  const canonical = `<infDPS xmlns="${NS_NFSE}"` + xml.slice(start + '<infDPS'.length, end);
  const digest = crypto.createHash(a.hash).update(canonical, 'utf8').digest('base64');
  const signedInfoBody = `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${a.sig}"></SignatureMethod>` +
    `<Reference URI="#${escAttr(id)}"><Transforms><Transform Algorithm="${NS_DSIG}enveloped-signature"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${a.digest}"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference>`;
  const signatureValue = crypto.sign(a.node, Buffer.from(`<SignedInfo xmlns="${NS_DSIG}">${signedInfoBody}</SignedInfo>`, 'utf8'), cert.keyPem).toString('base64');
  const signature = `<Signature xmlns="${NS_DSIG}"><SignedInfo>${signedInfoBody}</SignedInfo>` +
    `<SignatureValue>${signatureValue}</SignatureValue><KeyInfo><X509Data><X509Certificate>${cert.certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
  return '<?xml version="1.0" encoding="UTF-8"?>' + xml.slice(0, end) + signature + xml.slice(end);
}

const gzipB64 = s => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const gunzipB64 = s => zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8');

function request({ method, url, cert, body, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      key: cert.keyPem, cert: cert.certPem,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* resposta não-JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado na comunicação com a NFS-e Nacional.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function describeErrors(r) {
  const j = r.json || {};
  const list = j.erros || j.Erros || j.erro || j.Erro || [];
  const arr = Array.isArray(list) ? list : [list];
  const msgs = arr.filter(Boolean).map(e => [e.Codigo || e.codigo, e.Descricao || e.descricao, e.Complemento || e.complemento].filter(Boolean).join(' - '));
  if (msgs.length) return msgs.join(' | ');
  if (j.message || j.title) return String(j.message || j.title);
  return `HTTP ${r.status}` + (r.text ? ': ' + r.text.slice(0, 300) : '');
}

// Envia a DPS assinada. Retorna {ok, chaveAcesso, numero, xml} ou {ok:false, error}.
async function transmitDps({ baseUrl, cert, signedXml, requestImpl = request }) {
  const r = await requestImpl({ method: 'POST', url: baseUrl.replace(/\/$/, '') + '/nfse', cert, body: JSON.stringify({ dpsXmlGZipB64: gzipB64(signedXml) }) });
  const j = r.json || {};
  if (r.status >= 200 && r.status < 300 && (j.nfseXmlGZipB64 || j.chaveAcesso)) {
    const xml = j.nfseXmlGZipB64 ? gunzipB64(j.nfseXmlGZipB64) : '';
    const numero = (xml.match(/<nNFSe>(\d+)<\/nNFSe>/) || [])[1] || '';
    const alertas = (j.alertas || []).map(a => [a.Codigo || a.codigo, a.Descricao || a.descricao].filter(Boolean).join(' - '));
    return { ok: true, status: r.status, chaveAcesso: j.chaveAcesso || '', idDps: j.idDps || '', numero, xml, alertas };
  }
  return { ok: false, status: r.status, error: describeErrors(r) };
}

// Teste de conexão autenticada: consulta uma chave inexistente; qualquer resposta HTTP
// diferente de 401/403 mostra que o certificado foi aceito no handshake mTLS.
async function testConnection({ baseUrl, cert, requestImpl = request }) {
  const r = await requestImpl({ method: 'GET', url: baseUrl.replace(/\/$/, '') + '/nfse/' + '0'.repeat(50), cert });
  if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, message: 'Certificado recusado pela NFS-e Nacional (HTTP ' + r.status + ').' };
  return { ok: true, status: r.status, message: 'Conexão autenticada com a NFS-e Nacional (HTTP ' + r.status + ').' };
}

module.exports = { buildDps, buildDpsId, validateDps, signDps, loadCertificate, extractCnpj, transmitDps, testConnection, gzipB64, gunzipB64, dhEmiBrasilia, NS_NFSE };
