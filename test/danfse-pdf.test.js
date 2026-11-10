const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { danfsePdf, parseNfse } = require('../danfse-pdf');
const nfse = require('../nfse-nacional');

const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'nfse-exemplo.xml'), 'utf8');

test('lê os campos da NFS-e nacional', () => {
  const n = parseNfse(xml);
  assert.strictEqual(n.numero, '1');
  assert.strictEqual(n.chave, '15061382123456780001950000000000000126110000000001');
  assert.strictEqual(n.prest.nome, 'EMPRESA DE TESTE & CIA LTDA');
  assert.strictEqual(n.toma.doc, '98765432000198');
  assert.strictEqual(n.vServ, '1200.50');
  assert.strictEqual(n.locIncid, 'Redenção');
  assert.strictEqual(n.tpAmb, '2');
});

test('gera um PDF válido com tabela xref correta', () => {
  const pdf = danfsePdf(xml);
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const startxref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.strictEqual(s.slice(startxref, startxref + 4), 'xref');
  const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`)));
  assert.ok(s.includes('SEM VALOR FISCAL'));
  assert.ok(s.includes('(EMPRESA DE TESTE & CIA LTDA)'));
  assert.ok(s.includes('Reden\xe7\xe3o'));
});

test('DANFSe oficial: usa o PDF do ADN quando disponível', async () => {
  let url;
  const ok = await nfse.downloadDanfse({ chave: '1'.repeat(50), tpAmb: 1, cert: {}, requestImpl: async o => { url = o.url; return { status: 200, buffer: Buffer.from('%PDF-1.7 ...') }; } });
  assert.strictEqual(url, 'https://adn.nfse.gov.br/danfse/' + '1'.repeat(50));
  assert.strictEqual(ok.ok, true);
  const fail = await nfse.downloadDanfse({ chave: '1'.repeat(50), tpAmb: 2, cert: {}, requestImpl: async () => ({ status: 404, buffer: Buffer.from('{}') }) });
  assert.strictEqual(fail.ok, false);
});
