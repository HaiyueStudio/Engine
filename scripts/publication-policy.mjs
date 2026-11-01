import {createHash} from 'node:crypto';

const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const names = ['@haiyue/engine', '@haiyue/animation-spec', '@haiyue/extensions', '@haiyue/shader-language'];

export function validatePublicationPlan(plan) {
  const legacy = plan?.schemaVersion === 1;
  if (![1, 2].includes(plan?.schemaVersion) || !/^\d+\.\d+\.\d+$/.test(plan.version ?? '')
    || !/^[a-f0-9]{40}$/.test(plan.revision ?? '') || plan.dirty !== false
    || !Array.isArray(plan.packages) || (legacy ? plan.packages.length !== 4 : plan.packages.length < 1 || plan.packages.length > 4))
    throw Error('Publication requires a frozen clean candidate with exact package identities.');
  if (plan.packages.some(p => !names.includes(p.name))) throw Error('Unknown public package.');
  for (const name of legacy ? names : plan.packages.map(p => p.name)) {
    const entries = plan.packages.filter(p => p.name === name);
    if (entries.length !== 1) throw Error('Publication plan must contain each public package exactly once.');
    const p = entries[0];
    if ((legacy ? p.version !== plan.version : !/^\d+\.\d+\.\d+$/.test(p.version ?? '')) || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '')
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity ?? '') || !p.file) throw Error('Invalid frozen package identity: '+name);
  }
}

export function publicationPlanId(plan) {
  validatePublicationPlan(plan);
  return digest(JSON.stringify(plan), 'sha256');
}

export function verifyPublicationBytes(entry, bytes) {
  if (digest(bytes, 'sha256') !== entry.sha256 || 'sha512-'+digest(bytes, 'sha512') !== entry.integrity)
    throw Error('Package bytes conflict with frozen candidate: '+entry.name);
}

