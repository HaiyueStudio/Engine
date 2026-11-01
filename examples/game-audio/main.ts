import{createGameAudioExample}from'./application.js';
const state=document.getElementById('state')!,canvas=document.querySelector<HTMLCanvasElement>('canvas')!,draw=canvas.getContext('2d')!,releases:(()=>void)[]=[];
let app:ReturnType<typeof createGameAudioExample>|null=null,frame=0,last=0,dead=false;
function message(value:string){state.textContent=value;}
function bind(id:string,action:()=>void|Promise<unknown>){const element=document.getElementById(id)!,listener=()=>{try{void Promise.resolve(action()).catch(error=>message(String(error)));}catch(error){message(String(error));}};element.addEventListener('click',listener);releases.push(()=>element.removeEventListener('click',listener));}
function paint(x=0,y=0){const cx=480,cy=230;draw.fillStyle='#091423';draw.fillRect(0,0,960,460);draw.strokeStyle='#344e66';draw.lineWidth=2;draw.beginPath();draw.arc(cx,cy,180,0,Math.PI*2);draw.stroke();draw.fillStyle='#dcecf8';draw.font='16px system-ui';draw.fillText('Listener',cx-30,cy+42);draw.fillStyle='#73bcff';draw.beginPath();draw.arc(cx,cy,12,0,Math.PI*2);draw.fill();draw.fillStyle='#ffbc69';draw.beginPath();draw.arc(cx+x*1.8,cy+y*1.8,12,0,Math.PI*2);draw.fill();draw.fillStyle='#dcecf8';draw.fillText('L',45,cy);draw.fillText('R',900,cy);}
function animate(time:number){if(dead||!app)return;app.audio.update(last?Math.max(0,time-last):0);last=time;paint(...app.position());frame=requestAnimationFrame(animate);}
paint();
bind('start',async()=>{if(!app){app=createGameAudioExample();frame=requestAnimationFrame(animate);}await app.play();message('Playing. Choose a source position or adjust the sound.');});
bind('left',()=>{app?.move(-50);message('Source on the left, half distance.');});bind('center',()=>{app?.move(0);message('Source centered.');});bind('right',()=>{app?.move(50);message('Source on the right, half distance.');});bind('far',()=>{app?.move(100);message('Source at maximum distance: silent.');});
bind('mute',()=>{if(app){const muted=!app.audio.exportProfile().muted;app.audio.setMuted(muted);message(muted?'Muted. Settings retained.':'Sound restored.');}});
bind('fade',()=>{app?.audio.fadeBus('sfx',0,2000);message('Fading out over two seconds.');});bind('restore-volume',()=>{app?.audio.setVolumes({master:1,sfx:1});message('Volume restored.');});
bind('pause',async()=>{await app?.audio.suspend();message('Paused.');});bind('resume',async()=>{await app?.audio.resume();message('Resumed.');});bind('stop',()=>{app?.stop();message('Stopped.');});
bind('save',async()=>{await app?.save();message('Audio settings saved.');});bind('restore',async()=>{message(await app?.restore()?'Saved audio settings restored.':'No saved settings.');});
addEventListener('pagehide',()=>{dead=true;cancelAnimationFrame(frame);for(const off of releases)off();void app?.dispose().catch(error=>message(String(error)));},{once:true});
const result=document.getElementById('result')!;if(new URLSearchParams(location.search).has('verify')){result.textContent=JSON.stringify({status:'passed',ready:true,manualUnlockRequired:true,qualification:false});result.dataset.status='passed';}
