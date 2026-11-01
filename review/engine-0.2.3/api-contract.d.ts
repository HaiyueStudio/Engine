/** Frozen G01 target declarations, not currently shipped entrypoints.
 * Namespaces correspond to the module map in config/gameplay-023-contract.json.
 * Existing-type imports describe comparison/augmentation only; G11 emits real
 * declarations from their original owners, without experimental-path leakage.
 */
import type {HaiyueEngine} from '@haiyue/engine/core';
import type {Entity} from '@haiyue/engine/ecs';
import type {Scene, SceneAssetRequest} from '@haiyue/engine/scene';
import type {Physics2DSystem, Physics2DBody} from '@haiyue/engine/physics';
import type {Physics2DBodyHandle} from '@haiyue/engine/physics/backend';
import type {GuiElement, GuiElementOptions, GuiImageSource, GuiFocusManager} from '@haiyue/engine/gui';
import type {SampleableTextureSource} from '@haiyue/engine/material';
import type {AudioMixerPlayRequest as CurrentPlayRequest, OwnerSafeAudioMixerOptions as CurrentMixerOptions,
  AudioMixerStats as CurrentMixerStats} from '@haiyue/engine/experimental/audio';

export namespace GuiCore {
  export type GuiIconPosition = 'left' | 'right';
  // Existing GuiStyle gains optional iconPosition?: GuiIconPosition. No new GUI class.
}

export namespace Physics {
  export interface Physics2DShapeCastOptions {
    readonly shape: 'box' | 'circle'; readonly origin: readonly [number,number];
    readonly translation: readonly [number,number]; readonly angle?: number; readonly durationSeconds?:number;
    readonly width?: number; readonly height?: number; readonly radius?: number;
    readonly categoryBits?: number; readonly maskBits?: number;
    readonly exclude?: readonly Physics2DBody[]; readonly includeSensors?: boolean;
    readonly maxCandidates?: number;
  }
  export type Physics2DShapeCastHit = Readonly<{
    entity: Entity; body: Physics2DBody; fraction: number; distance: number;
  }> & (Readonly<{kind:'impact';point:readonly [number,number];normal:readonly [number,number]}>
    | Readonly<{kind:'overlap';fraction:0;distance:0;point:null;normal:null}>);
  export interface Physics2DFixedStepEvent {
    readonly phase:'before'|'after'; readonly tick:number; readonly deltaSeconds:number;
  }
  // Physics2DSystem: castShape(options): Physics2DShapeCastHit|null;
  // onFixedStep(listener:(event:Physics2DFixedStepEvent)=>void):()=>void;
  // readonly interpolationAlpha:number. Clock implementation remains private.
}

export namespace PhysicsBackend {
  export interface Physics2DShapeCastDesc {
    readonly shape:'box'|'circle'; readonly origin:Readonly<{x:number;y:number}>;
    readonly translation:Readonly<{x:number;y:number}>; readonly angle?:number;readonly durationSeconds?:number;
    readonly width?:number;readonly height?:number;readonly radius?:number;
    readonly categoryBits?:number;readonly maskBits?:number;readonly exclude?:readonly Physics2DBodyHandle[];
    readonly includeSensors?:boolean;readonly maxCandidates?:number;
  }
  export type Physics2DShapeCastResult = Readonly<{body:Physics2DBodyHandle;fraction:number;distance:number}>
    & (Readonly<{kind:'impact';point:Readonly<{x:number;y:number}>;normal:Readonly<{x:number;y:number}>}>
      | Readonly<{kind:'overlap';fraction:0;distance:0;point:null;normal:null}>);
  // Physics2DCapabilities.shapeCast?:boolean and Physics2DWorldDriver.castShape?:
  // (desc:Physics2DShapeCastDesc)=>Physics2DShapeCastResult|null are OPTIONAL additions.
}

