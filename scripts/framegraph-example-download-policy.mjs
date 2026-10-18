import { isAbsolute } from 'node:path';

/** The fixture page owns a non-default context; default-context policy cannot authorize its downloads. */
export async function configureFrameGraphDownloads(cdp, downloadDirectory) {
  if (typeof downloadDirectory !== 'string' || !downloadDirectory || !isAbsolute(downloadDirectory)) {
    throw Error('FrameGraph downloads require an explicit absolute output directory');
  }
  const target = (await cdp.call('Target.getTargetInfo')).result?.targetInfo;
  if (target?.type !== 'page' || typeof target.targetId !== 'string' || !target.targetId ||
      typeof target.browserContextId !== 'string' || !target.browserContextId) {
    throw Error('FrameGraph downloads require the current page and its isolated browser context');
  }
  await cdp.call('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDirectory, browserContextId: target.browserContextId,
  });
  return { targetId: target.targetId, browserContextId: target.browserContextId };
}
