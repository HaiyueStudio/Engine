/** Checks actual gallery pixels independently of widget state / GPU validation. */
export function validateGuiSpecialtyPixels(image,{theme,mode}){
 const errors=[],{width,height,data}=image;if(width!==1200||height!==1600||data.length!==width*height*4)return['Unexpected P3 screenshot dimensions'];
 const pixel=(x,y)=>Array.from(data.subarray((y*width+x)*4,(y*width+x)*4+4)),background=pixel(1184,850),brightness=background.slice(0,3).reduce((a,b)=>a+b,0)/3;
 if(background[3]!==255||(theme==='light'?brightness<180:brightness<3||brightness>70))errors.push('Opaque theme background missing');
 if(mode==='base')for(const [x,y]of [[40,300],[160,340],[300,390]]){const sample=pixel(x,y);if(sample.some((c,i)=>Math.abs(c-background[i])>3))errors.push('Closed calendar left pixels at '+x+','+y);}
 if(mode==='tour'&&pixel(120,1).some((c,i)=>Math.abs(c-background[i])>3))errors.push('Tour highlight leaked into the page origin');
 let dark=0,bright=0;for(let y=128;y<272;y++)for(let x=428;x<572;x++){const [r,g,b]=pixel(x,y);if(Math.max(r,g,b)<35)dark++;if(Math.min(r,g,b)>235)bright++;}
 if(dark<1500||bright<6000)errors.push('QR matrix/quiet-zone contrast is missing');return errors;
}
