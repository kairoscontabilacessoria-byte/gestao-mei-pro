// Gera o PDF do DANFSe (representação da NFS-e) a partir do XML autorizado,
// sem dependências externas. Usado quando o DANFSe oficial do ADN não está disponível.

const tag = (xml, name) => {
  const m = String(xml || '').match(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + name + '>'));
  return m ? m[1] : '';
};
const val = (xml, name) => decode(tag(xml, name).replace(/<[^>]+>/g, '').trim());
function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&amp;/g, '&');
}

const fmtDoc = d => {
  d = String(d || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};
const fmtMoney = v => (v === '' || v == null) ? '-' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : '') : (s || '-'); };
const fmtCep = c => { c = String(c || '').replace(/\D/g, ''); return c.length === 8 ? c.slice(0, 5) + '-' + c.slice(5) : c; };
const fmtTrib = c => { c = String(c || '').replace(/\D/g, ''); return c.length === 6 ? `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4)}` : c; };

function endereco(block) {
  const e = tag(block, 'enderNac') || tag(block, 'end') || '';
  if (!e) return '';
  const parts = [val(e, 'xLgr'), val(e, 'nro'), val(e, 'xCpl'), val(e, 'xBairro')].filter(Boolean).join(', ');
  const cep = val(e, 'CEP');
  return [parts, cep ? 'CEP ' + fmtCep(cep) : ''].filter(Boolean).join(' - ');
}

// Extrai os campos usados no DANFSe do XML da NFS-e nacional.
function parseNfse(xml) {
  const inf = tag(xml, 'infNFSe') || xml;
  const dps = tag(inf, 'infDPS');
  const emit = tag(inf, 'emit');
  const toma = tag(dps, 'toma');
  const prestDps = tag(dps, 'prest');
  const vals = tag(inf, 'valores');
  const chave = (String(xml).match(/<(?:\w+:)?infNFSe[^>]*\sId="NFS(\d+)"/) || [])[1] || '';
  return {
    chave,
    tpAmb: val(dps, 'tpAmb') || val(inf, 'ambGer'),
    numero: val(inf, 'nNFSe'),
    dhProc: val(inf, 'dhProc'),
    dhEmi: val(dps, 'dhEmi'),
    dCompet: val(dps, 'dCompet'),
    serie: val(dps, 'serie'),
    nDPS: val(dps, 'nDPS'),
    locEmi: val(inf, 'xLocEmi'),
    locPrest: val(inf, 'xLocPrestacao'),
    locIncid: val(inf, 'xLocIncid'),
    xTribNac: val(inf, 'xTribNac'),
    prest: {
      doc: val(emit, 'CNPJ') || val(emit, 'CPF') || val(prestDps, 'CNPJ') || val(prestDps, 'CPF'),
      nome: val(emit, 'xNome') || val(prestDps, 'xNome'),
      im: val(emit, 'IM'),
      end: endereco(emit),
      fone: val(emit, 'fone'),
      email: val(emit, 'email')
    },
    toma: {
      doc: val(toma, 'CNPJ') || val(toma, 'CPF') || val(toma, 'NIF'),
      nome: val(toma, 'xNome'),
      end: endereco(toma),
      email: val(toma, 'email')
    },
    cTribNac: val(dps, 'cTribNac'),
    descricao: val(dps, 'xDescServ'),
    vServ: val(dps, 'vServ'),
    vBC: val(vals, 'vBC'),
    pAliq: val(vals, 'pAliqAplic'),
    vISSQN: val(vals, 'vISSQN'),
    vTotalRet: val(vals, 'vTotalRet'),
    vLiq: val(vals, 'vLiq'),
    tpRetISSQN: val(dps, 'tpRetISSQN'),
    opSimpNac: val(dps, 'opSimpNac')
  };
}

