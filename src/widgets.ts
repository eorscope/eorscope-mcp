// The two render widgets (MCP Apps, text/html;profile=mcp-app): self-contained HTML, inline CSS and JS,
// system fonts, no network call. They talk to the host over the MCP Apps bridge (ui/initialize,
// ui/notifications/tool-result, tools/call, ui/open-link, ui/request-display-mode) and fall back to
// the window.openai aliases. Data is written with textContent only, never innerHTML.
// Written with String.raw and without "${": the browser code is shipped exactly as typed.

export const WIDGET_MIME = 'text/html;profile=mcp-app';
// the URI is a cache key: change the version when the HTML changes in a breaking way
// ChatGPT caches a widget template by its URI: bump the version on every template change (v4 = source wording, secondary sources labelled, 09/10; v5 = salary basis of a monthly salary, 09/10; v6 = Local/USD switch, salary field in the input's currency and period, payments included in the gross, 09/10).
export const LEDGER_URI = 'ui://eorscope/ledger-v6.html';
export const COMPARE_URI = 'ui://eorscope/compare-v2.html';

// DESIGN.md tokens: ledger palette, one accent (--signal), mono for figures; light/dark from the host
const CSS = String.raw`
:root{color-scheme:light;--ink:#0F1720;--paper:#F7F6F2;--muted:#586270;--line:#D9DCE0;--line-strong:#7F8A95;--signal:#0B6E4F;--signal-soft:#DDEFE6;--warn:#8A5A12;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--ink:#E8EAED;--paper:#0E1318;--muted:#A2ABB4;--line:#2A3540;--line-strong:#66737F;--signal:#5FC39A;--signal-soft:#143327;--warn:#E0A84A}}
:root[data-theme=dark]{color-scheme:dark;--ink:#E8EAED;--paper:#0E1318;--muted:#A2ABB4;--line:#2A3540;--line-strong:#66737F;--signal:#5FC39A;--signal-soft:#143327;--warn:#E0A84A}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 var(--sans)}
main{padding:16px}
h1{margin:0;font-size:17px;font-weight:650}
.sub{margin:2px 0 12px;color:var(--muted)}
.n,td.n,th.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.big{font-family:var(--mono);font-size:22px;font-weight:600;color:var(--signal)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:0 0 12px}
label{display:block;font-size:12px;color:var(--muted)}
input{font:inherit;font-family:var(--mono);width:9.5em;padding:5px 8px;border:1px solid var(--line-strong);border-radius:6px;background:var(--paper);color:var(--ink)}
button{font:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--line-strong);border-radius:6px;background:transparent;color:var(--ink);cursor:pointer}
button[aria-pressed=true],button.primary{background:var(--signal);border-color:var(--signal);color:var(--paper)}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.seg{display:inline-flex;gap:0}.seg button{border-radius:0}.seg button:first-child{border-radius:6px 0 0 6px}.seg button:last-child{border-radius:0 6px 6px 0;margin-left:-1px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
caption{text-align:left;font-size:12px;color:var(--muted);padding:0 0 6px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}
th{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tfoot td{font-weight:650;border-bottom:0;border-top:1px solid var(--line-strong)}
.tag{display:inline-block;margin:2px 4px 0 0;padding:0 6px;border-radius:4px;font-size:11px;background:var(--signal-soft);color:var(--ink)}
.tag.w{background:transparent;border:1px solid var(--warn);color:var(--warn)}
.src{display:inline-block;font-size:11px;color:var(--muted)}
a{color:var(--signal);font-weight:600}
.small{font-size:12px;color:var(--muted);margin:8px 0 0}
.disc{font-size:12px;font-weight:600;margin:12px 0 0}
.empty{color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:no-preference){button{transition:background .12s}}
`;

