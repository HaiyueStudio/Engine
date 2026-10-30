import type {
  AnimationText2DComponent,
  AnimationTextAnimator,
  AnimationTextDocumentKeyframe,
  AnimationVectorValueTrack,
} from '@haiyue/animation-spec';
import { evaluateSafeExpression } from '@haiyue/animation-spec';

/** Private drawing contract; published declarations do not require vendor types. */
export interface AnimationOutlineFont {
  readonly unitsPerEm?: number;
  readonly ascender?: number;
  readonly descender?: number;
  getAdvanceWidth?(text: string, fontSize: number, options: {kerning: boolean; features: {liga: boolean; rlig: boolean}}): number;
  readonly glyphs?: Readonly<{get(index: number): Readonly<{
    readonly advanceWidth?: number | undefined;
    getBoundingBox(): Readonly<{x1: number; y1: number; x2: number; y2: number}>;
    getPath(x: number, y: number, fontSize: number): AnimationOutlinePath;
  }>}>;
  getPath(text: string, x: number, y: number, fontSize: number,
    options: { kerning: boolean; features: { liga: boolean; rlig: boolean } }): AnimationOutlinePath;
}

interface AnimationOutlinePath {
  readonly commands: readonly {
    readonly type: string;
    readonly x?: number;
    readonly y?: number;
    readonly x1?: number;
    readonly y1?: number;
    readonly x2?: number;
    readonly y2?: number;
  }[];
}

export interface AnimationStateTextDocument {readonly value?: string; readonly fontSize?: number; readonly tracking?: number; readonly color?: readonly [number, number, number, number];}

type TextTexture = HTMLCanvasElement | ImageBitmap;
export interface AnimationTextBitmapSnapshot {
  readonly value: ImageBitmap; readonly generation: number; readonly bytes: number;
  /** One idempotent CPU bitmap lease; GPU ownership belongs to the draw/texture owner. */
  release(): void;
}
export class AnimationTextSnapshotPending extends Error {
  readonly code = 'E_HYA_RUNTIME_RESOURCE_PENDING'; readonly path = '$.core.text.bitmap';
  constructor(readonly ready: Promise<void>) {super('The latest core text bitmap is pending'); void ready.catch(() => {});}
}
interface RetainedBitmap {readonly value: ImageBitmap; readonly generation: number; readonly bytes: number; refs: number; retired: boolean;}

interface ResolvedTextDocument {
  readonly fontResource?: string|undefined;
  readonly state?: AnimationStateTextDocument;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontStyle: 'normal' | 'italic';
  lineHeight: number;
  tracking: number;
  textAlign: 'left' | 'center' | 'right';
  color: readonly [number, number, number, number];
}

interface GlyphState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  tracking: number;
  color: [number, number, number, number];
}

interface ResolvedRunStyle extends Omit<ResolvedTextDocument, 'text' | 'textAlign'> {
  readonly key: number;
  readonly lineBackground?: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']>;
}

interface StyledGlyph {
  readonly value: string;
  readonly style: ResolvedRunStyle;
}

interface StyledLine {
  readonly glyphs: readonly StyledGlyph[];
  readonly paragraphEnd: boolean;
}

interface StyledLineLayout {
  readonly line: StyledLine;
  readonly metrics: ReturnType<typeof measureStyledLine>;
  readonly x: number;
  readonly top: number;
  readonly baseline: number;
  readonly height: number;
}

interface BackgroundRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface SelectorIndexPlan {
  readonly indices: readonly number[];
  readonly count: number;
}

/** Runtime-private deterministic grapheme shaper and Canvas atlas uploader. */
export class AnimationTextRasterizer {
  texture: TextTexture | null = null;
  textureVersion = 0;
  private readonly canvas: HTMLCanvasElement | null;
  private time = Number.NaN;
  private dirty = true;
  private updating = false;
  private destroyed = false;
  private readonly bitmapSnapshots = new Map<ImageBitmap, RetainedBitmap>();
  private updateToken = 0;
  private readonly animated: boolean;
  private stateDocument: AnimationStateTextDocument = Object.freeze({});
  private stateDocumentKey = '{}';
  private textureFailure: unknown;
  private textureFailed = false;
  private readonly readyWaiters = new Set<{resolve(): void; reject(error: unknown): void}>();
  private readonly expressionData = new Map<string, unknown>();
  private readonly outlineFonts = new Map<string, PreparedAnimationFont>();

