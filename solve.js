import {parseFrontMatter} from './lib/frontmatter.js';
import {renderMarkdown} from './lib/markdown.js';
import {parseTemplate,renderNodes,TemplateError} from './lib/template.js';
import {escapeHtml,slugify,uniqueSlug,longDate} from './lib/text.js';
const order=(a,b)=>a<b?-1:a>b?1:0;
function resolve(dir, path) {
  const parts=dir?dir.split('/'):[];
  for(const segment of path.split('/')) {
    if(!segment || segment==='.') continue;
    if(segment==='..') {if(!parts.length)return null;parts.pop();}
    else parts.push(segment);
  }
  return parts.join('/');
}
export function run({site,templates,files}) {
  const parsed=new Map(), notes=[], missing=new Set(), output={};
  for(const name of Object.keys(templates).sort()) {
    try {parsed.set(name,parseTemplate(name,templates[name]));}
    catch(err){if(!(err instanceof TemplateError))throw err;notes.push(err.message);}
  }
  const base=site.base_url.replace(/\/+$/,''), sources=new Map(), statics=new Map(), used=new Map();
  for(const {path,content} of [...files].sort((a,b)=>order(a.path,b.path))) {
    if(!path.endsWith('.md')) {statics.set(path,content);continue;}
    const fm=parseFrontMatter(content.replace(/\r\n?/g,'\n'));
    const post=path.startsWith('posts/'), dir=path.slice(0,Math.max(0,path.lastIndexOf('/')));
    const data=fm.data, layout=data?.layout??(post?'post':'page');
    let reason=fm.error;
    if(!reason && /^(tags|page)\//.test(path))reason=path.split('/')[0]+"/ is the generator's own";
    if(!reason && post && !Object.hasOwn(data,'date'))reason='a post needs a date';
    if(!reason && !parsed.has(layout))reason='layout "'+layout+'" is no template that parses';
    if(reason){notes.push('refused '+path+': '+reason);continue;}
    if(data.draft===true){notes.push('draft '+path);continue;}
    const parent=post?'posts':dir;
    if(!used.has(parent))used.set(parent,new Set(parent?[]:['posts','tags','page']));
    const slug=uniqueSlug(data.slug??slugify(data.title),used.get(parent));
    const out=parent?parent+'/'+slug:slug;
    sources.set(path,{path,dir,data,layout,post,slug,out,url:base+'/'+out+'/',body:fm.body});
  }
  const posts=[...sources.values()].filter(p=>p.post).sort((a,b)=>order(b.data.date,a.data.date)||order(a.slug,b.slug));
  const tags=new Map(), slugCache=new Map();
  function tagsFor(p) {
    const refs=[],seen=new Set();
    for(const name of p.data.tags??[]){
      if(!slugCache.has(name))slugCache.set(name,slugify(name));
      const slug=slugCache.get(name);if(seen.has(slug))continue;seen.add(slug);
      let t=tags.get(slug);
      if(!t){t={name,slug,url:p.post?base+'/tags/'+slug+'/':'',posts:[]};if(p.post)tags.set(slug,t);}
      if(p.post)t.posts.push(p);
      refs.push({name:t.name,slug,url:t.url});
    }
    return refs;
  }
  for(const p of posts)p.tags=tagsFor(p);
  for(const p of sources.values()){
    const {html,toc,excerpt}=renderMarkdown(p.body,{link(target){
      if(/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|#)/.test(target))return target;
      const cut=target.indexOf('#'), rel=cut<0?target:target.slice(0,cut), frag=cut<0?'':target.slice(cut);
      const dest=resolve(p.dir,rel);
      if(sources.has(dest))return sources.get(dest).url+frag;
      if(statics.has(dest))return base+'/'+dest+frag;
      missing.add('broken-link '+p.path+' -> '+target);return target;
    }});
    p.card={title:p.data.title,url:p.url,date:p.data.date??'',date_long:p.data.date===undefined?'':longDate(p.data.date),summary:p.data.summary??'',excerpt,reading_minutes:Math.max(1,Math.ceil((p.body.match(/\S+/g)?.length??0)/200)),tags:p.tags??tagsFor(p)};
    p.page={...p.card,slug:p.slug,content:html,toc,newer:null,older:null,is_post:p.post};
  }
  const link=p=>p?{title:p.card.title,url:p.url,date:p.card.date,date_long:p.card.date_long}:null;
  posts.forEach((p,i)=>{p.page.newer=link(posts[i-1]);p.page.older=link(posts[i+1]);});
  const sorted=[...tags.values()].sort((a,b)=>b.posts.length-a.posts.length||order(a.slug,b.slug));
  const globals={site:{title:site.title,base_url:base},recent:posts.slice(0,site.recent).map(p=>p.card),tags:sorted.map(({slug,name,url,posts})=>({slug,name,url,count:posts.length}))};
  const ctx={templates:parsed,escape:escapeHtml};
  function render(path,layout,vars){
    if(parsed.has(layout))output[path]=renderNodes(parsed.get(layout),{vars:{...globals,...vars},parent:null},ctx,0);
  }
  for(const p of sources.values())render(p.out+'/index.html',p.layout,{page:p.page});
  const count=Math.max(1,Math.ceil(posts.length/site.per_page));
  const pageUrl=n=>base+(n===1?'/':'/page/'+n+'/');
  for(let i=1;i<=count;i++)render((i===1?'':'page/'+i+'/')+'index.html','index',{posts:posts.slice((i-1)*site.per_page,i*site.per_page).map(p=>p.card),pager:{number:i,total:count,url:pageUrl(i),newer_url:i>1?pageUrl(i-1):'',older_url:i<count?pageUrl(i+1):''}});
  for(const t of sorted)render('tags/'+t.slug+'/index.html','tag',{tag:{...t,count:t.posts.length,posts:t.posts.map(p=>p.card)}});
  render('tags/index.html','tags',{});
  let staticCount=0;
  for(const f of files)if(!f.path.endsWith('.md'))staticCount++;
  for(const [path,content] of statics)if(Object.hasOwn(output,path))notes.push('shadowed '+path+': a built page has its path');else output[path]=content;
  output['build-report.txt']=[...notes,...missing].sort().concat('built '+(sources.size-posts.length)+' pages, '+posts.length+' posts, '+tags.size+' tags and '+staticCount+' static files').join('\n')+'\n';
  return output;
}
