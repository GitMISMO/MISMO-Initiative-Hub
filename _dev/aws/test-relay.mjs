import { createHash } from 'node:crypto';
process.env.GITHUB_TOKEN='ghp_test'; process.env.GITHUB_REPO='Org/Repo'; process.env.GITHUB_BRANCH='main';
process.env.ALLOWED_ORIGIN='https://org.github.io';
const h = s => createHash('sha256').update(s).digest('hex');

let facFile = { admin:{name:'Paul Admin', hash:h('adminpass-XYZ')},
  facilitators:[ {name:'Jane Facilitator', hash:h('k7Qm-2vXp')}, {name:'Old Timer', hash:h('gone-123'), expires:'2020-01-01'} ] };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');

const calls=[]; let putStatus=200;
globalThis.fetch = async (url, opts) => {
  calls.push({url, method:opts.method, body: opts.body?JSON.parse(opts.body):null});
  if (opts.method==='GET' && url.includes('/facilitators.json')) return {status:200, json:async()=>({sha:'fac'.padEnd(40,'0'), content:b64(facFile)})};
  if (opts.method==='GET' && url.includes('/data/mcd.json')) return {status:200, json:async()=>({sha:'d'.repeat(40), content:b64({rosterData:[1]})})};
  if (opts.method==='PUT') return {status:putStatus, json:async()=>({content:{sha:'n'.repeat(40)}})};
  return {status:404, json:async()=>({})};
};
const { handler } = await import('./index.mjs');
const ev = (method, path, key, body) => ({ rawPath:path, requestContext:{http:{method}}, headers:{origin:'https://org.github.io', ...(key?{'x-facilitator-key':key}:{})}, body: body?JSON.stringify(body):undefined });
const ok = (n,c)=>console.log((c?'PASS ':'FAIL ')+n);
const J = r => JSON.parse(r.body);

let r = await handler(ev('GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('facilitator reads via hash match', r.statusCode===200 && J(r).data.rosterData[0]===1);
r = await handler(ev('GET','/data/mcd','Jane Facilitator:wrong'));
ok('wrong passcode -> KEY_BAD', r.statusCode===401 && J(r).error==='KEY_BAD');
r = await handler(ev('GET','/data/mcd','Old Timer:gone-123'));
ok('expired entry -> KEY_EXPIRED (right passcode, past date)', r.statusCode===401 && J(r).error==='KEY_EXPIRED');
r = await handler(ev('GET','/data/mcd','Paul Admin:adminpass-XYZ'));
ok('admin can read dashboards too', r.statusCode===200);
r = await handler(ev('GET','/data/facilitators','Jane Facilitator:k7Qm-2vXp'));
ok('reserved id "facilitators" refused on /data/', r.statusCode===400);

r = await handler(ev('PUT','/data/mcd','Jane Facilitator:k7Qm-2vXp',{content:{a:1}, sha:'d'.repeat(40)}));
let put = calls.filter(c=>c.method==='PUT').at(-1);
ok('facilitator save commits with her as author', r.statusCode===200 && put.body.author.name==='Jane Facilitator' && put.body.sha==='d'.repeat(40));

r = await handler(ev('GET','/facilitators','Jane Facilitator:k7Qm-2vXp'));
ok('facilitator cannot list facilitators -> 403', r.statusCode===403 && J(r).error==='ADMIN_ONLY');
r = await handler(ev('GET','/facilitators','Paul Admin:adminpass-XYZ'));
let L=J(r);
ok('admin lists names+expiries+hashes', r.statusCode===200 && L.facilitators.length===2 && ('hash' in L.facilitators[0]) && L.admin.name==='Paul Admin' && L.sha);

r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[{name:'Jane Facilitator',hash:h('k7Qm-2vXp')},{name:'New Person',hash:h('fresh-999')}]}));
put = calls.filter(c=>c.method==='PUT').at(-1);
const written = JSON.parse(Buffer.from(put.body.content,'base64').toString());
ok('admin replaces list; Old Timer gone, New Person added', r.statusCode===200 && written.facilitators.map(f=>f.name).join()==='Jane Facilitator,New Person');
ok('admin entry preserved from file, not from body', written.admin.hash===h('adminpass-XYZ'));
ok('write used the sha the admin READ', put.body.sha===L.sha);

r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[{name:'Bad',hash:'nothex'}]}));
ok('bad hash rejects whole write', r.statusCode===400 && J(r).error==='BAD_HASH');
r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[{name:'Paul Admin',hash:h('x')}]}));
ok('cannot add a facilitator with the admin name', r.statusCode===400 && J(r).error==='ADMIN_NAME_RESERVED');
r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[{name:'A',hash:h('1')},{name:'A',hash:h('2')}]}));
ok('duplicate name rejected', r.statusCode===400 && J(r).error==='DUPLICATE_NAME');
r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[{name:'A',hash:h('1'),expires:'not a date'}]}));
ok('bad expires rejected', r.statusCode===400 && J(r).error==='BAD_EXPIRES');