export namespace Input {
  export interface GamepadAxisBinding {readonly axis:number;readonly direction?:'positive'|'negative'|'both';readonly deadZone?:number;readonly scale?:number;}
  export interface KeyboardAxisBinding {readonly negative:readonly string[];readonly positive:readonly string[];readonly scale?:number;}
  export interface InputActionBinding {
    readonly keys?:readonly string[];readonly pointerButtons?:readonly number[];
    readonly gamepadButtons?:readonly number[];readonly gamepadAxes?:readonly GamepadAxisBinding[];
    readonly keyboardAxes?:readonly KeyboardAxisBinding[];
  }
  export type InputActionMapDescriptor=Readonly<Record<string,InputActionBinding>>;
  export interface StandardGamepadSnapshot {readonly connected:boolean;readonly buttons:readonly Readonly<{pressed:boolean;value:number}>[];readonly axes:readonly number[];}
  export interface InputActionValue {readonly action:string;readonly value:number;}
  export class InputActionMap {
    constructor(bindings?:InputActionMapDescriptor);
    static guiNavigation():InputActionMap;static standardGameplay():InputActionMap;
    setBindings(bindings:InputActionMapDescriptor):this;setAction(action:string,binding:InputActionBinding):this;
    removeAction(action:string):this;hasAction(action:string):boolean;
    actionsForKey(code:string):readonly string[];actionsForPointerButton(button:number):readonly string[];
    actionNames():readonly string[];sampleKeyboard(codes:Iterable<string>):readonly InputActionValue[];
    sampleGamepad(gamepad:StandardGamepadSnapshot|null):readonly InputActionValue[];toJSON():InputActionMapDescriptor;
  }
  // Promote only this existing owner/subset to /input. Existing InputMap and
  // experimental/simulation exports retain their names and object identity.
}

export namespace AudioCore {
  export type AudioMixerBus='music'|'sfx'|'ui';
  export interface AudioMixerPlayRequest extends CurrentPlayRequest {}
  export interface OwnerSafeAudioMixerOptions extends CurrentMixerOptions {}
  export interface AudioMixerStats extends CurrentMixerStats {}
  export interface AudioMixerVolumes {readonly master:number;readonly music:number;readonly sfx:number;readonly ui:number;}
  export interface AudioMixerCapabilities {readonly stereoPan:boolean|null;readonly maxDecodedChannels:2;}
  export class OwnerSafeAudioMixer {
    constructor(options?:OwnerSafeAudioMixerOptions);
    readonly maxVoicesTotal:number;readonly maxVoicesPerOwner:number;
    unlock():Promise<void>;suspend():Promise<void>;resume():Promise<void>;
    installBuffer(id:string,buffer:AudioBuffer):void;decodeAndInstall(id:string,bytes:ArrayBuffer):Promise<AudioBuffer>;
    play(request:AudioMixerPlayRequest):string|null;stop(owner:string,channel?:string):number;
    stopVoice(id:string):boolean;releaseOwner(owner:string):number;setPan(owner:string,channel:string,value:number):boolean;
    setMasterVolume(value:number):void;setBusVolume(bus:AudioMixerBus,value:number):void;
    removeBuffer(id:string):boolean;dispose():void;
    // New compatible methods; existing experimental entry keeps the same class.
    getVolumes():AudioMixerVolumes;getCapabilities():AudioMixerCapabilities;
    setGain(owner:string,channel:string,value:number):boolean;
    get stats():AudioMixerStats;
  }
}

export namespace SceneFlow {
  export interface SceneFlowProgress {
    readonly generation:number;readonly id:string|null;readonly activeId:string|null;
    readonly phase:'idle'|'preparing'|'ready'|'committing'|'active'|'cancelled'|'failed'|'disposed';
    readonly completed:number;readonly total:number;
  }
  export interface SceneFlowRequest {
    readonly id:string;readonly create:(signal:AbortSignal)=>Scene|Promise<Scene>;
    readonly assets?:readonly SceneAssetRequest[];readonly signal?:AbortSignal;
  }
  export interface SceneFlowOptions {
    readonly engine:Pick<HaiyueEngine,'activeScene'|'switchScene'>;readonly concurrency?:number;
    readonly maxRequests?:number;readonly previous?:'destroy-owned'|'retain';
    readonly onProgress?:(progress:SceneFlowProgress)=>void;
  }
  export interface PreparedScene {
    readonly id:string;readonly generation:number;readonly scene:Scene;
    commit():Scene;dispose():void;
  }
  export interface SceneFlow {
    prepare(request:SceneFlowRequest):Promise<PreparedScene>;transition(request:SceneFlowRequest):Promise<Scene>;
    cancel():void;readonly progress:SceneFlowProgress;dispose():void;
  }
  export function createSceneFlow(options:SceneFlowOptions):SceneFlow;
}