  constructor(readonly component: Readonly<AnimationText2DComponent>, options: Readonly<{rasterize?: boolean}> = {}) {
    this.canvas = options.rasterize === false || typeof document === 'undefined' ? null : document.createElement('canvas');
    this.animated = component.expression !== undefined || (component.documents?.length ?? 0) > 1
      || component.paragraphSpacingTrack !== undefined
      || (component.styleRuns ?? []).some(run => run.fontSizeTrack || run.lineHeightTrack || run.trackingTrack)
      || (component.animators ?? []).some(animator => hasAnimatedAnimator(animator));
    void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */});
  }

  /** Internal production bridge; the original document, shaper and glyph renderer remain authoritative. */
  setStateDocument(value: AnimationStateTextDocument): void {
    if (this.destroyed) return;
    const next = Object.freeze({...value, ...(value.color ? {color: Object.freeze([...value.color]) as readonly [number, number, number, number]} : {})});
    if (Object.keys(next).some(key => !['value', 'fontSize', 'tracking', 'color'].includes(key)) || next.value !== undefined && typeof next.value !== 'string'
      || next.fontSize !== undefined && (!Number.isFinite(next.fontSize) || next.fontSize <= 0) || next.tracking !== undefined && !Number.isFinite(next.tracking)
      || next.color !== undefined && (next.color.length !== 4 || next.color.some(channel => !Number.isFinite(channel)))) throw new TypeError('Invalid production text document override');
    const key = JSON.stringify(next); if (key === this.stateDocumentKey) return;
    this.stateDocument = next; this.stateDocumentKey = key; this.textureFailure = undefined; this.textureFailed = false; this.dirty = true; void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */});
  }
  /** Resolves after the latest queued bitmap generation, rather than the first in-flight bitmap. */
  whenReady(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Animation text rasterizer is disposed'));
    if (this.textureFailed) return Promise.reject(this.textureFailure);
    if (!this.canvas || !this.updating && !this.dirty) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.add({resolve, reject}));
  }
  /** Capture only immutable, ready pixels. A mutable Canvas is never a production snapshot. */
  acquireTextureSnapshot(): AnimationTextBitmapSnapshot {
    if (this.destroyed) throw Object.assign(new Error('Animation text rasterizer is disposed'), {code: 'E_HYA_RUNTIME_DISPOSED', path: '$.core.text.bitmap'});
    if (this.textureFailed) throw this.textureFailure;
    if (this.updating || this.dirty && this.canvas) throw new AnimationTextSnapshotPending(this.whenReady());
    const value = this.texture;
    if (!value || value === this.canvas || typeof (value as ImageBitmap).close !== 'function')
      throw Object.assign(new Error('Core text drawing needs an immutable bitmap host'), {code: 'E_HYA_RUNTIME_HOST_PORT', path: '$.core.text.bitmap'});
    const bitmap = value as ImageBitmap, bytes = bitmap.width * bitmap.height * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError('Core text bitmap needs finite positive dimensions');
    let retained = this.bitmapSnapshots.get(bitmap);
    if (!retained) {retained = {value: bitmap, generation: this.textureVersion, bytes, refs: 0, retired: false}; this.bitmapSnapshots.set(bitmap, retained);}
    retained.refs++; const owned = retained; let closed = false;
    return Object.freeze({value: bitmap, generation: owned.generation, bytes: owned.bytes, release: () => {
      if (closed) return; closed = true; owned.refs--;
      if (!owned.refs) {this.bitmapSnapshots.delete(bitmap); if (owned.retired) bitmap.close();}
    }});
  }
  private retireTexture(value: TextTexture | null): void {
    if (!value || value === this.canvas) return;
    const bitmap = value as ImageBitmap, retained = this.bitmapSnapshots.get(bitmap);
    if (retained) retained.retired = true; else closeTextTexture(value, this.canvas);
  }
  private settleReady(error?: unknown, failed = false): void {for (const waiter of this.readyWaiters) failed ? waiter.reject(error) : waiter.resolve(); this.readyWaiters.clear();}

  setTime(time: number): void {
    if (!this.animated) return;
    if (this.time === time && !this.dirty) return;
    this.time = time;
    this.dirty = true;
    void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */});
  }

  invalidateFont(): void {
    this.dirty = true;
    void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */});
  }

  setOutlineFont(family: string, style: 'normal' | 'italic', weight: string | number, font: AnimationOutlineFont | undefined, resource?:string, nativeFamily?:string): void {
    if (this.destroyed) return;
    if(font||nativeFamily){
      const value=Object.freeze({resource,outline:font,nativeFamily:nativeFamily??family}),key=outlineFontKey(family,style,weight,resource);
      this.outlineFonts.set(key,value);
      if(resource!==undefined){
        const familyKey=outlineFontKey(family,style,weight),previous=this.outlineFonts.get(familyKey);
        if(!previous||!previous.ambiguous&&previous.resource===resource)this.outlineFonts.set(familyKey,value);
        else this.outlineFonts.set(familyKey,Object.freeze({nativeFamily:family,ambiguous:true}));
      }
    }
    this.invalidateFont();
  }

  setExpressionData(resource: string, value: unknown): void {
    if (this.destroyed) return;
    this.expressionData.set(resource, value);
    this.dirty = true;
    void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */});
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.settleReady(new Error('Animation text rasterizer is disposed'), true);
    this.dirty = false;
    this.updateToken++;
    this.retireTexture(this.texture);
    this.texture = null;
    this.outlineFonts.clear();
    this.expressionData.clear();
  }

  async updateTexture(): Promise<void> {
    if (this.destroyed || !this.dirty || this.updating || !this.canvas) return;
    this.textureFailure = undefined; this.textureFailed = false;
    const token = ++this.updateToken;
    this.dirty = false;
    this.updating = true;
    try {
      this.draw(this.canvas, Number.isFinite(this.time) ? this.time : 0);
      const previous = this.texture;
      this.texture = this.canvas;
      this.retireTexture(previous);
      this.textureVersion++;
      if (typeof createImageBitmap !== 'function') return;
      const bitmap = await createImageBitmap(this.canvas, { colorSpaceConversion: 'none' });
      if (token !== this.updateToken) { bitmap.close(); return; }
      const retired = this.texture;
      this.texture = bitmap;
      this.textureVersion++;
      this.retireTexture(retired);
    } catch (error) {
      this.textureFailure = error; this.textureFailed = true; this.dirty = false; this.settleReady(error, true); throw error;
    } finally {
      this.updating = false;
      if (this.dirty) void this.updateTexture().catch(() => {/* Exposed by whenReady; callers of updateTexture still receive its rejection. */}); else this.settleReady(this.textureFailure, this.textureFailed);
    }
  }

  /** Shared CPU document resolution; raster drawing consumes this exact result too. */
  evaluateDocument(time: number): Readonly<ResolvedTextDocument> {
    if (this.destroyed) throw Object.assign(new Error('Animation text rasterizer is disposed'), {code: 'E_HYA_RUNTIME_DISPOSED', path: '$.core.text'});
    if (!Number.isFinite(time)) throw new RangeError('Text evaluation time must be finite');
    const resolved = resolveDocument(this.component, time, this.expressionData), state = this.stateDocument;
    return Object.freeze({...resolved, ...(state.value === undefined ? {} : {text: state.value}), ...(state.fontSize === undefined ? {} : {fontSize: state.fontSize, lineHeight: resolved.lineHeight / resolved.fontSize * state.fontSize}), ...(state.tracking === undefined ? {} : {tracking: state.tracking}), color: Object.freeze([...(state.color ?? resolved.color)]) as readonly [number, number, number, number], state});
  }

  /** A prepared original OpenType font supplies actual CPU metrics; unsupported hosts never synthesize them. */
  evaluateOutlineGlyphLayout(time:number):unknown {
    return this.evaluateGlyphLayout(time,(text,style)=>{
      const font=selectPreparedFont(this.outlineFonts,style)?.outline;
      if(!font?.getAdvanceWidth||!font.unitsPerEm||!Number.isFinite(font.ascender)||!Number.isFinite(font.descender))throw Object.assign(new Error('Core glyph evaluation needs a prepared outline font and its actual metrics'),{code:'E_HYA_RUNTIME_HOST_PORT',path:'$.core.text.metrics'});
      return {width:font.getAdvanceWidth(text,style.fontSize,{kerning:true,features:{liga:true,rlig:true}}),ascent:font.ascender!*style.fontSize/font.unitsPerEm,descent:-font.descender!*style.fontSize/font.unitsPerEm};
    });
  }

  /** Internal CPU glyph layout; the real draw path consumes the same plain/styled plan. */
  evaluateGlyphLayout(time:number,measure:AnimationTextMeasure):unknown {return snapshotCoreTextLayout(this.component,this.evaluateDocument(time),time,measure);}

  private draw(canvas: HTMLCanvasElement, time: number): void {
    const component = this.component;
    const document = this.evaluateDocument(time);
    const width = Math.max(1, Math.ceil(component.size[0]));
    const height = Math.max(1, Math.ceil(component.size[1]));
    const dpr = Math.max(1, Math.min(4, component.resolutionScale ?? 2));
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Ask the browser text shaper for geometric precision so Canvas does
    // not snap small embedded
    // fonts to the host platform's UI-text hinting grid.
    context.textRendering = 'geometricPrecision';
    context.fontKerning = 'normal';
    context.clearRect(0, 0, width, height);
    const background = component.backgroundColor;
    if (background && background[3] > 0) {
      context.fillStyle = cssColor(background);
      context.fillRect(0, 0, width, height);
    }
    const padding = Math.max(0, component.padding ?? 0);
    const contentWidth = Math.max(1, width - padding * 2);
    const contentHeight = Math.max(1, height - padding * 2);
    if ((component.styleRuns?.length ?? 0) > 0) {
      drawStyledText(context, component, document, time, padding, contentWidth, contentHeight, this.outlineFonts);
      return;
    }
    const outlineFont=selectPreparedFont(this.outlineFonts,document)?.outline;
    const plan=evaluatePlainTextLayout(component,document,time,padding,contentWidth,contentHeight,canvasTextMeasure(context,this.outlineFonts));
    context.font=textFont({...document,fontSize:plan.fontSize},this.outlineFonts);context.textBaseline='alphabetic';context.textAlign='left';
    for(const layout of plan.layouts){
      if(component.lineBackground)drawJoinedLineBackground(context,component.lineBackground,[{left:layout.x,top:layout.top,right:layout.x+layout.width,bottom:layout.top+layout.height}]);
      if(plan.rendering==='run'){if(outlineFont)drawOpenTypeText(context,outlineFont,layout.line.join(''),layout.x,layout.baseline,plan.fontSize,document.color);else{context.fillStyle=cssColor(document.color);context.fillText(layout.line.join(''),layout.x,layout.baseline);}continue;}
      for(const glyph of layout.glyphs){
        const state=glyph.state;context.save();context.translate(glyph.centerX,glyph.baseline);context.rotate(state.rotation);context.scale(state.scaleX,state.scaleY);context.globalAlpha=state.opacity;context.fillStyle=cssColor(state.color);
        if(outlineFont)drawOpenTypeText(context,outlineFont,glyph.value,-glyph.advance/2,0,plan.fontSize,state.color);else context.fillText(glyph.value,-glyph.advance/2,0);context.restore();
      }
    }
  }
}

