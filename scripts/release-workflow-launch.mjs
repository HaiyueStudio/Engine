import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// WMI does not inherit the caller's environment. Pass runtime/search paths, never credentials.
export function workflowLaunchEnvironment(environment) {
  return Object.entries(environment).filter(([key,value])=>/^(path|home|userprofile|appdata|localappdata|temp|tmp|systemroot|windir|comspec|programfiles(?:\(x86\))?|programdata|npm_config_cache|npm_execpath)$/i.test(key)&&typeof value==='string').map(([key,value])=>`${key}=${value}`);
}
const windowsQuote=value=>'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\*)$/,'$1$1')+'"';
export function independentWorkflowArguments({root,node,runPath,nonce,retryStage,closeOnComplete=false},platform) {
  for(const path of [root,node,runPath])if(typeof path!=='string'||/[\x00\r\n]/.test(path))throw Error('Invalid independent launch path');
  if(!/^[a-f0-9]{24}$/.test(nonce??''))throw Error('Invalid launch nonce');
  if(retryStage&&!/^[a-z0-9-]+$/.test(retryStage))throw Error('Invalid named retry stage');
  return [resolve(root,'scripts/release-workflow.mjs'),'run','--run',runPath,'--no-publish',...(retryStage?['--retry-stage',retryStage]:[]),...(platform==='win32'&&!closeOnComplete?['--keep-terminal']:[])];
}
export function windowsLaunchCommand(options) {
  return [options.node,...independentWorkflowArguments(options,'win32')].map(windowsQuote).join(' ');
}

/** WMI owns the Windows process; a separate process group owns POSIX children. No app is killed. */
export async function launchIndependentWorkflow(options,{platform=process.platform,environment=process.env}={}) {
  const args=independentWorkflowArguments(options,platform);
  if(platform==='win32'){
    const shell=resolve(environment.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    // NEW_CONSOLE | UNICODE_ENVIRONMENT | BREAKAWAY_FROM_JOB: provider-job independence.
    const broker="$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; $s=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{CreateFlags=[uint32]16778256;ShowWindow=[uint16]$env:G02_LAUNCH_SHOW;EnvironmentVariables=[string[]](ConvertFrom-Json $env:G02_LAUNCH_ENV)}; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:G02_LAUNCH_COMMAND;CurrentDirectory=$env:G02_LAUNCH_ROOT;ProcessStartupInformation=$s}|ConvertTo-Json -Compress";
    const result=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-Command',broker],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...environment,G02_LAUNCH_COMMAND:windowsLaunchCommand(options),G02_LAUNCH_ROOT:options.root,G02_LAUNCH_SHOW:options.hidden?'0':'1',G02_LAUNCH_ENV:JSON.stringify(workflowLaunchEnvironment(environment))}}));
    if(result.ReturnValue!==0||!Number.isSafeInteger(result.ProcessId)||result.ProcessId<1)throw Error('Independent Windows process creation failed: '+result.ReturnValue);
    return {method:'Win32_Process.Create',pid:result.ProcessId};
  }
  const files=['stdout','stderr'].map(channel=>resolve(dirname(options.runPath),`launch.${options.nonce}.${channel}.log`));
  const fds=[];let child;
  try{
    for(const file of files)fds.push(openSync(file,'wx'));
    child=spawn(options.node,args,{cwd:options.root,detached:true,stdio:['ignore',...fds],env:environment});
    await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});
    child.unref();
  }finally{for(const fd of fds)closeSync(fd);}
  return {method:'detached-process-group',pid:child.pid,logs:files};
}

/** OS acceptance is insufficient: the actual controller must acknowledge this launch. */
export async function confirmIndependentStartup(path,pid,nonce,{timeoutMs=10000}={}) {
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const run=JSON.parse(readFileSync(path,'utf8'));
    if(run.launch?.nonce!==nonce)throw Error('Independent launch ownership changed');
    if(run.controller?.pid===pid)return run.controller;
    await delay(50);
  }
  throw Error('Independent controller did not acknowledge startup; inspect retained run state before retrying');
}
