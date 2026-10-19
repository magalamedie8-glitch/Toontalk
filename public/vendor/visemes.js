/* Mouth shapes from voice audio (same engine as the 2D ToonTalk app).
   shapes: 0 closed, 1 "aa", 2 "eh", 3 "ee", 4 "oh", 5 "oo", 6 teeth (s f v) */
const VIS_HOP=0.02;                         // one mouth decision every 20 ms
// shapes: 0 closed, 1 "aa" wide open, 2 "eh", 3 "ee" wide slit, 4 "oh" round, 5 "oo" small round, 6 teeth (s, f, v)
const VOWELS=[[1,730,1250],[2,560,1850],[3,310,2250],[4,500,950],[5,330,850]];
function lpcPeaks(x,order,sr){
  // autocorrelation LPC -> spectral envelope peaks (formants)
  const n=x.length,r=new Float64Array(order+1);
  for(let k=0;k<=order;k++){let s=0;for(let i=k;i<n;i++)s+=x[i]*x[i-k];r[k]=s;}
  if(r[0]<1e-9)return null;
  r[0]*=1.0001;
  const a=new Float64Array(order+1);a[0]=1;let e=r[0];
  for(let i=1;i<=order;i++){
    let acc=r[i];for(let j=1;j<i;j++)acc+=a[j]*r[i-j];
    const k=-acc/e,t=a.slice();
    for(let j=1;j<i;j++)a[j]=t[j]+k*t[i-j];
    a[i]=k;e*=1-k*k;if(e<=0)break;
  }
  const F0=200,F1=3400,N=90,env=new Float64Array(N);
  for(let m=0;m<N;m++){
    const w=2*Math.PI*(F0+(F1-F0)*m/(N-1))/sr;let re=0,im=0;
    for(let j=0;j<=order;j++){re+=a[j]*Math.cos(w*j);im-=a[j]*Math.sin(w*j);}
    env[m]=1/Math.sqrt(re*re+im*im+1e-12);
  }
  const peaks=[];
  for(let m=1;m<N-1;m++)if(env[m]>env[m-1]&&env[m]>=env[m+1])peaks.push({f:F0+(F1-F0)*m/(N-1),v:env[m]});
  return peaks;
}
export function analyzeVisemes(buf){
  const sr0=buf.sampleRate,ch=buf.numberOfChannels,len=buf.length;
  const mono=new Float32Array(len);
  for(let c=0;c<ch;c++){const d=buf.getChannelData(c);for(let i=0;i<len;i++)mono[i]+=d[i]/ch;}
  const dec=Math.max(1,Math.round(sr0/11025)),sr=sr0/dec,m=Math.floor(len/dec),x=new Float32Array(m);
  for(let i=0;i<m;i++){let s=0;for(let k=0;k<dec;k++)s+=mono[i*dec+k];x[i]=s/dec;}
  const hop=Math.round(VIS_HOP*sr),win=Math.round(0.035*sr),nF=Math.max(1,Math.floor(m/hop));
  const rms=new Float32Array(nF),hf=new Float32Array(nF),shape=new Uint8Array(nF),f1=new Float32Array(nF),f2=new Float32Array(nF);
  for(let f=0;f<nF;f++){
    const c=f*hop+(hop>>1),a=Math.max(0,c-(win>>1)),b=Math.min(m,a+win);
    let e=0,d=0,p=0;
    for(let i=a;i<b;i++){e+=x[i]*x[i];if(i>0){const df=x[i]-x[i-1];d+=df*df;}}
    rms[f]=Math.sqrt(e/Math.max(1,b-a));hf[f]=e>1e-12?d/e:0;
  }
  const sorted=Array.from(rms).sort((p,q)=>p-q),ref=sorted[Math.floor(sorted.length*0.92)]||1e-6;
  const quiet=ref*0.07;
  const vow=[];
  for(let f=0;f<nF;f++){
    if(rms[f]<quiet){shape[f]=0;continue;}
    if(hf[f]>0.9&&rms[f]<ref*0.7){shape[f]=6;continue;}     // hissing sounds: s, sh, f
    // vowel-like: find the first two formants
    const c=f*hop+(hop>>1),a=Math.max(0,c-(win>>1)),b=Math.min(m,a+win),seg=new Float32Array(b-a);
    for(let i=a;i<b;i++){const w=0.5-0.5*Math.cos(2*Math.PI*(i-a)/Math.max(1,b-a-1));seg[i-a]=(x[i]-(i>0?0.95*x[i-1]:0))*w;}
    const pk=lpcPeaks(seg,12,sr);
    if(!pk||!pk.length){shape[f]=2;continue;}
    let p1=pk.filter(q=>q.f>=250&&q.f<=1000).sort((p,q)=>q.v-p.v)[0];
    let p2=pk.filter(q=>q.f>(p1?p1.f+250:900)&&q.f<=2900).sort((p,q)=>q.v-p.v)[0];
    const F1=p1?p1.f:600,F2=p2?p2.f:(p1?Math.min(2400,p1.f*1.8):1400);
    f1[f]=F1;f2[f]=F2;shape[f]=255;vow.push(f);
  }
  // speaker scale (men and women have different formant ranges): use the middle of this speaker's F2 values
  let sc=1;
  if(vow.length>8){const arr=vow.map(f=>f2[f]).sort((p,q)=>p-q);sc=Math.max(0.85,Math.min(1.25,arr[arr.length>>1]/1550));}
  for(const f of vow){
    let best=2,bd=1e9;
    for(const [id,p1,p2] of VOWELS){
      const d=Math.pow(Math.log(f1[f]/(p1*sc)),2)*1.4+Math.pow(Math.log(f2[f]/(p2*sc)),2);
      if(d<bd){bd=d;best=id;}
    }
    shape[f]=best;
  }
  // smooth: 3-frame majority, then keep every shape at least 2 frames (40 ms)
  const sm=shape.slice();
  for(let f=1;f<nF-1;f++){const a=shape[f-1],b=shape[f],c=shape[f+1];if(a===c&&b!==a)sm[f]=a;}
  const open=new Uint8Array(nF);
  for(let f=0;f<nF;f++){
    let o=Math.min(1.15,Math.pow(rms[f]/ref,0.6));
    if(f>0&&f<nF-1)o=(o+Math.min(1.15,Math.pow(rms[f-1]/ref,0.6))*0.5+Math.min(1.15,Math.pow(rms[f+1]/ref,0.6))*0.5)/2;
    open[f]=sm[f]===0?0:Math.round(Math.max(0.25,Math.min(1,o))*255);
  }
  return {hop:VIS_HOP,shape:sm,open,n:nF};