export interface AnimationTextMetricStyle {
 readonly fontResource?:string|undefined;
 readonly fontFamily:string;readonly fontSize:number;readonly fontWeight:string|number;readonly fontStyle:'normal'|'italic';
}
export interface AnimationTextMetric {readonly width:number;readonly ascent:number;readonly descent:number;}
export type AnimationTextMeasure=(text:string,style:AnimationTextMetricStyle)=>AnimationTextMetric;

/** Adapter to the existing real browser metric source; pure layout never needs a Canvas-shaped object. */
function canvasTextMeasure(context:CanvasRenderingContext2D,fonts?:ReadonlyMap<string,PreparedAnimationFont>):AnimationTextMeasure {
 return (text,style)=>{
  context.font=textFont(style,fonts);setCanvasLetterSpacing(context,0);
  const sample=context.measureText(text),font=fonts?selectPreparedFont(fonts,style)?.outline:undefined;
  const width=font?.getAdvanceWidth?.(text,style.fontSize,{kerning:true,features:{liga:true,rlig:true}})??sample.width;
  if(!Number.isFinite(width)||width<0)throw new RangeError('Font advance must be finite and non-negative');
  return {width,ascent:positiveMetric(sample.fontBoundingBoxAscent,sample.actualBoundingBoxAscent,style.fontSize*.8),descent:positiveMetric(sample.fontBoundingBoxDescent,sample.actualBoundingBoxDescent,style.fontSize*.2)};
 };
}

function evaluatePlainTextLayout(component:Readonly<AnimationText2DComponent>,document:ResolvedTextDocument,time:number,padding:number,contentWidth:number,contentHeight:number,metric:AnimationTextMeasure) {
 let fontSize=document.fontSize,lineHeight=document.lineHeight,tracking=document.tracking;
 const measure=(value:string)=>metric(value,{...document,fontSize}).width;
 const canShapeRun=()=>!(component.animators?.length)&&Math.abs(tracking)<1e-6;
 let lines=layoutTextLines(document.text,contentWidth,component.wrap??'none',tracking,measure,canShapeRun());
 if((component.fit==='scale'||component.fit==='font-size')&&lines.length>0){
  const measuredWidth=Math.max(...lines.map(line=>measuredLineWidth(line,tracking,measure,canShapeRun())),1),measuredHeight=Math.max(1,lines.length*lineHeight);
  const continuousScale=Math.min(1,contentWidth/measuredWidth,contentHeight/measuredHeight),scale=component.fit==='font-size'?Math.max(1,Math.floor(fontSize*continuousScale))/Math.max(1,fontSize):continuousScale;
  fontSize*=scale;lineHeight*=scale;tracking*=scale;
  lines=layoutTextLines(document.text,contentWidth,component.wrap??'none',tracking,measure,canShapeRun());
 }
 const animators=component.animators??[],selectorPlans=animators.map(animator=>createSelectorIndexPlan(lines,animator));
 lineHeight=Math.max(1,lineHeight);const textHeight=lines.length*lineHeight;let top=padding;
 const vertical=component.verticalAlign??'middle';if(vertical==='middle')top+=Math.max(0,(contentHeight-textHeight)/2);else if(vertical==='bottom')top+=Math.max(0,contentHeight-textHeight);
 let globalIndex=0;
 const layouts=lines.map((line,lineIndex)=>{
  const advances=line.map(measure),width=measuredLineWidth(line,tracking,measure,canShapeRun());let x=padding;
  if(document.textAlign==='center')x+=Math.max(0,(contentWidth-width)/2);else if(document.textAlign==='right')x+=Math.max(0,contentWidth-width);
  const baseline=top+lineIndex*lineHeight+fontSize,start=x;
  const glyphs=line.map((value,index)=>{
   const advance=advances[index]??0,state=resolveGlyphState(animators,selectorPlans,time,globalIndex++,document.color),glyph={value,advance,x,centerX:x+advance/2+state.x,baseline:baseline+state.y,state};x+=advance+tracking+state.tracking;return glyph;
  });
  return {line,glyphs,x:start,baseline,top:baseline-fontSize,height:lineHeight,width};
 });
 return {layouts,fontSize,lineHeight,tracking,animators,document,rendering:canShapeRun()?'run' as const:'glyphs' as const,contentSize:[Math.max(0,...layouts.map(line=>line.width)),textHeight] as const};
}

/** Produces an immutable logical plan; font metrics must come from an explicit real metric source. */
function snapshotCoreTextLayout(component:Readonly<AnimationText2DComponent>,document:ResolvedTextDocument,time:number,measure:AnimationTextMeasure) {
 if(typeof measure!=='function')throw Object.assign(new Error('Core glyph layout requires a real font metric port'),{code:'E_HYA_RUNTIME_HOST_PORT',path:'$.core.text.metrics'});
 const metric:AnimationTextMeasure=(text,style)=>{const value=measure(text,Object.freeze({fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,fontStyle:style.fontStyle,fontResource:style.fontResource}));if(!value||[value.width,value.ascent,value.descent].some(v=>!Number.isFinite(v)||v<0))throw Object.assign(new Error('Core text metrics must be finite and non-negative'),{code:'E_HYA_RUNTIME_TEXT',path:'$.core.text.metrics'});return value;};
 const width=Math.max(1,Math.ceil(component.size[0])),height=Math.max(1,Math.ceil(component.size[1])),padding=Math.max(0,component.padding??0),contentWidth=Math.max(1,width-padding*2),contentHeight=Math.max(1,height-padding*2);
 let output:unknown;
 if((component.styleRuns?.length??0)>0){
  const plan=evaluateStyledTextLayout(metric,component,document,time,padding,contentWidth,contentHeight);
  let index=0;
  output={kind:'styled',size:[width,height],contentSize:[plan.metrics.width,plan.metrics.height],lines:plan.layouts.map(layout=>{const glyphs=plan.glyphPlans.slice(index,index+layout.line.glyphs.length);index+=glyphs.length;return{x:layout.x,top:layout.top,width:layout.metrics.width,height:layout.height,baseline:layout.baseline,glyphs};})};
 }else{
  const plan=evaluatePlainTextLayout(component,document,time,padding,contentWidth,contentHeight,metric);
  output={kind:'plain',rendering:plan.rendering,size:[width,height],contentSize:plan.contentSize,fontSize:plan.fontSize,lineHeight:plan.lineHeight,tracking:plan.tracking,lines:plan.layouts};
 }
 const copy=JSON.parse(JSON.stringify(output)) as unknown;
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(copy);return copy;
}

