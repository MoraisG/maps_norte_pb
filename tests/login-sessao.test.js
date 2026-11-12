const fs=require("fs"),vm=require("vm"),assert=require("assert");
const src=fs.readFileSync(process.argv[2] || require("path").join(__dirname, "..", "backend", "Code.gs"),"utf8");
let agora=Date.parse("2026-11-11T12:00:00Z"); const RealDate=Date;
class FakeDate extends RealDate{constructor(...a){a.length?super(...a):super(agora);} static now(){return agora;}}
const cache={}, props={};
function mkSheet(name,rows){return {name,rows,getName(){return name},appendRow(r){this.rows.push(r.map(v=>typeof v==="string"&&v.startsWith("'")?v.slice(1):v));},
 getDataRange(){const s=this;return{getValues:()=>s.rows.map(r=>r.slice())}},
 getRange(row,col,nr,nc){const s=this;return{setValue(v){s.rows[row-1][col-1]=v},setValues(m){m.forEach((r,i)=>r.forEach((v,j)=>s.rows[row-1+i][col-1+j]=v))}}},
 getLastRow(){return this.rows.length}};}
const sheets={Usuarios:mkSheet("Usuarios",[["Id","Nome","Email","Perfil","Status"],["USR-001","Admin","admin@x.com","ADMIN","ATIVO"],["USR-002","Pub","pub@x.com","PUBLICADOR","ATIVO"]]),Auditoria:mkSheet("Auditoria",[["h"]])};
let tokenInfo={};
const ctx={Date:FakeDate,JSON,Math,Number,String,Set,Object,Array,RegExp,Error,Buffer,console,
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null})},
 CacheService:{getScriptCache:()=>({get:k=>{const e=cache[k];return e&&e.exp>agora?e.v:null},put:(k,v,t)=>{cache[k]={v,exp:agora+t*1000}},remove:k=>delete cache[k]})},
 Utilities:{base64EncodeWebSafe:s=>Buffer.from(s).toString("base64"),getUuid:()=>require("crypto").randomUUID(),formatDate:()=>"x"},
 LockService:{getScriptLock:()=>({waitLock(){},tryLock(){return true},releaseLock(){}})},
 SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=mkSheet(n,[]))}),flush(){}},
 UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(tokenInfo)})},
 ContentService:{createTextOutput:t=>({t,setMimeType(){return this}}),MimeType:{JSON:1}},
 Session:{getScriptTimeZone:()=>"America/Sao_Paulo",getEffectiveUser:()=>({getEmail:()=>"admin@x.com"})},Logger:{log(){}},MailApp:{},DriveApp:{}};
vm.createContext(ctx); vm.runInContext(src,ctx);
const call=(body)=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(body)}}).t);
const JWT="aaa.bbb.ccc";
const tok=(email,extra={})=>Object.assign({email,email_verified:"true",aud:ctx.CONFIG?undefined:undefined,iss:"https://accounts.google.com",exp:String(Math.floor(agora/1000)+3600),name:"=HACK()"},extra);
const AUD="917012478113-2nq9p3io8j8cao95gscamjh0jqrp6u4p.apps.googleusercontent.com";
// 1) Estranho: 4 falhas = 403 normal; 5a = blacklist
for(let i=1;i<=5;i++){tokenInfo=tok("evil@x.com",{aud:AUD}); const r=call({rota:"auth/login",idToken:JWT}); assert.strictEqual(r.codigo,403); if(i<5) assert.ok(!/bloqueado/i.test(r.erro)); else assert.ok(/bloqueado/i.test(r.erro),"5a deve bloquear");}
assert.strictEqual(sheets.Blacklist.rows.length,2); assert.strictEqual(sheets.Blacklist.rows[1][0],"evil@x.com");
// mesmo cadastrado depois -> continua bloqueado até admin salvar via painel
tokenInfo=tok("evil@x.com",{aud:AUD}); assert.ok(/bloqueado/i.test(call({rota:"auth/login",idToken:JWT}).erro));
// fórmula do nome nunca foi gravada como fórmula (appendRow recebeu com ')
// 2) aud divergente conta como falha
for(let i=1;i<=5;i++){tokenInfo=tok("other@x.com",{aud:"outro"}); call({rota:"auth/login",idToken:JWT});}
assert.strictEqual(sheets.Blacklist.rows.length,3);
// 3) Login válido do publicador
tokenInfo=tok("pub@x.com",{aud:AUD}); let r=call({rota:"auth/login",idToken:JWT}); assert.ok(r.sucesso,JSON.stringify(r)); let s=r.sessionToken;
assert.ok(!("linhaPlanilha" in r.usuario));
// 4) refresh cedo -> não renova
agora+=30*60*1000; r=call({rota:"auth/refresh",sessionToken:s}); assert.ok(r.sucesso&&r.renovada===false);
// sem deslizamento: aos 61 min expira se não renovar
// 5) refresh nos últimos 15 min -> token novo; antigo vale 60s
agora+=20*60*1000; r=call({rota:"auth/refresh",sessionToken:s}); assert.ok(r.sucesso&&r.renovada,JSON.stringify(r)); const s2=r.sessionToken; assert.notStrictEqual(s2,s);
assert.ok(call({rota:"auth/me",sessionToken:s}).sucesso,"antigo em graça");
assert.strictEqual(call({rota:"auth/refresh",sessionToken:s}).codigo,401,"não bifurca");
agora+=61*1000; assert.strictEqual(call({rota:"auth/me",sessionToken:s}).codigo,401,"antigo expirou");
assert.ok(call({rota:"auth/me",sessionToken:s2}).sucesso);
// 6) sessão nova expira em 1h sem refresh
agora+=61*60*1000; assert.strictEqual(call({rota:"auth/me",sessionToken:s2}).codigo,401);
// 7) admin cadastra evil -> libera blacklist
tokenInfo=tok("admin@x.com",{aud:AUD}); r=call({rota:"auth/login",idToken:JWT}); const sa=r.sessionToken;
r=call({rota:"admin/usuarios/salvar",sessionToken:sa,dadosUsuario:{nome:"Novo Irmão",email:"evil@x.com",perfil:"PUBLICADOR",status:"ATIVO"}}); assert.ok(r.sucesso,JSON.stringify(r));
assert.strictEqual(sheets.Blacklist.rows[1][5],"LIBERADO");
tokenInfo=tok("evil@x.com",{aud:AUD}); assert.ok(call({rota:"auth/login",idToken:JWT}).sucesso,"liberado consegue entrar");
// 8) GET bloqueado
assert.strictEqual(JSON.parse(ctx.doGet({parameter:{rota:"auth/me"}}).t).codigo,405);
console.log("TODOS OS TESTES DE LOGIN/SESSÃO PASSARAM");