// ---- Gerador mínimo de PDF (A4, Helvetica, WinAnsi) ----
function pdfText(s) {
  const t = String(s ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/→/g, '->');
  let out = '';
  for (const ch of t) { const c = ch.charCodeAt(0); out += c < 256 && c >= 32 ? ch : (c === 9 ? ' ' : '?'); }
  return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrap(text, size, width) {
  const max = Math.max(10, Math.floor(width / (size * 0.5)));
  const lines = [];
  for (const para of String(text || '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > max) { if (line) lines.push(line); line = word; while (line.length > max) { lines.push(line.slice(0, max)); line = line.slice(max); } }
      else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  return lines;
}

function buildPdf(ops) {
  const content = Buffer.from(ops.join('\n'), 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    null
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    const b = o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    chunks.push(b); offset += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

// Monta o DANFSe em PDF a partir do XML autorizado.
function danfsePdf(xml) {
  const n = parseNfse(xml);
  const ops = [];
  const L = 36, R = 559, W = R - L;
  let y = 806;
  const text = (x, yy, s, size = 9, bold = false) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${yy} Td (${pdfText(s)}) Tj ET`);
  const section = title => { y -= 6; ops.push('0.9 g'); ops.push(`${L} ${y - 14} ${W} 14 re f`); ops.push('0 g'); text(L + 4, y - 10, title, 9, true); y -= 26; };
  const field = (x, label, value, w) => {
    text(x, y, label, 7, true);
    const lines = wrap(value || '-', 9, w);
    lines.forEach((ln, i) => text(x, y - 11 - i * 11, ln, 9));
    return 11 + lines.length * 11;
  };
  const row = cols => {
    const w = W / cols.length;
    const h = Math.max(...cols.map((c, i) => field(L + 4 + i * w, c[0], c[1], w - 8)));
    y -= h + 6;
  };

  ops.push('0.5 w');
  text(L, y, 'DANFSe - Documento Auxiliar da NFS-e', 15, true);
  y -= 14;
  text(L, y, 'Nota Fiscal de Serviço eletrônica - padrão nacional', 9);
  if (n.tpAmb === '2') { y -= 16; ops.push('0.75 0 0 rg'); text(L, y, 'SEM VALOR FISCAL - EMITIDA EM PRODUÇÃO RESTRITA (HOMOLOGAÇÃO)', 11, true); ops.push('0 g'); }
  y -= 10;

  section('IDENTIFICAÇÃO DA NFS-e');
  row([['Número da NFS-e', n.numero], ['Competência', fmtDate(n.dCompet)], ['Data/hora da emissão', fmtDate(n.dhProc || n.dhEmi)]]);
  row([['Chave de acesso', n.chave]]);
  row([['Série / número da DPS', [n.serie, n.nDPS].filter(Boolean).join(' / ')], ['Local de emissão', n.locEmi], ['Data/hora da DPS', fmtDate(n.dhEmi)]]);

  section('PRESTADOR DO SERVIÇO');
  row([['CNPJ / CPF', fmtDoc(n.prest.doc)], ['Inscrição municipal', n.prest.im], ['Telefone', n.prest.fone]]);
  row([['Nome / nome empresarial', n.prest.nome], ['E-mail', n.prest.email]]);
  if (n.prest.end) row([['Endereço', n.prest.end]]);
  row([['Simples Nacional', { 1: 'Não optante', 2: 'Optante - MEI', 3: 'Optante - ME/EPP' }[n.opSimpNac] || '-']]);

  section('TOMADOR DO SERVIÇO');
  row([['CNPJ / CPF / NIF', fmtDoc(n.toma.doc)], ['E-mail', n.toma.email]]);
  row([['Nome / nome empresarial', n.toma.nome]]);
  if (n.toma.end) row([['Endereço', n.toma.end]]);

  section('SERVIÇO PRESTADO');
  row([['Código de tributação nacional', [fmtTrib(n.cTribNac), n.xTribNac].filter(Boolean).join(' - ')]]);
  row([['Local da prestação', n.locPrest], ['Município de incidência do ISSQN', n.locIncid]]);
  row([['Descrição do serviço', n.descricao]]);

  section('VALORES E TRIBUTAÇÃO');
  row([['Valor do serviço', fmtMoney(n.vServ)], ['Base de cálculo do ISSQN', fmtMoney(n.vBC)], ['Alíquota', n.pAliq ? Number(n.pAliq).toLocaleString('pt-BR') + '%' : '-']]);
  row([['ISSQN apurado', fmtMoney(n.vISSQN)], ['Retenção do ISSQN', n.tpRetISSQN === '1' ? 'Não retido' : (n.tpRetISSQN ? 'Retido' : '-')], ['Total de retenções', fmtMoney(n.vTotalRet)]]);
  ops.push('0.9 g'); ops.push(`${L} ${y - 24} ${W} 26 re f`); ops.push('0 g');
  text(L + 4, y - 16, 'VALOR LÍQUIDO DA NFS-e', 10, true);
  text(R - 160, y - 16, fmtMoney(n.vLiq || n.vServ), 12, true);
  y -= 34;

  text(L, 40, 'Consulte a autenticidade em https://www.nfse.gov.br/consultapublica com a chave de acesso.', 7);
  text(L, 30, 'Representação gerada pelo Gestão MEI Pro a partir do XML autorizado da NFS-e.', 7);
  return buildPdf(ops);
}

module.exports = { danfsePdf, parseNfse };