function evaluateStyledTextLayout(measure:AnimationTextMeasure,component:Readonly<AnimationText2DComponent>,document:ResolvedTextDocument,time:number,padding:number,contentWidth:number,contentHeight:number) {
  let scale = 1;
  let scaleLineMetrics = false;
  const paragraphSpacing = sampled(component.paragraphSpacingTrack, time, [component.paragraphSpacing ?? 0])[0] ?? 0;
  let lines = layoutStyledText(measure, component, document, contentWidth, scale, scaleLineMetrics, time);
  if (component.fit === 'font-size' && lines.length > 0) {
    const maxFontSize = Math.max(document.fontSize, ...lines.flatMap(line => line.glyphs.map(glyph => glyph.style.fontSize)));
    let low = 1; let high = Math.max(1, Math.floor(maxFontSize)); let best = 1;
    while (low <= high) {
      const candidate = low + Math.floor((high - low) / 2);
      const candidateScale = candidate / Math.max(1, maxFontSize);
      const candidateLines = layoutStyledText(measure, component, document, contentWidth, candidateScale, false, time);
      const candidateMetrics = measureStyledBlock(measure, candidateLines, document, paragraphSpacing, candidateScale, false);
      if (candidateMetrics.width <= contentWidth && candidateMetrics.height <= contentHeight) {
        best = candidate; low = candidate + 1;
      } else high = candidate - 1;
    }
    scale = best / Math.max(1, maxFontSize);
    // Font-size fitting preserves authored custom line boxes while
    // stepping the top font size; uniform scaling also scales line metrics.
    scaleLineMetrics = false;
    lines = layoutStyledText(measure, component, document, contentWidth, scale, scaleLineMetrics, time);
  } else if (component.fit === 'scale' && lines.length > 0) {
    const metrics = measureStyledBlock(measure, lines, document, paragraphSpacing, scale, false);
    scale = Math.min(1, contentWidth / Math.max(1, metrics.width), contentHeight / Math.max(1, metrics.height));
    scaleLineMetrics = true;
    lines = layoutStyledText(measure, component, document, contentWidth, scale, scaleLineMetrics, time);
  }
  const metrics = measureStyledBlock(measure, lines, document, paragraphSpacing, scale, scaleLineMetrics);
  let top = padding;
  const vertical = component.verticalAlign ?? 'middle';
  if (vertical === 'middle') top += Math.max(0, (contentHeight - metrics.height) / 2);
  else if (vertical === 'bottom') top += Math.max(0, contentHeight - metrics.height);
  const glyphLines = lines.map(line => line.glyphs.map(glyph => glyph.value));
  const animators = component.animators ?? [];
  const selectorPlans = animators.map(animator => createSelectorIndexPlan(glyphLines, animator));
  const layouts: StyledLineLayout[] = [];
  let firstLine = true;
  for (const line of lines) {
    const lineMetrics = measureStyledLine(measure, line.glyphs, document, scale, scaleLineMetrics);
    let x = padding;
    if (document.textAlign === 'center') x += Math.max(0, (contentWidth - lineMetrics.width) / 2);
    else if (document.textAlign === 'right') x += Math.max(0, contentWidth - lineMetrics.width);
    const lineHeight = firstLine
      ? lineMetrics.naturalAscent + lineMetrics.descent
      : lineMetrics.ascent + lineMetrics.descent;
    const baseline = top + (firstLine ? lineMetrics.naturalAscent : lineMetrics.ascent);
    layouts.push({ line, metrics: lineMetrics, x, top, baseline, height: lineHeight });
    top += lineHeight;
    if (line.paragraphEnd) top += Math.max(0, paragraphSpacing) * (scaleLineMetrics ? scale : 1);
    firstLine = false;
  }

  let glyphIndex=0;
  const glyphPlans=layouts.flatMap(layout=>{let trackingOffset=0;return layout.line.glyphs.map((glyph,index)=>{const advance=layout.metrics.advances[index]??0,state=resolveGlyphState(animators,selectorPlans,time,glyphIndex++,glyph.style.color),x=layout.x+layout.metrics.offsets[index]!+trackingOffset;trackingOffset+=state.tracking;return {value:glyph.value,style:glyph.style,advance,x,centerX:x+advance/2+state.x,baseline:layout.baseline+state.y,state};});});
  return {layouts,metrics,animators,selectorPlans,glyphPlans};
}

function drawStyledText(
  context: CanvasRenderingContext2D,
  component: Readonly<AnimationText2DComponent>,
  document: ResolvedTextDocument,
  time: number,
  padding: number,
  contentWidth: number,
  contentHeight: number,
  outlineFonts: ReadonlyMap<string, PreparedAnimationFont>,
): void {
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  const {layouts,animators,selectorPlans,glyphPlans}=evaluateStyledTextLayout(canvasTextMeasure(context,outlineFonts),component,document,time,padding,contentWidth,contentHeight);

  // Accumulate every glyph rectangle owned by a style, union
  // touching lines into one contour, and paint all backgrounds before any
  // glyph paths. Keeping the geometry grouped by style key preserves both the
  // stepped outline between unequal line widths and the background-before-glyph paint order.
  const backgroundGroups = new Map<number, {
    background: NonNullable<ResolvedRunStyle['lineBackground']>;
    rects: BackgroundRect[];
  }>();
  for (const layout of layouts) {
    const { line, metrics: lineMetrics, x } = layout;
    let segmentStart = 0;
    while (segmentStart < line.glyphs.length) {
      const style = line.glyphs[segmentStart]!.style;
      const background = style.lineBackground;
      let segmentEnd = segmentStart + 1;
      while (segmentEnd < line.glyphs.length
        && line.glyphs[segmentEnd]!.style.key === style.key) segmentEnd++;
      if (background) {
        const segmentX = x + lineMetrics.offsets[segmentStart]!;
        const segmentWidth = lineMetrics.offsets[segmentEnd]! - lineMetrics.offsets[segmentStart]!;
        const group = backgroundGroups.get(style.key) ?? { background, rects: [] };
        group.rects.push({
          left: segmentX,
          top: layout.top,
          right: segmentX + segmentWidth,
          bottom: layout.top + layout.height,
        });
        backgroundGroups.set(style.key, group);
      }
      segmentStart = segmentEnd;
    }
  }
  for (const group of backgroundGroups.values()) {
    drawJoinedLineBackground(context, group.background, group.rects);
  }

  let globalIndex = 0;
  for (const layout of layouts) {
    const { line, metrics: lineMetrics, x, baseline } = layout;
    if (animators.length === 0) {
      drawShapedStyleSegments(context, line.glyphs, lineMetrics.offsets, x, baseline, outlineFonts);
      globalIndex += line.glyphs.length;
    } else for (let glyphIndex = 0; glyphIndex < line.glyphs.length; glyphIndex++, globalIndex++) {
      const glyph = line.glyphs[glyphIndex]!;
      const advance = lineMetrics.advances[glyphIndex] ?? 0;
      const prepared = glyphPlans[globalIndex]!, state = prepared.state;
      const centerX = prepared.centerX;
      context.save();
      context.font = textFont(glyph.style,outlineFonts);
      context.translate(centerX, prepared.baseline);
      context.rotate(state.rotation);
      context.scale(state.scaleX, state.scaleY);
      context.globalAlpha = state.opacity;
      context.fillStyle = cssColor(state.color);
      context.fillText(glyph.value, -advance / 2, 0);
      context.restore();
    }
  }
}