export function redactPublicationLog(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x00/g, '')
    .replace(/npm_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/((?:authorization|cookie|set-cookie)[ \t]*[:=][ \t]*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/((?:authorization|_authToken|password|otp)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

export function storedPublicationLog(text) {
  return redactPublicationLog(text).replace(/https:\/\/www\.npmjs\.com\/auth\/cli\/[^\s]+/g, '[live authorization URL omitted]');
}

/** Persist intent BEFORE submit. A lost acknowledgement is never proof of rejection. */
export async function runPublication(plan, journal, io, {allowSubmit = false, retryAuth = [], maxWaitMs = 300000, pollMs = 5000} = {}) {
  const id = publicationPlanId(plan);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw Error('Invalid bounded registry wait.');
  if (!Array.isArray(retryAuth) || new Set(retryAuth).size !== retryAuth.length || retryAuth.some(name=>!plan.packages.some(p=>p.name===name))
    || retryAuth.length && !allowSubmit) throw Error('Authentication retry requires explicit named publication authorization.');
  if (journal && (journal.schemaVersion !== 1 || journal.planId !== id)) throw Error('Journal belongs to another frozen candidate.');
  const state = journal ? structuredClone(journal) : {schemaVersion: 1, planId: id, packages: {}};
  const persist = async (entry, status, detail) => {
    state.packages[entry.name] = {...state.packages[entry.name], status, updatedAt:new Date(io.now()).toISOString(), ...(detail ? {detail: redactPublicationLog(detail)} : {})};
    await io.save(structuredClone(state));
  };
  for (const entry of plan.packages) {
    verifyPublicationBytes(entry, await io.localBytes(entry));
    let attempted = Boolean(state.packages[entry.name]?.attempted);
    const started = io.now();
    for (;;) {
      const remote = await io.observe(entry); // Exceptions stop; registry errors never become "absent".
      if (!['absent', 'processing', 'visible'].includes(remote?.status)) throw Error('Invalid registry state: '+entry.name);
      if (remote.status === 'visible') {
        if (remote.integrity !== entry.integrity) throw Error('Published version has conflicting integrity: '+entry.name);
        // Seeing metadata already proves this immutable version has been submitted.
        attempted=true;state.packages[entry.name]={...state.packages[entry.name],attempted:true,rejectionKind:undefined};
        await persist(entry,'visible-awaiting-download');
        let downloaded;
        try {downloaded=await io.download(entry,remote);}catch(error){await persist(entry,'download-unavailable',error.message);throw error;}
        if(downloaded?.status==='unavailable') {
          await persist(entry,'download-unavailable',downloaded.detail);
          if(io.now()-started>=maxWaitMs)return {status:'pending',journal:state,package:entry.name};
          await io.wait(Math.min(pollMs,maxWaitMs-(io.now()-started)));continue;
        }
        verifyPublicationBytes(entry,downloaded);
        await persist(entry, 'verified'); break;
      }
      if (remote.status === 'processing') {
        // Processing observed even without a local journal means somebody already submitted it.
        attempted = true;
        state.packages[entry.name] = {...state.packages[entry.name], attempted: true, rejectionKind: undefined};
        await persist(entry, 'processing');
      } else {
        const previous=state.packages[entry.name];
        if(attempted&&retryAuth.includes(entry.name)){
          if(previous.rejectionKind!=='authentication')throw Error('Only a definite authentication rejection can be explicitly retried: '+entry.name);
          if((previous.attemptHistory?.length??0)>=16)throw Error('Authentication retry history limit reached.');
          state.packages[entry.name]={...previous,attempted:false,attemptHistory:[...(previous.attemptHistory??[]),{status:previous.status,detail:previous.detail,updatedAt:previous.updatedAt}],rejectionKind:undefined};
          attempted=false;await persist(entry,'reauthorized');
          retryAuth=retryAuth.filter(name=>name!==entry.name);
        }
        if (!attempted) {
        if (!allowSubmit) { await persist(entry, 'not-published'); break; }
        // A missing console/npm prerequisite is a proven non-start, not a lost publish acknowledgement.
        try {await io.prepareSubmit?.(entry);}catch(error){
          state.packages[entry.name]={...state.packages[entry.name],attempted:false};
          await persist(entry,'not-started',error.message);throw error;
        }
        state.packages[entry.name] = {...state.packages[entry.name],attempted: true}; attempted = true;
        await persist(entry, 'submitting');
        let submission;
        try { submission = await io.submit(entry); }
        catch (error) { await persist(entry, 'indeterminate', error.message); throw error; }
        if (submission?.status === 'rejected') {
          if(submission.reason==='authentication')state.packages[entry.name].rejectionKind='authentication';
          await persist(entry, 'rejected', submission.detail);
          throw Error('Publication rejected; no automatic retry: '+entry.name);
        }
        if (submission?.status !== 'accepted') {
          await persist(entry, 'indeterminate', submission?.detail);
          throw Error('Submission acknowledgement missing; resume registry verification, do not resubmit: '+entry.name);
        }
        await persist(entry, 'accepted');
        } else await persist(entry, 'awaiting-visibility');
      }
      if (io.now()-started >= maxWaitMs) {
        await persist(entry, 'visibility-timeout');
        return {status: 'pending', journal: state, package: entry.name};
      }
      await io.wait(Math.min(pollMs, maxWaitMs-(io.now()-started)));
    }
  }
  const verified = plan.packages.every(entry => state.packages[entry.name]?.status === 'verified');
  return {status: verified ? 'verified' : 'not-published', journal: state,
    mayCreateGithubRelease: verified, mayDeployPages: false};
}

/** Pages advances only after all uploaded release assets were read back and verified. */
export function publicationNextStep(result, assets) {
  if (result.status !== 'verified') return 'wait-for-npm';
  if (!Array.isArray(assets) || assets.length === 0 || assets.some(a => a.expectedSha256 !== a.downloadedSha256
    || !/^[a-f0-9]{64}$/.test(a.expectedSha256 ?? ''))) return 'verify-github-assets';
  return 'deploy-pages-and-check-deployed-revision';
}
