import { createHash } from 'node:crypto';
process.env.GITHUB_TOKEN='ghp_test';
process.env.PROJECTS=JSON.stringify({
  hub:      {repo:'Org/Repo',      branch:'main', origin:'https://org.github.io'},
  glossary: {repo:'Org/Glossary',  branch:'main', origin:'https://glossary.example'}
});
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
const { handler, __resetProjectsCache: projectsCacheBust } = await import('./index.mjs');
const ev = (method, path, key, body) => ({ rawPath:'/hub'+path, requestContext:{http:{method}}, headers:{origin:'https://org.github.io', ...(key?{'x-facilitator-key':key}:{})}, body: body?JSON.stringify(body):undefined });
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

// ---------- potential initiatives ----------
let potIndex = { ids: ['existing-one'] };
let putCount = 0;
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (opts.method==='GET' && url.includes('/data/potential/index.json')) return {status:200, json:async()=>({sha:'1'.repeat(40), content:b64(potIndex)})};
  if (opts.method==='GET' && url.includes('/data/potential/existing-one.json')) return {status:200, json:async()=>({sha:'2'.repeat(40), content:b64({id:'existing-one',name:'Existing'})})};
  if (opts.method==='GET' && url.includes('/data/potential/')) return {status:404, json:async()=>({})};
  if (opts.method==='PUT' && url.includes('/data/potential/')) { putCount++; calls.push({url,method:'PUT',body:JSON.parse(opts.body)}); return {status:201, json:async()=>({content:{sha:'9'.repeat(40)}})}; }
  return prevFetch(url, opts);
};
const good = { name:'Digital Closing', stage:'in-progress', domain:'Originations', summary:'S', whyRaised:'W', broughtBy:'B', dateLogged:'2026-09-15',
  stakeholderTypes:['Lender','GSE'], organizations:[{org:'Acme',type:'Lender',engagement:'interested',contact:'c'}], updates:[{text:'first',by:'Jane',at:'2026-09-01T10:00:00Z'},{text:'second',by:'Jane',at:'2026-09-10T10:00:00Z'}] };

r = await handler(ev('GET','/potential/existing-one','Jane Facilitator:k7Qm-2vXp'));
ok('facilitator reads a potential initiative', r.statusCode===200 && J(r).data.name==='Existing' && J(r).sha);
r = await handler(ev('GET','/potential/index','Jane Facilitator:k7Qm-2vXp'));
ok('"index" is not a valid initiative id', r.statusCode===400);
r = await handler(ev('GET','/potential/nope','Jane Facilitator:k7Qm-2vXp'));
ok('missing -> data null', r.statusCode===200 && J(r).data===null);

calls.length=0; putCount=0;
r = await handler(ev('PUT','/potential/digital-closing','Jane Facilitator:k7Qm-2vXp',{sha:null, content:good}));
const rec = calls.find(c=>c.url.includes('digital-closing.json')); const pwritten = JSON.parse(Buffer.from(rec.body.content,'base64').toString());
const idxw = calls.find(c=>c.url.includes('index.json')); const idxWritten = idxw && JSON.parse(Buffer.from(idxw.body.content,'base64').toString());
ok('create: record committed with savedBy and normalised fields', r.statusCode===200 && pwritten.savedBy==='Jane Facilitator' && pwritten.id==='digital-closing' && pwritten.stage==='in-progress');
ok('create: updates sorted newest first', pwritten.updates[0].text==='second');
ok('create: commit message says Create and names the initiative', rec.body.message.startsWith('Create potential initiative "Digital Closing"'));
ok('create: id appended to index with the index sha', idxWritten && idxWritten.ids.join()==='existing-one,digital-closing' && idxw.body.sha==='1'.repeat(40));
ok('create: response reports indexed', J(r).indexed===true);

calls.length=0;
potIndex = { ids:['existing-one','digital-closing'] };
r = await handler(ev('PUT','/potential/digital-closing','Jane Facilitator:k7Qm-2vXp',{sha:'9'.repeat(40), content:good}));
ok('update: no index write when id already indexed', r.statusCode===200 && !calls.find(c=>c.url.includes('index.json')));
ok('update: commit message says Update', calls[0].body.message.startsWith('Update potential initiative'));