function drawShapedStyleSegments(
  context: CanvasRenderingContext2D,
  glyphs: readonly StyledGlyph[],
  offsets: readonly number[],
  x: number,
  baseline: number,
  outlineFonts: ReadonlyMap<string, PreparedAnimationFont>,
): void {
  let start = 0;
  while (start < glyphs.length) {
    let end = start + 1;
    while (end < glyphs.length && glyphs[end]!.style.key === glyphs[start]!.style.key) end++;
    const style = glyphs[start]!.style;
    const text = glyphs.slice(start, end).map(glyph => glyph.value).join('');
    const outlineFont = selectPreparedFont(outlineFonts,style)?.outline;
    if (outlineFont && Math.abs(style.tracking) < 1e-6) {
      drawOpenTypeText(context, outlineFont, text, x + offsets[start]!, baseline, style.fontSize, style.color);
    } else {
      context.font = textFont(style,outlineFonts);
      setCanvasLetterSpacing(context, style.tracking);
      context.fillStyle = cssColor(style.color);
      context.fillText(text, x + offsets[start]!, baseline);
    }
    start = end;
  }
  setCanvasLetterSpacing(context, 0);
}

function outlineFontKey(family: string, style: 'normal' | 'italic', weight: string | number,resource?:string): string {
  return JSON.stringify([resource??null,family,style,String(weight)]);
}
interface PreparedAnimationFont {
 readonly resource?:string|undefined;
 readonly outline?:AnimationOutlineFont|undefined;
 readonly nativeFamily:string;
 readonly ambiguous?:boolean;
}
type CoreFontSelection=Pick<AnimationTextMetricStyle,'fontFamily'|'fontWeight'|'fontStyle'> & {readonly fontResource?:string|undefined};
function selectPreparedFont(fonts:ReadonlyMap<string,PreparedAnimationFont>,style:CoreFontSelection):PreparedAnimationFont|undefined {
 const value=fonts.get(outlineFontKey(style.fontFamily,style.fontStyle,style.fontWeight,style.fontResource));
 if(value?.ambiguous)throw Object.assign(new Error('Core font family resolves to multiple resources; declare the active fontResource'),{code:'E_HYA_RUNTIME_HOST_PORT',path:'$.core.text.fontResource',capability:'core-text'});
 return value;
}
function inheritedCoreFontResource(value:Readonly<{fontResource?:string|undefined;fontFamily?:string|undefined;fontStyle?:'normal'|'italic'|undefined;fontWeight?:string|number|undefined}>,base:CoreFontSelection):string|undefined {
 if(value.fontResource!==undefined)return value.fontResource;
 if((value.fontFamily??base.fontFamily)!==base.fontFamily||(value.fontStyle??base.fontStyle)!==base.fontStyle||String(value.fontWeight??base.fontWeight)!==String(base.fontWeight))return undefined;
 return base.fontResource;
}


function drawOpenTypeText(
  context: CanvasRenderingContext2D,
  font: AnimationOutlineFont,
  text: string,
  x: number,
  baseline: number,
  fontSize: number,
  color: readonly [number, number, number, number],
): void {
  const path = font.getPath(text, x, baseline, fontSize, { kerning: true, features: { liga: true, rlig: true } });
  drawOpenTypePath(context, path);
  context.fillStyle = cssColor(color);
  context.fill('nonzero');
}

function drawOpenTypePath(context: CanvasRenderingContext2D, path: AnimationOutlinePath): void {
  context.beginPath();
  for (const command of path.commands) switch (command.type) {
    case 'M': context.moveTo(command.x!, command.y!); break;
    case 'L': context.lineTo(command.x!, command.y!); break;
    case 'C': context.bezierCurveTo(command.x1!, command.y1!, command.x2!, command.y2!, command.x!, command.y!); break;
    case 'Q': context.quadraticCurveTo(command.x1!, command.y1!, command.x!, command.y!); break;
    case 'Z': context.closePath(); break;
  }
}

function layoutStyledText(
  measure: AnimationTextMeasure,
  component: Readonly<AnimationText2DComponent>,
  document: ResolvedTextDocument,
  width: number,
  fontScale: number,
  scaleLineMetrics: boolean,
  time: number,
): StyledLine[] {
  const baseStyle = scaledRunStyle(document, component.lineBackground, 0, fontScale, scaleLineMetrics);
  const runStyles = (component.styleRuns ?? []).map((run, index) => ({
    start: run.start,
    end: run.end,
    style: scaledRunStyle({
      fontResource: inheritedCoreFontResource(run,document),
      fontFamily: run.fontFamily ?? document.fontFamily,
      fontSize: document.state?.fontSize ?? sampled(run.fontSizeTrack, time, [run.fontSize ?? document.fontSize])[0] ?? run.fontSize ?? document.fontSize,
      fontWeight: run.fontWeight ?? document.fontWeight,
      fontStyle: run.fontStyle ?? document.fontStyle,
      // Zero is runtime-private shorthand for automatic line height;
      // it is resolved from the loaded font metrics in measureStyledLine.
      lineHeight: sampled(run.lineHeightTrack, time, [run.lineHeight ?? 0])[0] ?? run.lineHeight ?? 0,
      tracking: document.state?.tracking ?? sampled(run.trackingTrack, time, [run.tracking ?? document.tracking])[0] ?? run.tracking ?? document.tracking,
      color: document.state?.color ?? run.color ?? document.color,
    }, run.lineBackground ?? component.lineBackground, index + 1, fontScale, scaleLineMetrics),
  }));
  const paragraphs: StyledGlyph[][] = [];
  const breakPattern = /\r\n|\r|\n/gu;
  let cursor = 0;
  for (const match of document.text.matchAll(breakPattern)) {
    paragraphs.push(styledGlyphs(document.text.slice(cursor, match.index), cursor, baseStyle, runStyles));
    cursor = (match.index ?? cursor) + match[0].length;
  }
  paragraphs.push(styledGlyphs(document.text.slice(cursor), cursor, baseStyle, runStyles));
  const output: StyledLine[] = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex]!;
    const words = styledWords(paragraph);
    let line: StyledGlyph[] = [];
    for (const candidateWord of words) {
      const candidate = [...line, ...candidateWord];
      if (component.wrap === 'word' && line.length > 0
        && measureStyledLine(measure, candidate, document, fontScale, scaleLineMetrics).width > width) {
        output.push({ glyphs: line, paragraphEnd: false });
        line = [...candidateWord];
      } else line = candidate;
      if (component.wrap === 'word' && line.length > 1
        && measureStyledLine(measure, line, document, fontScale, scaleLineMetrics).width > width) {
        const pending = [...line]; line = [];
        for (const glyph of pending) {
          const forced = [...line, glyph];
          if (line.length > 0 && measureStyledLine(measure, forced, document, fontScale, scaleLineMetrics).width > width) {
            output.push({ glyphs: line, paragraphEnd: false }); line = [glyph];
          } else line = forced;
        }
      }
    }
    output.push({ glyphs: line, paragraphEnd: true });
  }
  return output;
}

function styledWords(glyphs: readonly StyledGlyph[]): StyledGlyph[][] {
  if (glyphs.length === 0) return [[]];
  const text = glyphs.map(glyph => glyph.value).join('');
  const boundaries = new Set<number>();
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const segment of segmenter.segment(text)) boundaries.add(segment.index + segment.segment.length);
  } else {
    let offset = 0;
    for (const match of text.matchAll(/\S+\s*|\s+/gu)) { offset += match[0].length; boundaries.add(offset); }
  }
  const words: StyledGlyph[][] = []; let word: StyledGlyph[] = []; let offset = 0;
  for (const glyph of glyphs) {
    word.push(glyph); offset += glyph.value.length;
    if (boundaries.has(offset)) { words.push(word); word = []; }
  }
  if (word.length > 0) words.push(word);
  return words;
}

