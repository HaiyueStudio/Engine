/** One request per component; producers may ignore abort but cannot publish stale results. */
export class LatestRequest {
  private controller:AbortController|null=null;
  cancel():void {const previous=this.controller;this.controller=null;previous?.abort();}
  begin():AbortSignal {this.cancel();const controller=new AbortController();this.controller=controller;return controller.signal;}
  current(signal:AbortSignal):boolean {return !signal.aborted&&this.controller?.signal===signal;}
}
