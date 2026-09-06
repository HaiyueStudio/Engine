/** Independent benchmark counts: command encoding and GPU execution are distinct. */
export function instrumentAuditBundleCreation(device, audit) {
  if (!device.createRenderBundleEncoder) return;
  const createBundle = device.createRenderBundleEncoder.bind(device);
  device.createRenderBundleEncoder = function(descriptor) {
    const encoder = createBundle(descriptor);
    let draws = 0;
    audit.bundleBuilds++;
    for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
      const draw = encoder[name].bind(encoder);
      encoder[name] = (...args) => { draws++; audit.bundleEncodedDraws++; return draw(...args); };
    }
    const finish = encoder.finish.bind(encoder);
    encoder.finish = (...args) => {
      const bundle = finish(...args);
      audit.bundleDraws.set(bundle, draws);
      return bundle;
    };
    return encoder;
  };
}

export function instrumentAuditBundleExecution(pass, audit, phase) {
  const execute = pass.executeBundles?.bind(pass);
  if (!execute) return;
  try {
    pass.executeBundles = bundles => {
      const list = Array.isArray(bundles) ? bundles : Array.from(bundles);
      for (const bundle of list) {
        const draws = audit.bundleDraws.get(bundle) ?? 0;
        audit.draws += draws;
        audit.renderByPhase[phase].draws += draws;
        audit.bundleExecutions++;
      }
      return execute(list);
    };
  } catch { audit.renderPassInstrumentationFailures++; }
}

export function instrumentAuditRenderPass(pass, audit, phase) {
  for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const method = pass?.[name];
    if (typeof method !== 'function') continue;
    const bound = method.bind(pass);
    try {
      Object.defineProperty(pass, name, { configurable: true, value(...args) {
        audit.draws++;
        audit.directEncodedDraws++;
        audit.renderByPhase[phase].draws++;
        return bound(...args);
      } });
    } catch { audit.renderPassInstrumentationFailures++; }
  }
  instrumentAuditBundleExecution(pass, audit, phase);
  return pass;
}