function styledGlyphs(
  text: string,
  baseOffset: number,
  baseStyle: ResolvedRunStyle,
  runStyles: readonly { start: number; end: number; style: ResolvedRunStyle }[],
): StyledGlyph[] {
  const output: StyledGlyph[] = [];
  let offset = baseOffset;
  for (const value of splitGraphemes(text)) {
    const run = runStyles.find(candidate => offset >= candidate.start && offset < candidate.end);
    output.push({ value, style: run?.style ?? baseStyle });
    offset += value.length;
  }
  return output;
}

function scaledRunStyle(
  source: Omit<ResolvedTextDocument, 'text' | 'textAlign'>,
  lineBackground: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']> | undefined,
  key: number,
  fontScale: number,
  scaleLineMetrics = true,
): ResolvedRunStyle {
  const metricScale = scaleLineMetrics ? fontScale : 1;
  return {
    key,
    fontResource: source.fontResource,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize * fontScale,
    fontWeight: source.fontWeight,
    fontStyle: source.fontStyle,
    // Apply one uniform fit scale to font size, custom line height,
    // letter spacing and line background geometry.
    lineHeight: source.lineHeight * metricScale,
    tracking: source.tracking * metricScale,
    color: source.color,
    ...(lineBackground ? {
      lineBackground: {
        ...lineBackground,
        ...(lineBackground.strokeWidth === undefined ? {} : { strokeWidth: lineBackground.strokeWidth * metricScale }),
        ...(lineBackground.cornerRadius === undefined ? {} : { cornerRadius: lineBackground.cornerRadius * metricScale }),
        ...(lineBackground.padding === undefined ? {} : { padding: lineBackground.padding * metricScale }),
      },
    } : {}),
  };
}

function measureStyledBlock(
  measure: AnimationTextMeasure,
  lines: readonly StyledLine[],
  document: ResolvedTextDocument,
  paragraphSpacing: number,
  fontScale: number,
  scaleLineMetrics: boolean,
): { width: number; height: number } {
  let width = 0; let height = 0; let firstLine = true;
  for (const line of lines) {
    const metrics = measureStyledLine(measure, line.glyphs, document, fontScale, scaleLineMetrics);
    width = Math.max(width, metrics.width);
    height += firstLine ? metrics.naturalAscent + metrics.descent : metrics.ascent + metrics.descent;
    if (line.paragraphEnd) height += Math.max(0, paragraphSpacing) * (scaleLineMetrics ? fontScale : 1);
    firstLine = false;
  }
  return { width, height };
}

function measureStyledLine(
  measure: AnimationTextMeasure,
  glyphs: readonly StyledGlyph[],
  document: ResolvedTextDocument,
  fontScale: number,
  scaleLineMetrics = true,
): { width: number; ascent: number; descent: number; naturalAscent: number; advances: number[]; offsets: number[] } {
  const advances: number[] = [];
  const offsets = [0];
  let width = 0;
  let ascent = 0; let descent = 0; let naturalAscent = 0;
  const sourceGlyphs = glyphs.length > 0
    ? glyphs
    : [{ value: 'Mg', style: scaledRunStyle(document, undefined, 0, fontScale, scaleLineMetrics) }];
  let start = 0;
  while (start < sourceGlyphs.length) {
    let end = start + 1;
    while (end < sourceGlyphs.length && sourceGlyphs[end]!.style.key === sourceGlyphs[start]!.style.key) end++;
    const style = sourceGlyphs[start]!.style;
    const sample = measure(sourceGlyphs.slice(start, end).map(glyph => glyph.value).join(''),style);
    const fontAscent = sample.ascent, fontDescent = sample.descent;
    const metricHeight = Math.max(1e-6, fontAscent + fontDescent);
    const customHeight = style.lineHeight > 0 ? style.lineHeight : metricHeight;
    ascent = Math.max(ascent, customHeight * fontAscent / metricHeight);
    descent = Math.max(descent, customHeight * fontDescent / metricHeight);
    naturalAscent = Math.max(naturalAscent, fontAscent);
    let prefix = '';
    for (let index = start; index < end; index++) {
      prefix += sourceGlyphs[index]!.value;
      const prefixWidth = measure(prefix,style).width + Math.max(0, index - start) * style.tracking;
      const offset = width + prefixWidth;
      if (glyphs.length > 0) {
        advances.push(offset - offsets[offsets.length - 1]!);
        offsets.push(offset);
      }
    }
    width = offsets[offsets.length - 1] ?? width;
    start = end;
  }
  return { width, ascent, descent, naturalAscent, advances, offsets };
}

function positiveMetric(primary: number | undefined, secondary: number | undefined, fallback: number): number {
  return Number.isFinite(primary) && primary! > 0 ? primary!
    : Number.isFinite(secondary) && secondary! > 0 ? secondary! : fallback;
}

function setCanvasLetterSpacing(context: CanvasRenderingContext2D, value: number): void {
  if ('letterSpacing' in context) context.letterSpacing = `${value}px`;
}