r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, stakeholderTypes:['Made Up']}}));
ok('unknown stakeholder type refused, named', r.statusCode===400 && J(r).error==='UNKNOWN_TYPE' && J(r).type==='Made Up');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, organizations:[{org:'Acme',type:'Lender',engagement:'maybe'}]}}));
ok('bad engagement refused', r.statusCode===400 && J(r).error==='BAD_ENGAGEMENT');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, stage:'done'}}));
ok('bad stage refused', r.statusCode===400 && J(r).error==='BAD_STAGE');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, name:''}}));
ok('missing name refused', r.statusCode===400 && J(r).error==='BAD_NAME');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, updates:[{text:'',by:'x'}]}}));
ok('empty update refused', r.statusCode===400 && J(r).error==='BAD_UPDATE');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, potentialSolutions:['  Template A ', '', 'Guidance B']}}));
{ const w = JSON.parse(Buffer.from(calls.filter(c=>c.method==='PUT' && c.url.includes('/x.json')).at(-1).body.content,'base64').toString());
  ok('potentialSolutions kept, trimmed, blanks dropped', r.statusCode===200 && w.potentialSolutions.join('|')==='Template A|Guidance B'); }
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, leadership:[{name:'Ann',title:'CTO',company:'Acme',role:'Chair'},{name:'Bo',role:'Education Representative'}]}}));
{ const w = JSON.parse(Buffer.from(calls.filter(c=>c.method==='PUT' && c.url.includes('/x.json')).at(-1).body.content,'base64').toString());
  ok('leadership kept with roles; missing title/company become empty strings', r.statusCode===200 && w.leadership.length===2 && w.leadership[1].title==='' && w.leadership[0].role==='Chair'); }
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, leadership:[{name:'Ann',role:'President'}]}}));
ok('unknown leadership role refused, named', r.statusCode===400 && J(r).error==='BAD_ROLE' && J(r).name==='Ann');
r = await handler(ev('PUT','/potential/x','Jane Facilitator:k7Qm-2vXp',{sha:null, content:{...good, leadership:[{name:'',role:'Chair'}]}}));
ok('leader without a name refused', r.statusCode===400 && J(r).error==='BAD_LEADER');

// ---------- multi-project isolation (the thing a shared Lambda must get right) ----------
const raw = (method, path, key, body, origin) => ({ rawPath:path, requestContext:{http:{method}},
  headers:{...(origin?{origin}:{}) , ...(key?{'x-facilitator-key':key}:{})}, body: body?JSON.stringify(body):undefined });

// Glossary has its OWN facilitators.json in its OWN repo — different person entirely.
const glossaryFac = { admin:{name:'Glossary Admin', hash:h('gloss-admin')}, facilitators:[{name:'Gloss Editor', hash:h('gloss-pass')}] };
const hubFac      = { admin:{name:'Paul Admin', hash:h('adminpass-XYZ')}, facilitators:[{name:'Jane Facilitator', hash:h('k7Qm-2vXp')}] };
let reqRepos = [];
const beforeIso = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  reqRepos.push(url);
  if (opts.method==='GET' && url.includes('/Org/Glossary/contents/facilitators.json'))
    return {status:200, json:async()=>({sha:'g'.repeat(40), content:b64(glossaryFac)})};
  if (opts.method==='GET' && url.includes('/Org/Repo/contents/facilitators.json'))
    return {status:200, json:async()=>({sha:'f'.repeat(40), content:b64(hubFac)})};
  if (opts.method==='GET' && url.includes('/git/ref/heads/'))   return {status:200, json:async()=>({object:{sha:'a'.repeat(40)}})};
  if (opts.method==='GET' && url.includes('/git/commits/'))     return {status:200, json:async()=>({tree:{sha:'t'.repeat(40)}})};
  if (opts.method==='POST' && url.includes('/git/blobs'))       return {status:201, json:async()=>({sha:'b'.repeat(40)})};
  if (opts.method==='POST' && url.includes('/git/trees'))       return {status:201, json:async()=>({sha:'n'.repeat(40)})};
  if (opts.method==='POST' && url.includes('/git/commits'))     return {status:201, json:async()=>({sha:'c'.repeat(40)})};
  if (opts.method==='PATCH' && url.includes('/git/refs/heads/'))return {status:200, json:async()=>({})};
  if (opts.method==='GET') return {status:404, json:async()=>({})};
  return {status:200, json:async()=>({content:{sha:'z'.repeat(40)}})};
};


r = await handler(raw('GET','/nope/data/mcd','Jane Facilitator:k7Qm-2vXp',null,'https://org.github.io'));
ok('unknown project -> 404', r.statusCode===404 && J(r).error==='UNKNOWN_PROJECT');

// THE important one: a glossary key must not work against the hub, and vice versa.
r = await handler(raw('GET','/hub/data/mcd','Gloss Editor:gloss-pass',null,'https://org.github.io'));
ok('glossary key REFUSED on the hub project', r.statusCode===401);
r = await handler(raw('GET','/glossary/data/x','Jane Facilitator:k7Qm-2vXp',null,'https://glossary.example'));
ok('hub key REFUSED on the glossary project', r.statusCode===401);

// Origin is per project too.
r = await handler(raw('GET','/glossary/data/x','Gloss Editor:gloss-pass',null,'https://org.github.io'));
ok("hub's origin REFUSED on the glossary project", r.statusCode===403 && J(r).error==='ORIGIN');

// A glossary request must only ever touch the glossary repo.
reqRepos=[];
r = await handler(raw('POST','/glossary/commit','Gloss Editor:gloss-pass',
  {files:[{path:'data/glossary.json',content:'{"big":true}'},{path:'.console/draft.json',content:'{}'}], message:'Save working draft', parentSha:'a'.repeat(40)},
  'https://glossary.example'));
