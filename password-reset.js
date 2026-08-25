const crypto = require('crypto');

function createResetToken(){
  return crypto.randomBytes(32).toString('hex');
}
function hashResetToken(token){
  return crypto.createHash('sha256').update(String(token||'')).digest('hex');
}
function resetExpiry(now=new Date()){
  return new Date(now.getTime()+15*60*1000);
}
function isStrongPassword(password){
  const p=String(password||'');
  return p.length>=10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);
}
function buildResetUrl(baseUrl,token){
  return String(baseUrl||'').replace(/\/$/,'')+'/?reset_token='+encodeURIComponent(token);
}
module.exports={createResetToken,hashResetToken,resetExpiry,isStrongPassword,buildResetUrl};
