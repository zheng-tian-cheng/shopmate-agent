import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const { parse }=require('next/dist/compiled/babel/parser');
for(const file of readdirSync('tests').filter(f=>f.endsWith('.test.ts'))) {
 const path='tests/'+file;
 let s=readFileSync(path,'utf8');
 s=s.replace('const play = (s: ShopSession, ...actions: ShopAction[]) => actions.reduce(reduce, s);','async function play(s: ShopSession, ...actions: ShopAction[]): Promise<ShopSession> { for (const action of actions) s = await reduce(s, action); return s; }');
 const names=new Set(['reduce','play','send','submit','ask']);
 const ast=parse(s,{sourceType:'module',plugins:['typescript','importAttributes']});
 const edits=[];
 function walk(n) {
  if(!n||typeof n!=='object') return;
  if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&names.has(n.callee.name)) edits.push([n.start,'(await '],[n.end,')']);
  for(const [k,v] of Object.entries(n)) if(k!=='loc') { if(Array.isArray(v)) v.forEach(walk); else if(v&&typeof v==='object') walk(v); }
 }
 walk(ast);
 for(const [pos,text] of edits.sort((a,b)=>b[0]-a[0])) s=s.slice(0,pos)+text+s.slice(pos);
 s=s.replace(/test\(([^\n]+), \(\) =>/g,'test($1, async () =>');
 s=s.replace(/(?<!async )function (play|send|submit|ask)\(([^\n]+)\): ShopSession/g,'async function $1($2): Promise<ShopSession>');
 s=s.replace('await (await reduce(', '(await reduce('); // already async helper
 writeFileSync(path,s);
}
