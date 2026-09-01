const $=id=>document.getElementById(id);
const state={rows:[]};
const today=new Date(); $("date").value=new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,10);

function normalCDF(z){return .5*(1+erf(z/Math.sqrt(2)))}
function erf(x){const s=x<0?-1:1,a=Math.abs(x),t=1/(1+.3275911*a);return s*(1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a))}
function overProb(mean,line,sd){return Math.max(.01,Math.min(.99,1-normalCDF((line-mean)/Math.max(sd,1))))}
function weighted(values){if(!values.length)return 0;let sw=0,s=0;values.slice(-20).forEach((v,i)=>{const w=(i+1);s+=v*w;sw+=w});return s/sw}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function styleAdjust(team,opp,market){
  const pos=(team.poss||50)-(opp.poss||50);
  const pressure=((team.attacks||0)/(opp.attacks||1))-1;
  const width=((team.crosses||0)/(opp.crosses||1))-1;
  if(market==="corners") return clamp(pos*.006+pressure*.7+width*.35,-1.2,1.2);
  if(market==="shots") return clamp(pos*.004+pressure*.8,-1.5,1.5);
  return clamp(pos*.003+pressure*.5,-1,1);
}
function makeStats(team,opp){
  const h=team.history||[], o=opp.history||[];
  const shots=weighted(h.map(x=>x.shots||0)), shotsAgainst=weighted(h.map(x=>x.shotsAgainst||0));
  const sot=weighted(h.map(x=>x.sot||0)), sotAgainst=weighted(h.map(x=>x.sotAgainst||0));
  const corners=weighted(h.map(x=>x.corners||0)), cornersAgainst=weighted(h.map(x=>x.cornersAgainst||0));
  const poss=weighted(h.map(x=>x.poss||50)), attacks=weighted(h.map(x=>x.attacks||0)), crosses=weighted(h.map(x=>x.crosses||0));
  const oppShotsAgainst=weighted(o.map(x=>x.shotsAgainst||0)), oppSotAgainst=weighted(o.map(x=>x.sotAgainst||0)), oppCornersAgainst=weighted(o.map(x=>x.cornersAgainst||0));
  const oppPoss=weighted(o.map(x=>x.poss||50)), oppAttacks=weighted(o.map(x=>x.attacks||0)), oppCrosses=weighted(o.map(x=>x.crosses||0));
  const shot=(shots*.55+oppShotsAgainst*.45)+styleAdjust({poss,attacks,crosses},{poss:oppPoss,attacks:oppAttacks,crosses:oppCrosses},"shots");
  const s=(sot*.55+oppSotAgainst*.45);
  const cor=(corners*.55+oppCornersAgainst*.45)+styleAdjust({poss,attacks,crosses},{poss:oppPoss,attacks:oppAttacks,crosses:oppCrosses},"corners");
  return {shots:shot,sot:s,corners:cor,poss,attacks,crosses,n:h.length};
}
function predict(f){
  const H=makeStats(f.home,f.away), A=makeStats(f.away,f.home);
  const lines=[
    ["shots",`${f.home.name} shots`,H.shots,10.5],["shots",`${f.away.name} shots`,A.shots,8.5],
    ["shots","Match shots",H.shots+A.shots,24.5],
    ["sot",`${f.home.name} SOT`,H.sot,3.5],["sot",`${f.away.name} SOT`,A.sot,2.5],
    ["sot","Match SOT",H.sot+A.sot,7.5],
    ["corners",`${f.home.name} corners`,H.corners,4.5],["corners",`${f.away.name} corners`,A.corners,3.5],
    ["corners","Match corners",H.corners+A.corners,8.5]
  ];
  return lines.map(([market,name,mean,line])=>{
    const sd=market==="corners"?Math.max(1.8,mean*.25):market==="sot"?Math.max(1.4,mean*.24):Math.max(3,mean*.24);
    const p=overProb(mean,line,sd);
    const score=Math.round(clamp(p*100,1,95));
    const grade=score>=80?"strong":score>=70?"value":score>=62?"watch":"avoid";
    const quality=Math.min(H.n,A.n)/20;
    return {match:`${f.home.name} vs ${f.away.name}`,league:f.league||"Football",market,name,mean,line,p,score,grade,quality,why:reason(market,H,A)};
  });
}
function reason(m,H,A){
  if(m==="corners")return `Corner pressure from creation/concession rates, territorial profile and width. Sample: ${H.n}/${A.n} matches.`;
  if(m==="shots")return `Shot volume blended with opponent shot concession and style pressure. Sample: ${H.n}/${A.n} matches.`;
  return `SOT production blended with opponent SOT allowed and shot efficiency context. Sample: ${H.n}/${A.n} matches.`;
}
function render(){
  let rows=state.rows.filter(r=>($("market").value==="all"||r.market===$("market").value)&&($("grade").value==="all"||r.grade===$("grade").value));
  const s=$("sort").value;
  rows.sort((a,b)=>s==="prob"?b.p-a.p:s==="edge"?(b.p-.5)-(a.p-.5):b.score-a.score);
  $("fixtureCount").textContent=new Set(rows.map(x=>x.match)).size;
  $("strongCount").textContent=rows.filter(x=>x.grade==="strong").length;
  $("valueCount").textContent=rows.filter(x=>x.grade==="value").length;
  $("avgConfidence").textContent=rows.length?Math.round(avg(rows.map(x=>x.p))*100)+"%":"—";
  $("empty").style.display=rows.length?"none":"block";
  $("cards").innerHTML=rows.slice(0,40).map(x=>`<article class="pick">
    <div class="pick-top"><div><div class="match">${x.match}</div><div class="league">${x.league}</div></div><span class="grade ${x.grade}">${x.grade.toUpperCase()}</span></div>
    <div class="pick-grid">
      <div class="cell"><small>Market</small><b>${x.name} O${x.line}</b></div>
      <div class="cell"><small>Projection</small><b>${x.mean.toFixed(1)}</b></div>
      <div class="cell"><small>Probability</small><b>${Math.round(x.p*100)}%</b></div>
      <div class="cell"><small>Confidence</small><b class="score">${x.score}</b></div>
      <div class="cell"><small>Sample</small><b>${Math.round(x.quality*20)}/20</b></div>
    </div>
    <div class="why"><b>Why:</b> ${x.why}</div>
  </article>`).join("");
}
function demo(){
  const mk=(name,base,opp)=>Array.from({length:20},(_,i)=>({shots:base+(i%5-2),shotsAgainst:opp+(i%4-1),sot:base*.36+(i%3-.8),sotAgainst:opp*.33+(i%3-.8),corners:base*.40+(i%4-1),cornersAgainst:opp*.36+(i%3-.8),poss:50+(base-opp)*.7,attacks:90+base*2,crosses:14+base*.5}));
  const fs=[
    {league:"Demo Premier",home:{name:"North City",history:mk("North",16,10)},away:{name:"Riverside",history:mk("River",11,15)}},
    {league:"Demo League",home:{name:"United Park",history:mk("United",14,12)},away:{name:"Athletic Club",history:mk("Athletic",12,14)}},
    {league:"Demo Cup",home:{name:"Harbor FC",history:mk("Harbor",10,14)},away:{name:"Metro FC",history:mk("Metro",15,10)}}
  ];
  state.rows=fs.flatMap(predict);$("status").textContent="Demo data";$("statusText").textContent="Model is running locally on sample history."; $("statusDot").style.background="var(--yellow)";$("updated").textContent=new Date().toLocaleTimeString();render();
}
async function scan(){
  $("status").textContent="Scanning…";$("statusText").textContent="Fetching fixtures and historical statistics."; $("statusDot").style.background="var(--blue)";
  try{
    const res=await fetch(`/api/scan?date=${$("date").value}`);
    if(!res.ok)throw new Error((await res.json()).error||"API error");
    const json=await res.json(); state.rows=json.rows||[];
    $("status").textContent="Live API";$("statusText").textContent=`Scanned ${json.fixtures||0} fixtures.`;$("statusDot").style.background="var(--green)";
    $("updated").textContent=new Date().toLocaleTimeString();render();
  }catch(e){$("status").textContent="API not connected";$("statusText").textContent=e.message; $("statusDot").style.background="var(--red)";demo()}
}
$("demoBtn").onclick=demo;$("scanBtn").onclick=scan;$("market").onchange=render;$("grade").onchange=render;$("sort").onchange=render;
demo();
