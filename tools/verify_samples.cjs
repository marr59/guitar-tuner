// Gate (steady part, t>=0.2 s, must stay within 1.2 cents (the detector itself is good to ~0.3-0.5 cents on a 100 ms window); the pick transient before that is
// non-stationary and reported separately): simulate the app's sampled reference tone (nearest sample + playbackRate curve,
// linear interpolation like a BufferSource) and measure it with the app's own detector.
const fs=require('fs'), cp=require('child_process'), path=require('path');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
eval(html.match(/function detectAgainst\(buf,sr,targetHz,rangeCents\)\{[\s\S]*?\n\}\n/)[0]);
const SR=48000; const idx=JSON.parse(fs.readFileSync(path.join(ROOT,'samples/index.json'))).samples;
const pcmCache={};
function pcm(name){ if(!pcmCache[name]){ const raw=cp.execSync(`ffmpeg -v error -i "${path.join(ROOT,'samples',name+'.mp3')}" -f f32le -ac 1 -ar ${SR} -`,{maxBuffer:1<<26}); pcmCache[name]=new Float32Array(raw.buffer,raw.byteOffset,raw.length/4);} return pcmCache[name]; }
function nearest(hz){ const midi=69+12*Math.log2(hz/440); let best=null; for(const s of idx){ const d=Math.abs(s.midi-midi); if(!best||d<best.d) best={s,d}; } return best.d<=2.6?best.s:null; }
function rateCurve(s,base){ const n=s.track.length,out=new Float32Array(n); for(let j=0;j<n;j++){ const i=Math.min(n-1,Math.round(j*base)); out[j]=base/Math.pow(2,s.track[i]/1200);} return out; }
function render(hz){
  const s=nearest(hz); if(!s) return null; const src=pcm(s.name); const base=hz/s.nominalHz; const curve=rateCurve(s,base); const dur=curve.length*s.hop;
  const N=Math.floor(dur*SR), out=new Float32Array(N); let pos=0;
  for(let n=0;n<N;n++){ const x=n/SR/s.hop; const i=Math.min(curve.length-1,Math.floor(x)); const f=x-i; const r=i+1<curve.length?curve[i]*(1-f)+curve[i+1]*f:curve[i];
    const i0=Math.floor(pos), fr=pos-i0; if(i0+1>=src.length) break; out[n]=src[i0]*(1-fr)+src[i0+1]*fr; pos+=r; }
  return {s,out};
}
const targets=[['F#1',46.2493],['B1',61.7354],['E2',82.4069],['A2',110],['D3',146.8324],['G3',195.9977],['B3',246.9417],['E4',329.6276],['A4',440],['C5',523.2511],['Eb2 (D# drop)',77.7817],['C#2',69.2957]];
let worst=0; const rows=[];
for(const [label,hz] of targets){
  const r=render(hz); if(!r){ rows.push(label+': no sample'); continue; }
  const errs=[]; let attack=null; for(let t=0.10;t+0.2<2.6;t+=0.1){ const win=Math.max(0.10,8/hz); const seg=r.out.subarray(Math.floor(t*SR),Math.floor((t+win)*SR)); const d=detectAgainst(seg,SR,hz,300); if(!d||d.conf<=0.6) continue; const e=1200*Math.log2(d.freq/hz); if(t<0.2){ attack=e; continue; } errs.push(e); }
  const mx=Math.max(...errs.map(Math.abs)); const mean=errs.reduce((a,b)=>a+b,0)/errs.length; worst=Math.max(worst,mx);
  rows.push(`${label.padEnd(14)} ${hz.toFixed(2).padStart(7)} Hz  via ${r.s.name.padEnd(3)} rate ${(hz/r.s.nominalHz).toFixed(3)}  mean ${mean>=0?'+':''}${mean.toFixed(2)}¢  max|err| ${mx.toFixed(2)}¢ from 0.2s (${errs.length} win)  attack@0.1s ${attack==null?'-':(attack>=0?'+':'')+attack.toFixed(1)}¢`);
}
console.log(rows.join('\n')); console.log('WORST', worst.toFixed(2),'cents', worst<=1.2?'PASS':'FAIL');
process.exit(worst<=1.2?0:1);