putStatus=409;
r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[]}));
ok('stale sha on facilitators -> CONFLICT', r.statusCode===409);
putStatus=200;

// revocation: remove Jane from the file; cache must not keep her alive after an admin write
facFile = { ...facFile, facilitators: facFile.facilitators.filter(f=>f.name!=='Jane Facilitator') };
r = await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:L.sha, facilitators:[]}));   // clears cache
r = await handler(ev('GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('revoked facilitator refused immediately after admin write', r.statusCode===401);

r = await handler(ev('OPTIONS','/data/mcd'));
ok('preflight still 204', r.statusCode===204);
r = await handler({...ev('GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'), headers:{origin:'https://evil.example','x-facilitator-key':'Jane Facilitator:k7Qm-2vXp'}});
ok('foreign origin still refused', r.statusCode===403);

// ---------- config: stakeholder-types ----------
facFile = { admin:{name:'Paul Admin', hash:h('adminpass-XYZ')}, facilitators:[ {name:'Jane Facilitator', hash:h('k7Qm-2vXp')} ] };
await handler(ev('PUT','/facilitators','Paul Admin:adminpass-XYZ',{sha:'fac'.padEnd(40,'0'), facilitators:[{name:'Jane Facilitator',hash:h('k7Qm-2vXp')}]}));  // clears cache
let typesFile = { types:[{key:'Lender',name:'Lender'},{key:'GSE',name:'GSE'},{key:'Unused',name:'Unused'}], usage:{ccs:['Lender','GSE']} };
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (opts.method==='GET' && url.includes('/stakeholder-types.json')) return {status:200, json:async()=>({sha:'7'.repeat(40), content:b64(typesFile)})};
  return origFetch(url, opts);
};
r = await handler(ev('GET','/facilitators','Paul Admin:adminpass-XYZ'));
ok('facilitator GET now includes hashes (panel resends them)', 'hash' in J(r).facilitators[0] && !('hash' in (J(r).admin||{})));
r = await handler(ev('GET','/config/stakeholder-types','Jane Facilitator:k7Qm-2vXp'));
ok('config is admin-only', r.statusCode===403);
r = await handler(ev('GET','/config/nope','Paul Admin:adminpass-XYZ'));
ok('unknown config name -> 404', r.statusCode===404);
r = await handler(ev('GET','/config/stakeholder-types','Paul Admin:adminpass-XYZ'));
ok('admin reads types + sha', r.statusCode===200 && J(r).content.types.length===3 && J(r).sha);
const tsha=J(r).sha;
r = await handler(ev('PUT','/config/stakeholder-types','Paul Admin:adminpass-XYZ',{sha:tsha, content:{types:[{key:'Lender',name:'Lenders'},{key:'GSE',name:'GSE'}], usage:{ccs:[]}}}));
put = calls.filter(c=>c.method==='PUT').at(-1);
const w = JSON.parse(Buffer.from(put.body.content,'base64').toString());
ok('rename Lender->Lenders accepted; unused type removed', r.statusCode===200 && w.types.find(t=>t.key==='Lender').name==='Lenders' && !w.types.find(t=>t.key==='Unused'));
ok('usage preserved from file, not from body', JSON.stringify(w.usage)===JSON.stringify({ccs:['Lender','GSE']}));
r = await handler(ev('PUT','/config/stakeholder-types','Paul Admin:adminpass-XYZ',{sha:tsha, content:{types:[{key:'GSE',name:'GSE'}]}}));
ok('removing a type a dashboard uses -> IN_USE', r.statusCode===400 && J(r).error==='IN_USE' && J(r).key==='Lender' && J(r).dashboard==='ccs');
r = await handler(ev('PUT','/config/stakeholder-types','Paul Admin:adminpass-XYZ',{sha:tsha, content:{types:[{key:'Lender',name:'GSE'},{key:'GSE',name:'gse'}]}}));
ok('two types with the same display name (case-insensitive) rejected', r.statusCode===400 && J(r).error==='DUPLICATE_NAME');
r = await handler(ev('PUT','/config/stakeholder-types','Paul Admin:adminpass-XYZ',{sha:tsha, content:{types:[{key:'Lender',name:''},{key:'GSE',name:'GSE'}]}}));
ok('empty display name rejected', r.statusCode===400 && J(r).error==='BAD_NAME');
r = await handler(ev('GET','/data/stakeholder-types','Jane Facilitator:k7Qm-2vXp'));
ok('stakeholder-types reserved on /data/', r.statusCode===400);
