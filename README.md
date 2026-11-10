# Gestão MEI Pro

Versão consolidada para GitHub + Vercel.

Arquivos principais na raiz do repositório:
- index.js (servidor e interface)
- nfse-nacional.js (montagem, assinatura e envio da DPS)
- password-reset.js / resend-email.js
- package.json, vercel.json, .gitignore
- test/ (testes automatizados: `npm test`)

Módulos:
- Neon/PostgreSQL
- Login e sessões
- Clientes
- Consulta CNPJ com fallback (traz também o código IBGE do município)
- DAS / DASN
- Estrutura PGMEI
- NFS-e Nacional em Produção Restrita (emissão de teste)
- Rascunhos de NFS-e no Neon

## NFS-e Nacional (Produção Restrita)

O sistema monta a DPS, assina o XML (XMLDSig) com o certificado A1 da empresa
prestadora e envia para a Sefin Nacional da Produção Restrita
(`sefin.producaorestrita.nfse.gov.br`). As notas geradas ali são de teste e não têm valor fiscal.

### Emissão em produção (notas com valor fiscal)

Por padrão o sistema emite na Produção Restrita. Para emitir notas reais:

1. Emita antes pelo menos uma nota de teste na Produção Restrita e confirme que foi autorizada.
2. Na Vercel, crie a variável `NFSE_AMBIENTE` com o valor `producao` e faça novo deploy.
3. A tela NFS-e passa a mostrar o aviso de PRODUÇÃO. Cada emissão mostra o resumo da nota
   e só é enviada depois de digitar `EMITIR`. O servidor também recusa o envio sem essa confirmação.

Para voltar ao ambiente de teste, apague `NFSE_AMBIENTE` (ou use `producao_restrita`) e faça novo deploy.
A numeração da DPS é separada por ambiente. Se a empresa já emitiu DPS pela mesma série em outro
sistema, defina `NFSE_SERIE` com uma série diferente para não repetir números.

### Configurar o certificado na Vercel

O certificado precisa ser o e-CNPJ A1 **da própria empresa prestadora** (mesmo CNPJ raiz).

1. Converta o arquivo `.pfx` para base64 no seu computador (o arquivo não deve ir para o GitHub):
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\caminho\certificado.pfx")) | Set-Clipboard`
   - Linux/macOS: `base64 -w0 certificado.pfx`
2. Na Vercel, em Settings → Environment Variables, crie como **Sensitive**:
   - `NFSE_CERT_PFX_BASE64`: o texto em base64
   - `NFSE_CERT_PASSWORD`: a senha do certificado
3. Faça um novo deploy e, na tela NFS-e, clique em **Testar conexão**.

Variáveis opcionais:
- `NFSE_SERIE`: série da DPS (padrão `1`)
- `NFSE_DPS_VERSAO`: versão do leiaute da DPS (padrão `1.00`)
- `NFSE_SIGNATURE_ALG`: `sha1` (padrão) ou `sha256`

### Emitir

Na tela NFS-e, preencha prestador, situação no Simples, tomador, código de tributação
nacional (ex.: 04.02.05 → `040205`), descrição, valor, data e os códigos IBGE do município
do prestador e do local da prestação. Clique em **Emitir nota de teste**. Se autorizada, a
chave de acesso, o número e o XML ficam salvos e podem ser baixados na lista. Se rejeitada,
o motivo devolvido pela Sefin aparece na lista e o rascunho pode ser reenviado.

Nunca envie certificados, senhas, .env ou segredos ao GitHub.