export namespace Character2D {
  export interface Character2DOptions {
    readonly physics:Physics2DSystem;readonly entity:Entity;readonly up?:readonly [number,number];
    readonly maxSlides?:number;readonly maxSlopeAngle?:number;readonly floorSnap?:number;
    readonly safeMargin?:number;readonly carryPlatformVelocity?:boolean;
  }
  export interface Character2DState {
    readonly tick:number;readonly position:readonly [number,number];readonly previousPosition:readonly [number,number];
    readonly velocity:readonly [number,number];readonly grounded:boolean;readonly onWall:boolean;
    readonly floorNormal:readonly [number,number]|null;readonly platformEntityId:number|null;readonly stuck:boolean;
  }
  export interface Character2DController {
    setVelocity(velocity:readonly [number,number]):void;teleport(position:readonly [number,number]):void;
    readonly state:Character2DState;dispose():void;
  }
  export function createCharacter2D(options:Character2DOptions):Character2DController;
}

export namespace Camera2D {
  export interface Camera2DControllerOptions {
    readonly camera:Entity;readonly target:()=>readonly [number,number];readonly damping?:number;
    readonly deadZone?:Readonly<{width:number;height:number}>;
    readonly bounds?:Readonly<{x:number;y:number;width:number;height:number}>;
    readonly interpolation?:()=>Readonly<{previous:readonly [number,number];current:readonly [number,number];alpha:number}>;
  }
  export interface Camera2DControllerState {readonly position:readonly [number,number];readonly offset:readonly [number,number];}
  export interface Camera2DController {
    update(deltaMs:number):void;reset():void;
    shake(options:Readonly<{amplitude:number;durationMs:number;seed?:number}>):void;
    readonly state:Camera2DControllerState;dispose():void;
  }
  export function createCamera2DController(options:Camera2DControllerOptions):Camera2DController;
}

export namespace InputProfiles {
  export type InputBindingSample=Readonly<{device:'keyboard';code:string;down:boolean}>
    | Readonly<{device:'pointer';button:number;down:boolean}>
    | Readonly<{device:'gamepad';index:number;snapshot:Input.StandardGamepadSnapshot}>;
  export interface InputBindingConflict {readonly action:string;readonly otherActions:readonly string[];readonly sample:InputBindingSample;}
  export interface InputBindingProfileData {readonly format:'haiyue-input-profile';readonly version:1;readonly bindings:Input.InputActionMapDescriptor;}
  export interface InputBindingProfileOptions {
    readonly map:Input.InputActionMap;readonly captureAxisThreshold?:number;
    readonly conflict?:'reject'|'share'|'replace';readonly maxActions?:number;
    readonly onConflict?:(conflict:InputBindingConflict)=>void;readonly onChange?:(data:InputBindingProfileData)=>void;
  }
  export interface InputBindingProfile {
    beginRebind(action:string,kind:'button'|'negative'|'positive'):void;
    offer(sample:InputBindingSample):boolean;cancelRebind():void;
    exportData():InputBindingProfileData;restore(data:InputBindingProfileData):void;dispose():void;
  }
  export function createInputBindingProfile(options:InputBindingProfileOptions):InputBindingProfile;
}