ok('multi-file commit via Git Data API succeeds', r.statusCode===200 && J(r).commit==='c'.repeat(40));
ok('commit attributed to the editor', J(r).savedBy==='Gloss Editor');
ok('glossary request touched ONLY the glossary repo', reqRepos.every(u=>!u.includes('/Org/Repo/')) && reqRepos.some(u=>u.includes('/Org/Glossary/')));

r = await handler(raw('POST','/glossary/commit','Gloss Editor:gloss-pass',
  {files:[{path:'x.json',content:'{}'}], parentSha:'9'.repeat(40)}, 'https://glossary.example'));
ok('stale parentSha -> CONFLICT (someone else committed)', r.statusCode===409 && J(r).error==='CONFLICT');

r = await handler(raw('POST','/glossary/commit','Gloss Editor:gloss-pass',
  {files:[{path:'../../etc/passwd',content:'x'}]}, 'https://glossary.example'));
ok('path traversal in a commit refused', r.statusCode===400 && J(r).error==='BAD_PATH');

r = await handler(raw('OPTIONS','/glossary/commit',null,null,'https://glossary.example'));
ok('preflight echoes the project origin', r.statusCode===204 && r.headers['Access-Control-Allow-Origin']==='https://glossary.example');

/* ---------- the project list read from a repository, not an env var ----------
   Flipping PROJECTS_REPO on switches the source. These run last so the earlier
   tests keep exercising the environment-variable path. */

let projectsFile = {
  hub:      { repo:'Org/Repo',     branch:'main', origin:'https://org.github.io' },
  glossary: { repo:'Org/Glossary', branch:'main', origin:'https://glossary.example' },
  press:    { repo:'Org/Press',    branch:'main', origin:'https://org.github.io' }
};
let projectsStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (opts.method === 'GET' && url.includes('/projects.json')) {
    calls.push({ url, method:'GET', body:null });
    if (projectsStatus !== 200) return { status: projectsStatus, json: async()=>({}) };
    return { status:200, json: async()=>({ sha:'p'.repeat(40), content:b64(projectsFile) }) };
  }
  return realFetch(url, opts);
};
process.env.PROJECTS_REPO = 'Org/SiteConfig';

const evp = (proj, method, path, key, origin) => ({
  rawPath:'/'+proj+path, requestContext:{http:{method}},
  headers:{ origin: origin||'https://org.github.io', ...(key?{'x-facilitator-key':key}:{}) }
});

r = await handler(evp('hub','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('project resolved from projects.json in the repo', r.statusCode===200);
ok('projects.json was actually fetched', calls.some(c=>c.url.includes('/projects.json')));

// A tool added by commit, with no AWS change at all, is reachable.
r = await handler(evp('press','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('a project present ONLY in the committed file resolves', r.statusCode!==404 || J(r).error!=='UNKNOWN_PROJECT');

// A rogue or mistaken entry naming another owner is refused at the door.
projectsFile = { ...projectsFile, evil:{ repo:'Someone-Else/Repo', branch:'main', origin:'https://org.github.io' } };
projectsCacheBust();
r = await handler(evp('evil','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('entry naming a different owner -> UNKNOWN_PROJECT', r.statusCode===404 && J(r).error==='UNKNOWN_PROJECT');
ok('no request was made to the foreign repo', !calls.some(c=>c.url.includes('Someone-Else')));

// Malformed entries are refused rather than half-used.
projectsFile = { ...projectsFile, broken:{ repo:'Org/Broken' } };
projectsCacheBust();
r = await handler(evp('broken','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('entry missing origin -> UNKNOWN_PROJECT', r.statusCode===404 && J(r).error==='UNKNOWN_PROJECT');

// A warm container rides out a brief GitHub failure using the last good list.
projectsStatus = 500;
r = await handler(evp('hub','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('warm cache survives a GitHub blip', r.statusCode===200);

// A cold container has nothing to fall back on, and says so instead of guessing.
projectsCacheBust();
r = await handler(evp('hub','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('cold start + unreadable list -> 503, not a wrong-repo write', r.statusCode===503 && J(r).error==='CONFIG_UNAVAILABLE');
const writesDuringOutage = calls.filter(c=>c.method==='PUT'||c.method==='POST').length;
r = await handler({ rawPath:'/hub/commit', requestContext:{http:{method:'POST'}},
  headers:{origin:'https://org.github.io','x-facilitator-key':'Jane Facilitator:k7Qm-2vXp'},
  body: JSON.stringify({files:[{path:'a.json',content:'{}'}], message:'x'}) });
ok('no write attempted while the list is unreadable', r.statusCode===503 &&
   calls.filter(c=>c.method==='PUT'||c.method==='POST').length===writesDuringOutage);

// Turning the repo source off falls back to the environment variable cleanly.
projectsStatus = 200;
delete process.env.PROJECTS_REPO;
r = await handler(evp('hub','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('PROJECTS_REPO unset -> environment variable is used again', r.statusCode===200);
r = await handler(evp('press','GET','/data/mcd','Jane Facilitator:k7Qm-2vXp'));
ok('project only in the file is NOT visible in env mode', r.statusCode===404 && J(r).error==='UNKNOWN_PROJECT');
