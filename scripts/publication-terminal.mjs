import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,statSync,rmSync,realpathSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {npmArgs,npmCommand} from './npm-process.mjs';
import {storedPublicationLog} from './publication-policy.mjs';

export function assertPublicationTerminal(streams=process) {
  if (![streams.stdin,streams.stdout,streams.stderr].every(stream=>stream?.isTTY===true))
    throw Error('G02_TERMINAL_REQUIRED: Open the independent terminal from File Explorer (or a Linux terminal). npm passkey authorization requires real stdin/stdout/stderr TTYs. No submission started.');
}

/** npm owns the real console. Only sanitized npm diagnostics and process metadata persist. */
export async function runTerminalNpm(args,{cwd,logPath,environment=process.env,streams=process,spawnImpl=spawn}={}) {
  assertPublicationTerminal(streams);
  if (!cwd || !logPath || args.some(arg=>/--(?:otp|token|password|_auth)/i.test(arg))) throw Error('Invalid credential-free terminal invocation.');
  mkdirSync(dirname(logPath),{recursive:true});
  const scratch=mkdtempSync(resolve(dirname(logPath),'.npm-attempt-'));
  const parent=realpathSync(dirname(logPath));
  const start=new Date().toISOString();
  let outcome,diagnostic='',npmErrorCode=null;
  try {
    outcome=await new Promise(resolveExit=>{
      const child=spawnImpl(npmCommand(),npmArgs(args,environment),{cwd,windowsHide:false,stdio:'inherit',
        env:{...environment,npm_config_logs_dir:scratch,npm_config_logs_max:'1'}});
      child.once('error',error=>resolveExit({code:null,signal:null,error:storedPublicationLog(error.message)}));
      child.once('close',(code,signal)=>resolveExit({code,signal}));
    });
    for(const file of readdirSync(scratch)){
      const path=resolve(scratch,file);
      if(!statSync(path).isFile())continue;
      if(statSync(path).size>4*1024*1024){diagnostic+='[npm diagnostic exceeded 4 MiB; content omitted]\n';continue;}
      const content=readFileSync(path,'utf8');
      const code=/\b(?:error\s+code|code)\s+(EOTP|E401|ENEEDAUTH)\b/.exec(content)?.[1];
      if(code)npmErrorCode=code;
      diagnostic+=(storedPublicationLog(content)+'\n').slice(-65536);
    }
  } finally {
    // Only this invocation's generated scratch may be recursively removed.
    const target=realpathSync(scratch),inside=relative(parent,target);
    if(!inside||inside.startsWith('..')||isAbsolute(inside)||!inside.startsWith('.npm-attempt-'))throw Error('Unsafe npm scratch cleanup');
    rmSync(target,{recursive:true,force:true});
  }
  const metadata={schemaVersion:1,startedAt:start,finishedAt:new Date().toISOString(),...outcome,npmErrorCode,
    tty:{stdin:true,stdout:true,stderr:true},consoleOutputRecorded:false};
  writeFileSync(logPath,JSON.stringify(metadata)+'\n'+diagnostic,{flag:'wx'});
  return outcome.code===0 ? {status:'accepted',detail:'npm exited 0; '+logPath}
    : {status:npmErrorCode?'rejected':'indeterminate',...(npmErrorCode?{reason:'authentication'}:{}),detail:`npm exited ${outcome.code}; ${npmErrorCode??'acknowledgement unknown'}; ${logPath}`};
}
