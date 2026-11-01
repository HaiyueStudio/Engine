import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runTerminalNpm} from './publication-terminal.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output')throw Error('Usage: publication-tty-probe.mjs --output FILE');
const output=resolve(args[1]),report={schemaVersion:1,diagnostic:true,published:false,platform:process.platform,pid:process.pid,parentPid:process.ppid,
  tty:{stdin:process.stdin.isTTY===true,stdout:process.stdout.isTTY===true,stderr:process.stderr.isTTY===true}};
try{
  const result=await runTerminalNpm(['--version'],{cwd:resolve(import.meta.dirname,'..'),logPath:output+'.npm.log'});
  report.status=result.status==='accepted'?'passed':'failed';report.npmInvocation='--version (no registry or publication)';
  report.processMetadata=JSON.parse(readFileSync(output+'.npm.log','utf8').split('\n')[0]);
}catch(error){report.status='failed';report.error=error.message;}
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});if(report.status!=='passed')process.exitCode=1;
