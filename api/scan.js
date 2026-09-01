export default async function handler(req, res) {
  const token = process.env.SPORTMONKS_TOKEN;
  if (!token) return res.status(500).json({error:"SPORTMONKS_TOKEN is not configured. Add it in your hosting provider's environment variables."});
  const date = String(req.query.date || new Date().toISOString().slice(0,10));
  const base = "https://api.sportmonks.com/v3/football";
  const headers = { Authorization: token };

  async function get(path, params={}) {
    const url = new URL(base + path);
    Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
    const r = await fetch(url, {headers});
    if(!r.ok) throw new Error(`Sportmonks ${r.status}: ${await r.text()}`);
    return r.json();
  }

  function val(stat, names) {
    if (!stat) return 0;
    const name = String(stat.type?.name || stat.type?.developer_name || stat.type || "").toLowerCase();
    if (!names.some(n=>name.includes(n))) return null;
    const raw = stat.data?.value ?? stat.value ?? stat.data;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  function statValue(stats,names,location) {
    const hit=(stats||[]).find(s=>{
      const v=val(s,names); if(v===null)return false;
      return !location || String(s.location||"").toLowerCase()===location;
    });
    return hit ? val(hit,names) : 0;
  }
  function teamIdFromFixture(f, side) {
    const p=f.participants||[];
    const item=p.find(x=>String(x.meta?.location||"").toLowerCase()===side) || p.find(x=>String(x.location||"").toLowerCase()===side);
    return item?.id || item?.team_id || item?.participant_id;
  }
  function nameFromFixture(f,side) {
    const p=f.participants||[];
    const item=p.find(x=>String(x.meta?.location||"").toLowerCase()===side) || p.find(x=>String(x.location||"").toLowerCase()===side);
    return item?.name || (side==="home" ? (f.name||"").split(" vs ")[0] : (f.name||"").split(" vs ")[1]) || side;
  }
  function fixtureToRow(f,teamId) {
    const homeId=teamIdFromFixture(f,"home"), awayId=teamIdFromFixture(f,"away");
    const stats=f.statistics||[];
    const side=String(homeId)===String(teamId)?"home":"away";
    const opp=side==="home"?"away":"home";
    return {
      date:f.starting_at, shots:statValue(stats,["shots"],side), shotsAgainst:statValue(stats,["shots"],opp),
      sot:statValue(stats,["shots on target","shots on goal"],side), sotAgainst:statValue(stats,["shots on target","shots on goal"],opp),
      corners:statValue(stats,["corners"],side), cornersAgainst:statValue(stats,["corners"],opp),
      poss:statValue(stats,["possession"],side), attacks:statValue(stats,["attacks","dangerous attacks"],side),
      crosses:statValue(stats,["crosses"],side)
    };
  }
  function weighted(values) {
    const a=values.filter(x=>Number.isFinite(x)); if(!a.length)return 0;
    let s=0,w=0; a.slice(-20).forEach((v,i)=>{const ww=i+1;s+=v*ww;w+=ww}); return s/w;
  }
  function profile(history){
    return {
      shots:weighted(history.map(x=>x.shots)), shotsAgainst:weighted(history.map(x=>x.shotsAgainst)),
      sot:weighted(history.map(x=>x.sot)), sotAgainst:weighted(history.map(x=>x.sotAgainst)),
      corners:weighted(history.map(x=>x.corners)), cornersAgainst:weighted(history.map(x=>x.cornersAgainst)),
      poss:weighted(history.map(x=>x.poss)), attacks:weighted(history.map(x=>x.attacks)), crosses:weighted(history.map(x=>x.crosses)), n:history.length
    };
  }
  function adjust(t,o,m){
    const pos=(t.poss||50)-(o.poss||50), press=(t.attacks/(o.attacks||1))-1, width=(t.crosses/(o.crosses||1))-1;
    if(m==="corners")return Math.max(-1.2,Math.min(1.2,pos*.006+press*.7+width*.35));
    if(m==="shots")return Math.max(-1.5,Math.min(1.5,pos*.004+press*.8));
    return Math.max(-1,Math.min(1,pos*.003+press*.5));
  }
  function erf(x){const s=x<0?-1:1,a=Math.abs(x),t=1/(1+.3275911*a);return s*(1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-a*a)}
  function cdf(z){return .5*(1+erf(z/Math.sqrt(2)))}
  function over(mean,line,sd){return Math.max(.01,Math.min(.99,1-cdf((line-mean)/Math.max(sd,1))))}
  function predict(f,h,a){
    const hp=profile(h), ap=profile(a);
    const hs=(hp.shots*.55+ap.shotsAgainst*.45)+adjust(hp,ap,"shots");
    const as=(ap.shots*.55+hp.shotsAgainst*.45)+adjust(ap,hp,"shots");
    const hS=(hp.sot*.55+ap.sotAgainst*.45), aS=(ap.sot*.55+hp.sotAgainst*.45);
    const hc=(hp.corners*.55+ap.cornersAgainst*.45)+adjust(hp,ap,"corners");
    const ac=(ap.corners*.55+hp.cornersAgainst*.45)+adjust(ap,hp,"corners");
    const arr=[
      ["shots",`${f.home} shots`,hs,10.5],["shots",`${f.away} shots`,as,8.5],["shots","Match shots",hs+as,24.5],
      ["sot",`${f.home} SOT`,hS,3.5],["sot",`${f.away} SOT`,aS,2.5],["sot","Match SOT",hS+aS,7.5],
      ["corners",`${f.home} corners`,hc,4.5],["corners",`${f.away} corners`,ac,3.5],["corners","Match corners",hc+ac,8.5]
    ];
    return arr.map(([market,name,mean,line])=>{
      const sd=market==="corners"?Math.max(1.8,mean*.25):market==="sot"?Math.max(1.4,mean*.24):Math.max(3,mean*.24);
      const p=over(mean,line,sd),score=Math.round(Math.max(1,Math.min(95,p*100)));
      return {match:`${f.home} vs ${f.away}`,league:f.league?.name||f.league||"Football",market,name,mean,line,p,score,
        grade:score>=80?"strong":score>=70?"value":score>=62?"watch":"avoid",
        quality:Math.min(hp.n,ap.n),why:`Weighted last-${Math.min(hp.n,20)} history, opponent concession and style pressure.`};
    });
  }

  try {
    const fixtureJson=await get(`/fixtures/date/${date}`,{include:"participants;league"});
    const fixtures=(fixtureJson.data||[]).filter(f=>!f.state_id || [1,2,3].includes(Number(f.state_id)));
    const rows=[];
    for (const f of fixtures.slice(0,40)) {
      const hid=teamIdFromFixture(f,"home"), aid=teamIdFromFixture(f,"away");
      if(!hid||!aid) continue;
      const start=new Date(new Date(f.starting_at).getTime()-1000*60*60*24*180).toISOString().slice(0,10);
      const hJ=await get(`/fixtures/between/${start}/${date}/${hid}`,{include:"participants;statistics.type"});
      const aJ=await get(`/fixtures/between/${start}/${date}/${aid}`,{include:"participants;statistics.type"});
      const hHist=(hJ.data||[]).filter(x=>new Date(x.starting_at)<new Date(f.starting_at)).sort((x,y)=>new Date(x.starting_at)-new Date(y.starting_at)).slice(-20).map(x=>fixtureToRow(x,hid));
      const aHist=(aJ.data||[]).filter(x=>new Date(x.starting_at)<new Date(f.starting_at)).sort((x,y)=>new Date(x.starting_at)-new Date(y.starting_at)).slice(-20).map(x=>fixtureToRow(x,aid));
      rows.push(...predict({home:nameFromFixture(f,"home"),away:nameFromFixture(f,"away"),league:f.league},hHist,aHist));
    }
    res.status(200).json({date,fixtures:fixtures.length,rows});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
}