function textFont(style: AnimationTextMetricStyle,fonts?:ReadonlyMap<string,PreparedAnimationFont>): string {
  const family=fonts?selectPreparedFont(fonts,style)?.nativeFamily??style.fontFamily:style.fontFamily;
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${quoteFont(family)}`;
}

function layoutTextLines(
  text: string,
  width: number,
  wrap: 'none' | 'word',
  tracking: number,
  measure: (value: string) => number,
  wholeRun = false,
): string[][] {
  if (wrap === 'none') return text.split(/\r?\n/).map(splitGraphemes);
  const output: string[][] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.match(/\S+\s*/gu) ?? [''];
    let line: string[] = [];
    for (const word of words) {
      const glyphs = splitGraphemes(word);
      const candidate = [...line, ...glyphs];
      if (line.length > 0 && measuredLineWidth(candidate, tracking, measure, wholeRun) > width) {
        output.push(line);
        line = glyphs;
      } else line = candidate;
    }
    output.push(line);
  }
  return output;
}

function measuredLineWidth(line: readonly string[], tracking: number, measure: (value: string) => number, wholeRun = false): number {
  if(wholeRun)return measure(line.join(''));
  return line.reduce((sum, glyph) => sum + measure(glyph), 0)
    + Math.max(0, line.length - 1) * tracking;
}

function drawJoinedLineBackground(
  context: CanvasRenderingContext2D,
  background: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']>,
  sourceRects: readonly BackgroundRect[],
): void {
  const padding = Math.max(0, background.padding ?? 0);
  const strokeWidth = Math.max(0, background.strokeWidth ?? 0);
  const rects = sourceRects.map(rect => ({
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  if (rects.length === 0) return;
  context.save();
  context.beginPath();
  for (const contour of unionRectContours(rects)) {
    roundedContour(context, contour, Math.max(0, background.cornerRadius ?? 0));
  }
  context.fillStyle = cssColor(background.fill);
  context.fill('evenodd');
  if (background.stroke && strokeWidth > 0) {
    context.strokeStyle = cssColor(background.stroke);
    context.lineWidth = strokeWidth;
    context.stroke();
  }
  context.restore();
}

function unionRectContours(rects: readonly BackgroundRect[]): [number, number][][] {
  const xs = [...new Set(rects.flatMap(rect => [rect.left, rect.right]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(rect => [rect.top, rect.bottom]))].sort((a, b) => a - b);
  const columns = Math.max(0, xs.length - 1);
  const rows = Math.max(0, ys.length - 1);
  const covered = Array.from({ length: rows }, () => Array<boolean>(columns).fill(false));
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const centerX = (xs[x]! + xs[x + 1]!) / 2;
    const centerY = (ys[y]! + ys[y + 1]!) / 2;
    covered[y]![x] = rects.some(rect => centerX >= rect.left && centerX < rect.right
      && centerY >= rect.top && centerY < rect.bottom);
  }
  const edges: { start: [number, number]; end: [number, number] }[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    if (!covered[y]![x]) continue;
    const left = xs[x]!; const right = xs[x + 1]!; const top = ys[y]!; const bottom = ys[y + 1]!;
    if (y === 0 || !covered[y - 1]![x]) edges.push({ start: [left, top], end: [right, top] });
    if (x === columns - 1 || !covered[y]![x + 1]) edges.push({ start: [right, top], end: [right, bottom] });
    if (y === rows - 1 || !covered[y + 1]![x]) edges.push({ start: [right, bottom], end: [left, bottom] });
    if (x === 0 || !covered[y]![x - 1]) edges.push({ start: [left, bottom], end: [left, top] });
  }
  const outgoing = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index++) {
    const indices = outgoing.get(pointKey(edges[index]!.start)) ?? [];
    indices.push(index); outgoing.set(pointKey(edges[index]!.start), indices);
  }
  const used = new Set<number>();
  const contours: [number, number][][] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (used.has(seed)) continue;
    const contour: [number, number][] = [];
    let edgeIndex = seed;
    const start = edges[seed]!.start;
    for (let guard = 0; guard <= edges.length; guard++) {
      const edge = edges[edgeIndex]!;
      used.add(edgeIndex);
      contour.push(edge.start);
      if (samePoint(edge.end, start)) break;
      const next = (outgoing.get(pointKey(edge.end)) ?? []).find(index => !used.has(index));
      if (next === undefined) break;
      edgeIndex = next;
    }
    const simplified = simplifyOrthogonalContour(contour);
    if (simplified.length >= 4) contours.push(signedArea(simplified) < 0 ? [...simplified].reverse() : simplified);
  }
  return contours;
}

function simplifyOrthogonalContour(points: readonly [number, number][]): [number, number][] {
  const output = [...points];
  let changed = true;
  while (changed && output.length >= 4) {
    changed = false;
    for (let index = 0; index < output.length; index++) {
      const previous = output[(index + output.length - 1) % output.length]!;
      const current = output[index]!;
      const next = output[(index + 1) % output.length]!;
      if ((previous[0] === current[0] && current[0] === next[0])
        || (previous[1] === current[1] && current[1] === next[1])) {
        output.splice(index, 1); changed = true; break;
      }
    }
  }
  return output;
}

function roundedContour(
  context: CanvasRenderingContext2D,
  contour: readonly [number, number][],
  radius: number,
): void {
  if (contour.length < 2) return;
  const corner = (index: number) => {
    const previous = contour[(index + contour.length - 1) % contour.length]!;
    const position = contour[index]!;
    const next = contour[(index + 1) % contour.length]!;
    const previousLength = Math.hypot(previous[0] - position[0], previous[1] - position[1]);
    const nextLength = Math.hypot(next[0] - position[0], next[1] - position[1]);
    const renderRadius = Math.min(previousLength / 2, nextLength / 2, radius);
    const toPrevious: [number, number] = [
      (previous[0] - position[0]) / previousLength,
      (previous[1] - position[1]) / previousLength,
    ];
    const toNext: [number, number] = [
      (next[0] - position[0]) / nextLength,
      (next[1] - position[1]) / nextLength,
    ];
    return { position, toPrevious, toNext, renderRadius };
  };
  if (radius <= 0) {
    context.moveTo(contour[0]![0], contour[0]![1]);
    for (let index = 1; index < contour.length; index++) context.lineTo(contour[index]![0], contour[index]![1]);
    context.closePath();
    return;
  }
  const first = corner(0);
  context.moveTo(
    first.position[0] + first.toPrevious[0] * first.renderRadius,
    first.position[1] + first.toPrevious[1] * first.renderRadius,
  );
  for (let index = 0; index < contour.length; index++) {
    const { position, toPrevious, toNext, renderRadius } = corner(index);
    const controlDistance = renderRadius * 0.5522847498307936;
    if (index > 0) context.lineTo(
      position[0] + toPrevious[0] * renderRadius,
      position[1] + toPrevious[1] * renderRadius,
    );
    context.bezierCurveTo(
      position[0] + toPrevious[0] * (renderRadius - controlDistance),
      position[1] + toPrevious[1] * (renderRadius - controlDistance),
      position[0] + toNext[0] * (renderRadius - controlDistance),
      position[1] + toNext[1] * (renderRadius - controlDistance),
      position[0] + toNext[0] * renderRadius,
      position[1] + toNext[1] * renderRadius,
    );
  }
  context.closePath();
}

function pointKey(point: readonly [number, number]): string { return `${point[0]}\0${point[1]}`; }
function samePoint(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}
function signedArea(points: readonly [number, number][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!; const next = points[(index + 1) % points.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function resolveDocument(
  component: Readonly<AnimationText2DComponent>,
  time: number,
  expressionData: ReadonlyMap<string, unknown>,
): ResolvedTextDocument {
  let keyframe: Readonly<AnimationTextDocumentKeyframe> | undefined;
  for (const candidate of component.documents ?? []) {
    if (candidate.time > time) break;
    keyframe = candidate;
  }
  const resolved: ResolvedTextDocument = {
    text: keyframe?.text ?? component.text,
    fontResource: inheritedCoreFontResource(keyframe??{},{fontFamily:component.fontFamily??'sans-serif',fontStyle:component.fontStyle??'normal',fontWeight:component.fontWeight??400,fontResource:component.fontResource}),
    fontFamily: keyframe?.fontFamily ?? component.fontFamily ?? 'sans-serif',
    fontSize: keyframe?.fontSize ?? component.fontSize ?? 28,
    fontWeight: keyframe?.fontWeight ?? component.fontWeight ?? 400,
    fontStyle: keyframe?.fontStyle ?? component.fontStyle ?? 'normal',
    lineHeight: keyframe?.lineHeight ?? component.lineHeight ?? (keyframe?.fontSize ?? component.fontSize ?? 28) * 1.2,
    tracking: keyframe?.tracking ?? component.tracking ?? 0,
    textAlign: keyframe?.textAlign ?? component.textAlign ?? 'center',
    color: keyframe?.color ?? component.color,
  };
  if (component.expression) {
    try {
      resolved.text = evaluateSafeExpression(component.expression, {
        time,
        text: resolved.text,
        data: expressionData,
      });
    } catch {
      // The authored/keyframed document is the deterministic permissive-mode fallback.
    }
  }
  return resolved;
}

function resolveGlyphState(
  animators: readonly Readonly<AnimationTextAnimator>[],
  selectorPlans: readonly SelectorIndexPlan[],
  time: number,
  index: number,
  baseColor: readonly [number, number, number, number],
): GlyphState {
  const state: GlyphState = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, tracking: 0, color: [...baseColor] };
  for (let animatorIndex = 0; animatorIndex < animators.length; animatorIndex++) {
    const animator = animators[animatorIndex]!;
    const plan = selectorPlans[animatorIndex]!;
    const weight = selectorWeight(animator, time, plan.indices[index] ?? 0, plan.count);
    if (Math.abs(weight) < 1e-6) continue;
    const position = sampled(animator.positionTrack, time, animator.position ?? [0, 0]);
    const scale = sampled(animator.scaleTrack, time, animator.scale ?? [1, 1]);
    const rotation = sampled(animator.rotationTrack, time, [animator.rotation ?? 0])[0] ?? 0;
    const opacity = sampled(animator.opacityTrack, time, [animator.opacity ?? 1])[0] ?? 1;
    const tracking = sampled(animator.trackingTrack, time, [animator.tracking ?? 0])[0] ?? 0;
    const color = sampled(animator.fillColorTrack, time, animator.fillColor ?? state.color);
    state.x += (position[0] ?? 0) * weight;
    state.y += (position[1] ?? 0) * weight;
    state.scaleX *= mix(1, scale[0] ?? 1, weight);
    state.scaleY *= mix(1, scale[1] ?? 1, weight);
    state.rotation += rotation * weight;
    state.opacity *= mix(1, opacity, weight);
    state.tracking += tracking * weight;
    for (let channel = 0; channel < 4; channel++) state.color[channel] = mix(state.color[channel]!, color[channel] ?? state.color[channel]!, weight);
  }
  state.opacity = clamp(state.opacity, 0, 1);
  return state;
}

function selectorWeight(animator: Readonly<AnimationTextAnimator>, time: number, index: number, count: number): number {
  const selector = animator.selector;
  const units = selector.units ?? 'percent';
  const coordinate = units === 'index' ? index + 0.5 : (index + 0.5) / Math.max(1, count);
  const start = sampled(selector.startTrack, time, [selector.start])[0] ?? selector.start;
  const end = sampled(selector.endTrack, time, [selector.end])[0] ?? selector.end;
  const offset = sampled(selector.offsetTrack, time, [selector.offset ?? 0])[0] ?? selector.offset ?? 0;
  const amount = sampled(selector.amountTrack, time, [selector.amount ?? 1])[0] ?? selector.amount ?? 1;
  const low = Math.min(start + offset, end + offset);
  const high = Math.max(start + offset, end + offset);
  const span = Math.max(1e-6, high - low);
  const progress = clamp((coordinate - low) / span, 0, 1);
  let weight = coordinate >= low && coordinate <= high ? 1 : 0;
  switch (selector.shape ?? 'square') {
    case 'ramp-up': weight = progress; break;
    case 'ramp-down': weight = 1 - progress; break;
    case 'triangle': weight = 1 - Math.abs(progress * 2 - 1); break;
    case 'round': weight = Math.sqrt(Math.max(0, 1 - (progress * 2 - 1) ** 2)); break;
    case 'smooth': weight = progress * progress * (3 - 2 * progress); break;
  }
  if (selector.easing) weight = cubicBezierYForX(weight, ...selector.easing);
  const smoothness = selector.smoothness ?? 1;
  if (smoothness < 1) {
    const width = Math.max(0.01, smoothness);
    const edge = 0.5 - width * 0.5;
    weight = clamp((weight - edge) / width, 0, 1);
  }
  return clamp(weight * amount, -1, 1);
}

function createSelectorIndexPlan(
  lines: readonly (readonly string[])[],
  animator: Readonly<AnimationTextAnimator>,
): SelectorIndexPlan {
  const basedOn = animator.selector.basedOn ?? 'characters';
  const indices: number[] = [];
  let group = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let glyphIndex = 0; glyphIndex < line.length; glyphIndex++) {
      const glyph = line[glyphIndex]!;
      indices.push(basedOn === 'lines' ? lineIndex : group);
      if (basedOn === 'characters') group++;
      else if (basedOn === 'characters-excluding-spaces' && glyph !== ' ') group++;
      else if (basedOn === 'words' && (glyph === ' ' || glyphIndex === line.length - 1)) group++;
    }
  }
  const count = Math.max(1, basedOn === 'lines' ? lines.length : group);
  const seed = animator.selector.randomSeed;
  if (seed === undefined || count < 2) return { indices, count };
  const permutation = Array.from({ length: count }, (_, index) => index);
  let randomState = seed >>> 0;
  for (let index = permutation.length - 1; index > 0; index--) {
    randomState = deterministicRandom(randomState);
    const swap = randomState % (index + 1);
    [permutation[index], permutation[swap]] = [permutation[swap]!, permutation[index]!];
  }
  return { indices: indices.map(index => permutation[index] ?? index), count };
}

function deterministicRandom(state: number): number {
  let value = state || 0x6d2b79f5;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function sampled(track: Readonly<AnimationVectorValueTrack> | undefined, time: number, fallback: readonly number[]): readonly number[] {
  if (!track || track.times.length === 0) return fallback;
  let frame = 0;
  while (frame + 1 < track.times.length && track.times[frame + 1]! <= time) frame++;
  const next = Math.min(frame + 1, track.times.length - 1);
  let progress = 0;
  if (next !== frame && track.interpolation !== 'step') {
    progress = clamp((time - track.times[frame]!) / Math.max(1e-8, track.times[next]! - track.times[frame]!), 0, 1);
    if (track.interpolation === 'cubic-bezier' && track.easings) {
      const offset = frame * 4;
      progress = cubicBezierYForX(progress, track.easings[offset]!, track.easings[offset + 1]!, track.easings[offset + 2]!, track.easings[offset + 3]!);
    }
  }
  const result = new Array<number>(track.valueSize);
  for (let index = 0; index < track.valueSize; index++) {
    const from = track.values[frame * track.valueSize + index] ?? 0;
    result[index] = mix(from, track.values[next * track.valueSize + index] ?? from, progress);
  }
  return result;
}

function splitGraphemes(text: string): string[] {
  const result: string[] = [];
  for (const codePoint of Array.from(text)) {
    if (codePoint === '\u200D' && result.length > 0) {
      result[result.length - 1] += codePoint;
    } else if (result.length > 0 && (/\p{Mark}/u.test(codePoint) || codePoint === '\uFE0F' || result[result.length - 1]!.endsWith('\u200D'))) {
      result[result.length - 1] += codePoint;
    } else result.push(codePoint);
  }
  return result;
}

function hasAnimatedAnimator(animator: Readonly<AnimationTextAnimator>): boolean {
  return animator.positionTrack !== undefined || animator.scaleTrack !== undefined || animator.rotationTrack !== undefined
    || animator.opacityTrack !== undefined || animator.fillColorTrack !== undefined || animator.trackingTrack !== undefined
    || animator.selector.startTrack !== undefined || animator.selector.endTrack !== undefined
    || animator.selector.offsetTrack !== undefined || animator.selector.amountTrack !== undefined;
}

function cubicBezierYForX(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let low = 0; let high = 1; let t = x;
  for (let iteration = 0; iteration < 10; iteration++) {
    const estimate = cubic(t, 0, x1, x2, 1);
    if (estimate < x) low = t; else high = t;
    t = (low + high) * 0.5;
  }
  return cubic(t, 0, y1, y2, 1);
}

function cubic(t: number, a: number, b: number, c: number, d: number): number {
  const inverse = 1 - t;
  return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d;
}

function cssColor(color: readonly number[]): string {
  return `rgba(${Math.round(clamp(color[0] ?? 0, 0, 1) * 255)},${Math.round(clamp(color[1] ?? 0, 0, 1) * 255)},${Math.round(clamp(color[2] ?? 0, 0, 1) * 255)},${clamp(color[3] ?? 1, 0, 1)})`;
}

function quoteFont(value: string): string { return `"${value.replace(/["\\]/g, '')}"`; }
function closeTextTexture(texture: TextTexture | null, canvas: HTMLCanvasElement | null): void {
  if (texture && texture !== canvas && typeof (texture as ImageBitmap).close === 'function') (texture as ImageBitmap).close();
}
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
