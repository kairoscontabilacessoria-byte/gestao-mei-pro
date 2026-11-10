const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const nfse = require('../nfse-nacional');

// Certificado de teste no formato e-CNPJ (CN "RAZAO:CNPJ" + OID 2.16.76.1.3.3 no SAN).
function fakePfx(cnpj = '12345678000195', password = 'senha123') {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE LTDA:' + cnpj }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 0, value: forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer('2.16.76.1.3.3').getBytes()),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, cnpj)])
  ]) }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

const sample = {
  prestadorCnpj: '12.345.678/0001-95', cLocEmi: '1506138', cLocPrestacao: '1506138', opSimpNac: 3,
  serie: '1', nDPS: 7, dCompet: '2026-08-31', dhEmi: '2026-11-10T09:00:00-03:00',
  tomadorDoc: '03.350.922/0001-17', tomadorNome: 'TOMADOR & CIA <TESTE>',
  cTribNac: '04.02.05', xDescServ: 'PRESTAÇÃO SERVIÇO MES 08/2026', vServ: '1200.5'
};

let pfxB64;
test.before(() => { pfxB64 = fakePfx(); });

test('Id da DPS tem 45 caracteres no padrão nacional', () => {
  const id = nfse.buildDpsId({ cLocEmi: '1506138', tpInsc: 2, inscFed: '12345678000195', serie: '1', nDPS: 7 });
  assert.strictEqual(id, 'DPS150613821234567800019500001000000000000007');
  assert.strictEqual(id.length, 45);
});

test('monta a DPS com campos na ordem e escapes corretos', () => {
  const { id, xml } = nfse.buildDps(sample);
  assert.match(xml, /^<DPS xmlns="http:\/\/www\.sped\.fazenda\.gov\.br\/nfse" versao="1\.00"><infDPS Id="DPS/);
  assert.ok(xml.includes(`Id="${id}"`));
  assert.ok(xml.includes('<cTribNac>040205</cTribNac>'));
  assert.ok(xml.includes('<vServ>1200.50</vServ>'));
  assert.ok(xml.includes('<xNome>TOMADOR &amp; CIA &lt;TESTE&gt;</xNome>'));
  assert.ok(xml.includes('<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib>'));
  const order = ['tpAmb', 'dhEmi', 'verAplic', 'serie', 'nDPS', 'dCompet', 'tpEmit', 'cLocEmi', 'prest', 'toma', 'serv', 'valores'].map(t => xml.indexOf('<' + t + '>'));
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(!order.includes(-1));
});

test('MEI não informa regApTribSN', () => {
  const { xml } = nfse.buildDps({ ...sample, opSimpNac: 2 });
  assert.ok(xml.includes('<regTrib><opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib></regTrib>'));
});

test('rejeita dados inválidos antes de enviar', () => {
  assert.throws(() => nfse.buildDps({ ...sample, cTribNac: '0402' }), /tributação nacional/);
  assert.throws(() => nfse.buildDps({ ...sample, cLocPrestacao: '' }), /local da prestação/);
  assert.throws(() => nfse.buildDps({ ...sample, vServ: 0 }), /Valor/);
});

test('lê o certificado A1 e extrai o CNPJ', () => {
  const c = nfse.loadCertificate(pfxB64, 'senha123');
  assert.strictEqual(c.cnpj, '12345678000195');
  assert.match(c.keyPem, /PRIVATE KEY/);
  assert.throws(() => nfse.loadCertificate(pfxB64, 'errada'), /senha/);
});

for (const alg of ['sha1', 'sha256']) {
  test(`assinatura ${alg} é validada por implementação independente (xml-crypto)`, () => {
    const cert = nfse.loadCertificate(pfxB64, 'senha123');
    const { id, xml } = nfse.buildDps(sample);
    const signed = nfse.signDps(xml, id, cert, alg);
    const doc = new DOMParser().parseFromString(signed, 'text/xml');
    const sigNode = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    assert.ok(sigNode);
    assert.strictEqual(sigNode.parentNode.localName, 'DPS');
    const sig = new SignedXml({ publicCert: cert.certPem });
    sig.loadSignature(sigNode);
    assert.strictEqual(sig.checkSignature(signed), true);
    // Qualquer alteração no conteúdo assinado invalida a assinatura.
    const tampered = signed.replace('<vServ>1200.50</vServ>', '<vServ>1.00</vServ>');
    const sig2 = new SignedXml({ publicCert: cert.certPem });
    sig2.loadSignature(new DOMParser().parseFromString(tampered, 'text/xml').getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0]);
    let valid;
    try { valid = sig2.checkSignature(tampered); } catch (e) { valid = false; }
    assert.strictEqual(valid, false);
  });
}

test('transmissão: sucesso devolve chave, número e XML da NFS-e', async () => {
  const cert = nfse.loadCertificate(pfxB64, 'senha123');
  let sent;
  const nfseXml = '<NFSe><infNFSe><nNFSe>42</nNFSe></infNFSe></NFSe>';
  const r = await nfse.transmitDps({
    baseUrl: 'https://exemplo/API/SefinNacional/', cert, signedXml: '<DPS/>',
    requestImpl: async o => { sent = o; return { status: 201, json: { chaveAcesso: 'CH1', nfseXmlGZipB64: nfse.gzipB64(nfseXml) } }; }
  });
  assert.strictEqual(sent.url, 'https://exemplo/API/SefinNacional/nfse');
  assert.strictEqual(nfse.gunzipB64(JSON.parse(sent.body).dpsXmlGZipB64), '<DPS/>');
  assert.deepStrictEqual([r.ok, r.chaveAcesso, r.numero, r.xml], [true, 'CH1', '42', nfseXml]);
});

test('transmissão: rejeição devolve os erros da Sefin', async () => {
  const cert = nfse.loadCertificate(pfxB64, 'senha123');
  const r = await nfse.transmitDps({
    baseUrl: 'https://exemplo', cert, signedXml: '<DPS/>',
    requestImpl: async () => ({ status: 400, json: { erros: [{ Codigo: 'E0001', Descricao: 'Falha', Complemento: 'campo X' }] } })
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E0001 - Falha - campo X');
});