// The bridge, shared by both widgets. The page script defines render(data) and APP (name, modes).
const BRIDGE = String.raw`
var OA=window.openai,pending={},nid=0,ctx={},state=(OA&&OA.widgetState)||{},data=null;
function post(m){window.parent.postMessage(m,"*")}
function req(method,params){var id=++nid;post({jsonrpc:"2.0",id:id,method:method,params:params});
 return new Promise(function(ok,ko){pending[id]={ok:ok,ko:ko};setTimeout(function(){if(pending[id]){delete pending[id];ko(new Error("timeout"))}},10000)})}
function note(method,params){post({jsonrpc:"2.0",method:method,params:params})}
function theme(t){if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}
function onCtx(c){if(!c)return;for(var k in c)ctx[k]=c[k];theme(c.theme)}
function parse(res){if(!res)return null;if(res.structuredContent)return res.structuredContent;
 try{return JSON.parse(res.content[0].text)}catch(e){return null}}
function accept(res){var d=parse(res);if(d&&!res.isError){data=d;render(d)}}
function save(patch){for(var k in patch)state[k]=patch[k];if(OA&&OA.setWidgetState)OA.setWidgetState(state)}
function callTool(name,args){return req("tools/call",{name:name,arguments:args}).catch(function(e){
 if(OA&&OA.callTool)return OA.callTool(name,args);throw e})}
function openLink(url){req("ui/open-link",{url:url}).catch(function(){
 if(OA&&OA.openExternal)OA.openExternal({href:url});else window.open(url,"_blank","noopener")})}
function canMode(m){var a=ctx.availableDisplayModes;return a?a.indexOf(m)>=0:!!(OA&&OA.requestDisplayMode)}
function askMode(m){if(!canMode(m))return;req("ui/request-display-mode",{mode:m}).catch(function(){
 if(OA&&OA.requestDisplayMode)OA.requestDisplayMode({mode:m})})}
window.addEventListener("message",function(e){if(e.source!==window.parent)return;var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
 if(m.id!=null&&!m.method&&pending[m.id]){var p=pending[m.id];delete pending[m.id];if(m.error)p.ko(m.error);else p.ok(m.result);return}
 if(m.method==="ui/notifications/tool-result")accept(m.params);
 else if(m.method==="ui/notifications/host-context-changed")onCtx(m.params);
 else if(m.method==="ui/resource-teardown"&&m.id!=null)post({jsonrpc:"2.0",id:m.id,result:{}})},{passive:true});
window.addEventListener("openai:set_globals",function(e){var g=e.detail&&e.detail.globals;if(!g)return;
 if(g.theme)theme(g.theme);if(g.toolOutput&&!data){data=g.toolOutput;render(data)}},{passive:true});
req("ui/initialize",{protocolVersion:"2026-01-26",appInfo:APP.info,appCapabilities:{availableDisplayModes:APP.modes}})
 .then(function(r){onCtx(r&&r.hostContext);note("ui/notifications/initialized",{})}).catch(function(){});
if(OA){theme(OA.theme);if(OA.toolOutput){data=OA.toolOutput;render(data)}}
if(window.ResizeObserver)new ResizeObserver(function(){var h=document.documentElement.scrollHeight;
 note("ui/notifications/size-changed",{width:document.documentElement.scrollWidth,height:h});
 if(OA&&OA.notifyIntrinsicHeight)OA.notifyIntrinsicHeight(h)}).observe(document.body);
`;

// Small helpers both pages use: element builder, money in USD or local currency, links through the host.
const HELPERS = String.raw`
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=String(x);return e}
function add(p){for(var i=1;i<arguments.length;i++)if(arguments[i])p.appendChild(arguments[i]);return p}
function money(n,cur){if(typeof n!=="number")return "-";try{return new Intl.NumberFormat("en-US",{style:"currency",currency:cur||"USD",minimumFractionDigits:cur&&cur!=="USD"?0:2,maximumFractionDigits:cur&&cur!=="USD"?0:2}).format(n)}catch(e){return (cur||"USD")+" "+n.toFixed(0)}}
function bw(b,s){return b?b+" "+s:s}
// short source label: body or domain, a short legal reference if the title carries one; the full title goes in title/aria-label
function shortSrc(src){var n=src.name||"",h="";try{h=new URL(src.url).hostname.replace(/^www\./,"")}catch(e){}
 if(/^Secondary source/.test(n))return "Secondary · "+(h||"EOR Scope");
 var o=n.split(/\s[\u2014\u2013-]\s/)[0];if(o===n||o.length>40)o=h||(n.length>40?n.slice(0,39)+"\u2026":n);
 if(o.length>24){var ini=o.split(/[\s\x27\u2019-]+/).filter(function(w){return /^[A-Z]/.test(w)}).map(function(w){return w[0]}).join(""),ac=(n.match(/\b[A-Z][A-Z0-9]{1,5}\b/g)||[]).filter(function(x){return ini.indexOf(x)===0})[0];o=ac||h||o}
 var m=n.match(/S\.O\.\s?\d+(\([A-Z]\))?|\b(section|article|art\.)\s?\d+[a-z]?\b|\u00a7\s?\d+[a-z]?/i);
 return m&&o.indexOf(m[0])<0?o+" \u00b7 "+m[0]:o||"Source"}
function link(href,text){var a=el("a",null,text);a.href=href;a.target="_blank";a.rel="noopener";
 a.addEventListener("click",function(ev){ev.preventDefault();openLink(href)});return a}
function seg(label,cur,set,opts){var g=el("div","seg");g.setAttribute("role","group");g.setAttribute("aria-label","Show "+label.toLowerCase());
 (opts||[["month","Monthly"],["year","Annual"]]).forEach(function(o){var b=el("button",null,o[1]);b.type="button";b.setAttribute("aria-pressed",String(cur===o[0]));
  b.addEventListener("click",function(){set(o[0])});g.appendChild(b)});var w=el("div");add(w,el("label",null,label),g);return w}
function foot(root,d){var m=d.meta||{};root.appendChild(el("p","disc",m.disclaimer||"Cost comparison, not legal or tax advice."));
 var p=el("p","small");add(p,document.createTextNode((m.license||"")+" Data snapshot "+(m.snapshot_date||"")+". "));
 if(m.methodology_url)p.appendChild(link(m.methodology_url,"Methodology"));root.appendChild(p)}
`;

