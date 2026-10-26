import {createHash} from 'node:crypto';

const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const names = ['@haiyue/engine', '@haiyue/animation-spec', '@haiyue/extensions', '@haiyue/shader-language'];

export function validatePublicationPlan(plan) {
  if (plan?.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(plan.version ?? '')
    || !/^[a-f0-9]{40}$/.test(plan.revision ?? '') || plan.dirty !== false
    || plan.packages?.length !== 4) throw Error('Publication requires a frozen clean four-package candidate.');
  for (const name of names) {
    const entries = plan.packages.filter(p => p.name === name);
    if (entries.length !== 1) throw Error('Publication plan must contain each public package exactly once.');
    const p = entries[0];
    if (p.version !== plan.version || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '')
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
    .replace(/npm_[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/((?:authorization|_authToken|password|otp)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

/** Persist intent BEFORE submit. A lost acknowledgement is never proof of rejection. */
export async function runPublication(plan, journal, io, {allowSubmit = false, maxWaitMs = 300000, pollMs = 5000} = {}) {
  const id = publicationPlanId(plan);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw Error('Invalid bounded registry wait.');
  if (journal && (journal.schemaVersion !== 1 || journal.planId !== id)) throw Error('Journal belongs to another frozen candidate.');
  const state = journal ? structuredClone(journal) : {schemaVersion: 1, planId: id, packages: {}};
  const persist = async (entry, status, detail) => {
    state.packages[entry.name] = {...state.packages[entry.name], status, ...(detail ? {detail: redactPublicationLog(detail)} : {})};
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
        verifyPublicationBytes(entry, await io.download(entry, remote));
        state.packages[entry.name] = {...state.packages[entry.name], attempted: true};
        await persist(entry, 'verified'); break;
      }
      if (remote.status === 'processing') {
        // Processing observed even without a local journal means somebody already submitted it.
        attempted = true;
        state.packages[entry.name] = {...state.packages[entry.name], attempted: true};
        await persist(entry, 'processing');
      } else if (!attempted) {
        if (!allowSubmit) { await persist(entry, 'not-published'); break; }
        state.packages[entry.name] = {attempted: true}; attempted = true;
        await persist(entry, 'submitting');
        let submission;
        try { submission = await io.submit(entry); }
        catch (error) { await persist(entry, 'indeterminate', error.message); throw error; }
        if (submission?.status === 'rejected') {
          await persist(entry, 'rejected', submission.detail);
          throw Error('Publication rejected; no automatic retry: '+entry.name);
        }
        if (submission?.status !== 'accepted') {
          await persist(entry, 'indeterminate', submission?.detail);
          throw Error('Submission acknowledgement missing; resume registry verification, do not resubmit: '+entry.name);
        }
        await persist(entry, 'accepted');
      } else await persist(entry, 'awaiting-visibility');
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
