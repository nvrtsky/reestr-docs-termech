// No auth, CRM data or query tokens are collected. Run from the affected network.
import {resolve4,resolve6} from 'node:dns/promises';
const host='reestr.navrotsky.ru';
const dns=await Promise.allSettled([resolve4(host),resolve6(host)]);
const report={time:new Date().toISOString(),host,dns:dns.map((r,i)=>({type:i?'AAAA':'A',...(r.status==='fulfilled'?{addresses:r.value}:{error:r.reason.code})})),requests:[]};
for(let attempt=1;attempt<=3;attempt++) {
 const started=performance.now();
 try {
  const r=await fetch(`https://${host}/`,{signal:AbortSignal.timeout(15000),redirect:'error'});
  const body=await r.arrayBuffer();
  report.requests.push({attempt,status:r.status,bytes:body.byteLength,elapsedMs:Math.round(performance.now()-started)});
 } catch(error) {
  report.requests.push({attempt,elapsedMs:Math.round(performance.now()-started),error:error.cause?.code||error.name});
 }
}
console.log(JSON.stringify(report,null,2));
if(!report.requests.some(r=>r.status===200))process.exitCode=1;