const page = (title: string, script: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><main id="root"><p class="empty">Loading…</p></main><script>${HELPERS}${script}${BRIDGE}</script></body></html>`;

const LEDGER_JS = String.raw`
var APP={info:{name:"eorscope-ledger",version:"1"},modes:["inline","fullscreen"]};
function per(){return state.period==="year"?"year":"month"}
// display currency: the country's (at the output's own exchange rate, salary.fx.local_per_usd) or USD
function rate(){var f=data.salary.fx;return f&&f.local_per_usd}
function cur(){var c=data.country.currency;return state.show==="local"&&c&&c!=="USD"&&rate()?c:"USD"}
function cv(n){return cur()==="USD"?n:n*rate()}
function amt(o){return cv(per()==="year"?o.annual_usd:o.monthly_usd)}
function m(n){return money(n,cur())}
function inp0(d){var i=d.salary_input||{},b=d.salary_basis;if(i.salary!=null)return i.salary;
 if(i.salary_period==="month"&&b)return b.monthly;return Math.round(i.salary_currency==="local"&&rate()?d.salary.annual_usd*rate():d.salary.annual_usd)}
function baseText(l){var cur=l.currency,t=[];
 if(l.type==="statutory_extra")return l.kind==="months"?l.value+" month(s) of salary":l.kind==="days"?l.value+" day(s) of salary":"";
 if(l.base==="flat")return l.flat_annual_local!=null?"fixed "+money(l.flat_annual_local,cur)+" a year":"fixed amount";
 t.push(l.base==="basic"?"basic wage":l.base==="band"?"salary band":"gross");
 if(l.base_factor)t.push("x "+l.base_factor);
 if(l.base_floor_annual_local!=null)t.push("floor "+money(l.base_floor_annual_local,cur));
 if(l.base_cap_annual_local!=null)t.push("ceiling "+money(l.base_cap_annual_local,cur));
 if(l.applies_from_gross_annual_local!=null)t.push("from "+money(l.applies_from_gross_annual_local,cur));
 if(l.applies_up_to_gross_annual_local!=null)t.push("up to "+money(l.applies_up_to_gross_annual_local,cur));
 return t.join(", ")}
function csv(d){var q=function(v){v=v==null?"":String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
 var c=d.country,e=d.employer_cost,x=c.currency&&c.currency!=="USD"&&rate(),lc=function(o){return x?[Math.round(o.monthly_usd*x*100)/100,Math.round(o.annual_usd*x*100)/100]:[]},
 rows=[["line","rate","base","monthly_usd","annual_usd","ceiling_reached","source","source_url","checked_at"].concat(x?["monthly_"+c.currency.toLowerCase(),"annual_"+c.currency.toLowerCase()]:[])];
 d.lines.forEach(function(l){var s=l.source||{};rows.push([l.name,l.rate_printed||"",baseText(l),l.monthly_usd,l.annual_usd,l.capped?"yes":"",s.name||"",s.url||"",s.checked_at||""].concat(lc(l)))});
 rows.push(["Statutory employer charges"+(e.values.bound?" ("+e.values.bound+")":""),e.pct_of_gross,"",e.values.monthly_usd,e.values.annual_usd,"","","",""].concat(lc(e.values)));
 var head=[["country",c.name],["gross_salary_annual_usd",d.salary.annual_usd],["gross_salary_annual_local",d.salary.annual_local||""],["scenario",d.scenario_url||""],["note",d.meta.disclaimer],["license",d.meta.license],[]];
 return head.concat(rows).map(function(r){return r.map(q).join(",")}).join("\r\n")}
function copy(text,msg){var done=function(){msg.textContent="Copied: one row per line, with its source and check date."};
 var fall=function(){var t=el("textarea");t.value=text;t.setAttribute("aria-label","Ledger as CSV");t.rows=6;t.style.width="100%";msg.textContent="Copy blocked by the host: select the text below.";msg.appendChild(t);t.select()};
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,fall);else fall()}
function render(d){var root=document.getElementById("root");if(!d||!d.lines)return;root.textContent="";
 var c=d.country,e=d.employer_cost,b=e.values.bound,i=d.salary_input||{},ic=i.salary_currency==="local"?"local":"USD",ip=i.salary_period==="month"?"month":"year",v=Math.round(inp0(d)*100)/100;
 if(state.amount==null)save({amount:v,in_cur:ic,in_per:ip,ppy:i.payments_per_year,show:ic,period:state.period||ip});
 else if((state.amount!==v||state.in_cur!==ic||state.in_per!==ip)&&!render.asked){render.asked=1;update()}
 var lo=cur()!=="USD",sal=lo?d.salary.annual_local+" a year ("+money(d.salary.annual_usd)+")":money(d.salary.annual_usd)+" a year"+(d.salary.annual_local?" ("+d.salary.annual_local+")":"");
 add(root,el("h1",null,c.name+(c.priced_for?" ("+c.priced_for+" rates)":"")),
  el("p","sub","Gross salary "+sal+". Statutory employer charges, before any EOR fee."),
  d.salary_basis&&el("p","sub","Salary basis: "+d.salary_basis.composition+"."));
 var f=el("form","bar"),lab=el("label",null,"Gross "+(state.in_per==="month"?"monthly":"annual")+" salary, "+(state.in_cur==="local"?c.currency:"USD")),inp=el("input");inp.type="number";inp.min="1";inp.step="any";inp.inputMode="decimal";inp.id="s";lab.htmlFor="s";inp.value=state.amount;
 var go=el("button","primary","Recalculate");go.type="submit";var w=el("div");add(w,lab,inp);
 f.addEventListener("submit",function(ev){ev.preventDefault();var n=Number(inp.value);if(n>0){save({amount:n});update()}});
 add(f,w,go,seg("Amounts",per(),function(p){save({period:p});render(data)}));
 if(c.currency&&c.currency!=="USD"&&rate())f.appendChild(seg("Currency",lo?"local":"USD",function(x){save({show:x});render(data)},[["local",c.currency],["USD","USD"]]));
 root.appendChild(f);
 var tot=el("p");add(tot,el("span","big",e.values.monthly_usd===0?"none":bw(b,m(amt(e.values)))),el("span","sub"," per "+per()+", "+bw(b,"+"+e.pct_of_gross)+" of gross"+(e.excludes?", excluding "+e.excludes:"")));root.appendChild(tot);
 var fx=d.salary.fx||{},tw=el("div","wrap"),t=el("table"),cap=el("caption",null,"One row per statutory line, with its source (official wherever one exists) and check date. Amounts in "+cur()+" per "+per()+(lo?", at "+rate()+" "+c.currency+" per USD ("+fx.source+", "+fx.date+")":"")+".");
 var hr=el("tr");["Line","Rate","Base","Amount","Source"].forEach(function(h,i){var th=el("th",i===3?"n":null,h);th.scope="col";hr.appendChild(th)});
 add(t,cap,add(el("thead"),hr));var tb=el("tbody");
 d.lines.forEach(function(l){var r=el("tr"),n=el("td",null,l.name);
  if(l.capped)n.appendChild(el("span","tag","ceiling reached"));
  if(l.skipped)n.appendChild(el("span","tag w","not applied"+(l.skipped_reason?": "+l.skipped_reason:"")));
  var s=el("td"),src=l.source||{},sl=src.url?link(src.url,shortSrc(src)):src.name?el("span",null,shortSrc(src)):null;
  if(sl){if(src.name){sl.title=src.name;sl.setAttribute("aria-label",src.name)}s.appendChild(sl)}
  if(src.checked_at)add(s,el("br"),el("span","src","checked "+src.checked_at));
  add(r,n,el("td","n",l.rate_printed||""),el("td",null,baseText(l)),el("td","n",m(amt(l))),s);tb.appendChild(r)});
 var fr=el("tr"),ft=el("td",null,"Total statutory employer charges");ft.colSpan=3;add(fr,ft,el("td","n",e.values.monthly_usd===0?"none":bw(b,m(amt(e.values)))),el("td"));
 add(t,tb,add(el("tfoot"),fr));tw.appendChild(t);root.appendChild(tw);
 if(b)root.appendChild(el("p","small","The country declares this total as a "+(b==="at least"?"floor":"ceiling")+": read it as \""+b+"\"."));
 var g=d.included_in_gross_salary;
 if(g&&g.lines.length)root.appendChild(el("p","small","Included in the gross salary: "+g.lines.map(function(x){return x.name}).join("; ")+" ("+g.months+" of the "+g.payments_per_year+" monthly payments)."));
 if(d.not_in_total&&d.not_in_total.length)root.appendChild(el("p","small","Not in the total: "+d.not_in_total.map(function(x){return x.name}).join("; ")+"."));
 var act=el("div","bar"),cp=el("button",null,"Copy as CSV"),msg=el("p","small");cp.type="button";msg.setAttribute("role","status");
 cp.addEventListener("click",function(){copy(csv(data),msg)});act.appendChild(cp);
 if(d.scenario_url){var p=el("p","small");add(p,document.createTextNode("Same scenario on the site: "),link(d.scenario_url,"eorscope.com calculator"));act.appendChild(p)}
 add(root,act,msg);foot(root,d)}
// recalculation: the same tool, in the currency and period the salary was given in
function update(){var a={country:data.country.iso,salary:state.amount,salary_currency:state.in_cur,salary_period:state.in_per},u={};
 if(state.in_per==="month"&&state.ppy!=null)a.payments_per_year=state.ppy;
 (data.assumptions||[]).forEach(function(x){if(x.used!=null)u[x.id]=x.used});if(Object.keys(u).length)a.assumptions=u;callTool("show_ledger",a).then(function(r){accept(r)}).catch(function(){})}
`;

const COMPARE_JS = String.raw`
var APP={info:{name:"eorscope-compare",version:"1"},modes:["inline","fullscreen"]};
function per(){return state.period==="year"?"year":"month"}
function render(d){var root=document.getElementById("root");if(!d||!d.offers)return;root.textContent="";
 if(d.offers.length>3&&!render.full){render.full=1;askMode("fullscreen")}
 add(root,el("h1",null,"Total employer cost of each offer"),el("p","sub","Gross salary plus statutory employer charges, before any EOR fee. Rows in the order given."));
 var f=el("div","bar");f.appendChild(seg("Amounts",per(),function(p){save({period:p});render(data)}));
 if(d.offers.length<=3&&canMode("fullscreen")){var fs=el("button",null,"Full screen");fs.type="button";fs.addEventListener("click",function(){askMode("fullscreen")});f.appendChild(fs)}
 root.appendChild(f);
 var y=per()==="year",tw=el("div","wrap"),t=el("table"),hr=el("tr");
 t.appendChild(el("caption",null,"Amounts in USD per "+per()+". Difference and ratio are against the smallest total ("+d.smallest_total.name+")."));
 ["Country","Gross salary","Employer charges","Total cost","Difference","Ratio","Ceilings reached"].forEach(function(h,i){var th=el("th",i>0&&i<6?"n":null,h);th.scope="col";hr.appendChild(th)});
 add(t,add(el("thead"),hr));var tb=el("tbody");
 d.offers.forEach(function(o){var r=el("tr"),c=el("th");c.scope="row";c.appendChild(link(o.page_url,o.name));
  if(o.priced_for)add(c,el("br"),el("span","src",o.priced_for+" rates"));
  var s=el("td","n",money(y?o.salary.annual_usd:o.salary.annual_usd/12));if(o.salary.annual_local)add(s,el("br"),el("span","src",o.salary.annual_local+" a year"));
  var e=o.employer_cost.values,ch=el("td","n",bw(e.bound,money(y?e.annual_usd:e.monthly_usd)));add(ch,el("br"),el("span","src",bw(e.bound,"+"+o.employer_cost.pct_of_gross)));
  var df=o.difference_from_smallest_annual_usd;
  add(r,c,s,ch,el("td","n",bw(o.total.bound,money(y?o.total.annual_usd:o.total.monthly_usd))),
   el("td","n",df===0?"-":bw(o.total.bound,"+"+money(y?df:df/12))),el("td","n",o.ratio_to_smallest.toFixed(3)),
   el("td",null,o.ceilings_reached&&o.ceilings_reached.length?o.ceilings_reached.map(function(x){return x.name}).join("; "):"none"));tb.appendChild(r)});
 add(t,tb);tw.appendChild(t);root.appendChild(tw);
 root.appendChild(el("p","small",d.reading));foot(root,d)}
`;

export const LEDGER_HTML = page('EOR Scope ledger', LEDGER_JS);
export const COMPARE_HTML = page('EOR Scope comparison', COMPARE_JS);
