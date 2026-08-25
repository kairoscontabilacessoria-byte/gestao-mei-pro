function buildResetEmail({from,to,resetUrl}){
  return {
    from,
    to:[to],
    subject:'Redefinição de senha — Gestão MEI Pro',
    html:`<div style="font-family:Arial,sans-serif;line-height:1.5;color:#17212b"><h2>Redefinição de senha</h2><p>Recebemos uma solicitação para redefinir a senha do Gestão MEI Pro.</p><p><a href="${resetUrl}" style="display:inline-block;background:#0b6b5b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Criar nova senha</a></p><p>Este link é de uso único e expira em 15 minutos.</p><p>Se você não solicitou a alteração, ignore esta mensagem.</p></div>`
  };
}
async function sendResetEmail({apiKey,from,to,resetUrl,fetchImpl=fetch}){
  const response=await fetchImpl('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(buildResetEmail({from,to,resetUrl}))
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||data.error||'Falha ao enviar e-mail de recuperação');
  return data;
}
module.exports={buildResetEmail,sendResetEmail};