export namespace GuiCollections {
  export interface GuiCollectionRow<T> {readonly element:GuiElement;bind(item:T,key:string,index:number):()=>void;dispose():void;}
  export interface GuiCollectionStats {readonly logicalItems:number;readonly first:number;readonly last:number;readonly rowInstances:number;readonly boundRows:number;}
  export interface GuiVirtualListOptions<T> {
    readonly items:readonly T[];readonly keyOf:(item:T)=>string;readonly rowHeight:number;readonly height:number;
    readonly createRow:()=>GuiCollectionRow<T>;readonly overscan?:number;readonly maxItems?:number;
    readonly focus?:GuiFocusManager;readonly onSelection?:(key:string|null)=>void;readonly style?:GuiElementOptions['style'];
  }
  export interface GuiVirtualTreeNode<T> {readonly key:string;readonly value:T;readonly disabled?:boolean;readonly children?:readonly GuiVirtualTreeNode<T>[];}
  export interface GuiVirtualTreeOptions<T> {
    readonly nodes:readonly GuiVirtualTreeNode<T>[];readonly rowHeight:number;readonly height:number;
    readonly createRow:()=>GuiCollectionRow<GuiVirtualTreeNode<T>>;readonly expandedKeys?:readonly string[];
    readonly overscan?:number;readonly maxItems?:number;readonly focus?:GuiFocusManager;
    readonly onSelection?:(key:string|null)=>void;readonly style?:GuiElementOptions['style'];
  }
  export interface GuiVirtualList<T> {
    readonly element:GuiElement;setItems(items:readonly T[]):void;setScrollOffset(offset:number):void;
    scrollToKey(key:string,align?:'nearest'|'start'|'center'|'end'):void;setSelection(key:string|null):void;
    readonly selectedKey:string|null;readonly stats:GuiCollectionStats;dispose():void;
  }
  export interface GuiVirtualTree<T> {
    readonly element:GuiElement;setNodes(nodes:readonly GuiVirtualTreeNode<T>[]):void;
    setExpandedKeys(keys:readonly string[]):void;getExpandedKeys():readonly string[];setScrollOffset(offset:number):void;
    scrollToKey(key:string,align?:'nearest'|'start'|'center'|'end'):void;setSelection(key:string|null):void;
    readonly selectedKey:string|null;readonly stats:GuiCollectionStats;dispose():void;
  }
  export function createGuiVirtualList<T>(options:GuiVirtualListOptions<T>):GuiVirtualList<T>;
  export function createGuiVirtualTree<T>(options:GuiVirtualTreeOptions<T>):GuiVirtualTree<T>;
}

export namespace Tilemap {
  export interface TilemapAtlasOptions {
    readonly source:SampleableTextureSource;readonly sourceWidth:number;readonly sourceHeight:number;
    readonly tileWidth:number;readonly tileHeight:number;readonly margin?:number;readonly spacing?:number;
  }
  export type TilemapCellTransform='none'|'flip-x'|'flip-y'|'rotate-90'|'rotate-180'|'rotate-270';
  // Existing Tilemap2DComponentOptions: atlas?:TilemapAtlasOptions|null;chunkSize?:number;
  // maxResidentChunks?:number. Existing component gains setAtlas, set/getCellTransform.
}

export namespace GameAudio {
  export interface GameAudioProfile {readonly format:'haiyue-game-audio';readonly version:1;readonly volumes:AudioCore.AudioMixerVolumes;readonly muted:boolean;}
  export interface GameAudioOptions {readonly mixer:AudioCore.OwnerSafeAudioMixer;readonly listener?:()=>readonly [number,number];readonly profile?:GameAudioProfile;}
  export interface GameAudioEmitterOptions {readonly owner:string;readonly channel:string;readonly position:()=>readonly [number,number];readonly maxDistance:number;readonly attenuation?:number;readonly volume?:number;readonly panStrength?:number;}
  export interface GameAudio {
    play(request:AudioCore.AudioMixerPlayRequest):string|null;setListener(listener:()=>readonly [number,number]):void;
    bindEmitter2D(options:GameAudioEmitterOptions):()=>void;update(deltaMs:number):void;
    setVolumes(volumes:Partial<AudioCore.AudioMixerVolumes>):void;setMuted(muted:boolean):void;
    fadeBus(bus:AudioCore.AudioMixerBus,target:number,durationMs:number):void;
    exportProfile():GameAudioProfile;restoreProfile(profile:GameAudioProfile):void;
    suspend():Promise<void>;resume():Promise<void>;dispose():void;
  }
  export function createGameAudio(options:GameAudioOptions):GameAudio;
}

export namespace GuiLayout {
  export interface GuiTabHeaderOptions {readonly title?:string;readonly icon?:GuiImageSource;readonly iconPosition?:GuiCore.GuiIconPosition;readonly iconSize?:number;readonly iconGap?:number;}
  export interface GuiTabPage {readonly icon?:GuiImageSource;readonly iconPosition?:GuiCore.GuiIconPosition;readonly iconSize?:number;readonly iconGap?:number;}
  export interface GuiTabContainer {setPageHeader(id:string,options:GuiTabHeaderOptions):void;}
  // The latter two are augmentations of existing exported types/classes, not replacements.
}

