import type {RenderFrameContext} from '../../core/RenderCommandContext';
import {getInstrumentedGPUResourceTracker} from '../../core/GPUResourceTracker';
import {getPrecompiledShaderPassRuntime} from '../../shader/PrecompiledShaderRuntime';
import {GUI_REGION_HISTORY_SHADER_ARTIFACT} from '../../shaders/generated/2d-ui-region-history-artifact.generated';
import type {RegionColorTarget} from './RegionColorTarget';

interface HistoryDeviceState {
  readonly layouts:GPUBindGroupLayout[];
  readonly shader:ReturnType<typeof getPrecompiledShaderPassRuntime>;
  readonly pipelines:Map<GPUTextureFormat,GPURenderPipeline>;
}
// The precompiled adapter caches renderer layout identities per device. Reuse
// one identity here as well: destroying/recreating views must not grow it.
const deviceStates=new WeakMap<GPUDevice,HistoryDeviceState>();
function getHistoryDeviceState(device:GPUDevice):HistoryDeviceState {
  let state=deviceStates.get(device);
  if(!state){
    const layouts=[0,1,2,3].map(group=>device.createBindGroupLayout({label:`RegionHistory.group${group}`,entries:group===3?[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float' as const,viewDimension:'2d' as const,multisampled:true}}]:[]}));
    state={layouts,shader:getPrecompiledShaderPassRuntime(device,GUI_REGION_HISTORY_SHADER_ARTIFACT,'gui-region-history',{rendererOwnedLayouts:layouts}),pipelines:new Map()};deviceStates.set(device,state);
  }
  return state;
}

/** Copies color history exactly, including individual coverage samples. No uniforms or color conversion. */
export class RegionHistoryCopy {
  constructor(private readonly device:GPUDevice) {}
  copy(source:RegionColorTarget,destination:RegionColorTarget,context:RenderFrameContext):void {
    if(source.device!==this.device||destination.device!==this.device||context.device!==this.device||
      source.width!==destination.width||source.height!==destination.height||source.format!==destination.format||source.spec.sampleCount!==destination.spec.sampleCount)
      throw Error('Region history requires matching device, size, format and sample count.');
    context.endPass();
    if(source.spec.sampleCount===1){
      context.encoder.copyTextureToTexture({texture:source.sample(context)},{texture:destination.copyDestination(context)},[source.width,source.height,1]);
    }else{
      const {shader,layouts,pipelines}=getHistoryDeviceState(this.device);
      let pipeline=pipelines.get(destination.format);
      if(!pipeline){pipeline=this.device.createRenderPipeline({label:'RegionHistory.perSample',layout:shader.pipelineLayout,vertex:{module:shader.module,entryPoint:'vs_main'},fragment:{module:shader.module,entryPoint:'fs_main',targets:[{format:destination.format}]},primitive:{topology:'triangle-list'},multisample:{count:4}});pipelines.set(destination.format,pipeline);}
      const binding=this.device.createBindGroup({label:'RegionHistory.source',layout:layouts[3]!,entries:[{binding:0,resource:source.historySamples(context)}]});
      const release=()=>{getInstrumentedGPUResourceTracker(this.device)?.untrackObject(binding);};
      context.afterSubmit!(()=>{void this.device.queue.onSubmittedWorkDone().then(release,release);});context.afterCancel!(release);
      const descriptor=destination.updateDescriptor(true);delete descriptor.depthStencilAttachment;
      const pass=context.encoder.beginRenderPass(descriptor);pass.setPipeline(pipeline);pass.setBindGroup(3,binding);pass.draw(3);pass.end();
    }
    destination.encoded(context);
  }
}