export namespace GuiControls {
  export interface GuiBreadcrumbMenuItem {readonly key:string;readonly label:string;readonly disabled?:boolean;readonly icon?:GuiImageSource;}
  export interface GuiBreadcrumbItem {readonly key:string;readonly label:string;readonly icon?:GuiImageSource;readonly iconPosition?:GuiCore.GuiIconPosition;readonly disabled?:boolean;readonly separator?:string;readonly menu?:readonly GuiBreadcrumbMenuItem[];}
  export interface GuiBreadcrumbOptions {readonly items:readonly GuiBreadcrumbItem[];readonly currentKey?:string|null;readonly separator?:string;readonly focus?:GuiFocusManager;readonly onNavigate?:(key:string)=>void;readonly style?:GuiElementOptions['style'];}
  export class GuiBreadcrumb {
    constructor(options:GuiBreadcrumbOptions);readonly element:GuiElement;
    setItems(items:readonly GuiBreadcrumbItem[]):void;setCurrent(key:string|null):void;readonly currentKey:string|null;dispose():void;
  }
  export type GuiBadgeValue=number|string;
  export type GuiBadgeStatus='default'|'processing'|'success'|'warning'|'error';
  export type GuiBadgePlacement='top-left'|'top-right'|'bottom-left'|'bottom-right';
  export interface GuiBadgeOptions {
    readonly content?:GuiElement;readonly value?:GuiBadgeValue;readonly variant?:'count'|'dot'|'status';
    readonly status?:GuiBadgeStatus;readonly statusText?:string;readonly overflowCount?:number;readonly showZero?:boolean;
    readonly placement?:GuiBadgePlacement;readonly offset?:readonly [number,number];readonly style?:GuiElementOptions['style'];
  }
  export class GuiBadge {
    constructor(options?:GuiBadgeOptions);readonly element:GuiElement;
    setValue(value:GuiBadgeValue):void;setOptions(options:Omit<GuiBadgeOptions,'content'>):void;dispose():void;
  }
  export interface GuiCollapseItem {readonly key:string;readonly title:string;readonly content:GuiElement;readonly icon?:GuiImageSource;readonly iconPosition?:GuiCore.GuiIconPosition;readonly disabled?:boolean;readonly extra?:GuiElement;}
  export interface GuiCollapseOptions {
    readonly items:readonly GuiCollapseItem[];readonly expandedKeys?:readonly string[];readonly accordion?:boolean;
    readonly toggleArea?:'header'|'icon';readonly expandIconPosition?:GuiCore.GuiIconPosition;
    readonly focus?:GuiFocusManager;readonly onExpandChange?:(keys:readonly string[])=>void;readonly style?:GuiElementOptions['style'];
  }
  export class GuiCollapse {
    constructor(options:GuiCollapseOptions);readonly element:GuiElement;
    setItems(items:readonly GuiCollapseItem[]):void;setExpandedKeys(keys:readonly string[],notify?:boolean):void;
    getExpandedKeys():readonly string[];toggle(key:string,notify?:boolean):void;dispose():void;
  }
}

/** Signatures added to original owners. These are not new public symbols. */
export namespace ExistingTypeAugmentations {
  export interface GuiStyle {readonly iconPosition?:GuiCore.GuiIconPosition;}
  export interface Physics2DSystem {
    castShape(options:Physics.Physics2DShapeCastOptions):Physics.Physics2DShapeCastHit|null;
    onFixedStep(listener:(event:Physics.Physics2DFixedStepEvent)=>void):()=>void;
    readonly interpolationAlpha:number;
  }
  export interface Physics2DCapabilities {readonly shapeCast?:boolean;}
  export interface Physics2DWorldDriver {castShape?:(desc:PhysicsBackend.Physics2DShapeCastDesc)=>PhysicsBackend.Physics2DShapeCastResult|null;}
  export interface Tilemap2DComponentOptions {readonly atlas?:Tilemap.TilemapAtlasOptions|null;readonly chunkSize?:number;readonly maxResidentChunks?:number;}
  export interface Tilemap2DComponent {
    setAtlas(atlas:Tilemap.TilemapAtlasOptions|null):void;
    setCellTransform(column:number,row:number,transform:Tilemap.TilemapCellTransform):void;
    getCellTransform(column:number,row:number):Tilemap.TilemapCellTransform;
  }
}
